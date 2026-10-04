import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { monaco } from "../monaco";
import { getEditor } from "../editorRef";
import {
  FileMatches,
  LineMatch,
  replaceInFiles,
  SearchDone,
  SearchRequest,
  searchCancel,
  searchStart,
} from "../ipc";
import { activate, activeTab, findTabByPath, getModel, getTab, openPaths, reloadFromDisk, useTabs } from "./tabs";
import { remember, useSettings } from "./settings";
import { ask, errorMessage, notify } from "./ui";
import { bookmarkLines } from "../bookmarks";
import { bigReveal } from "./bigview";
import { showPanelTab } from "./panel";
import { searchRoot } from "./workspace";

export type SearchScope = "folder" | "open" | "current";

export interface FileResult {
  path: string;
  /** Set for results that came from an open document. */
  tabId?: string;
  title: string;
  matches: LineMatch[];
}

interface Params {
  query: string;
  isRegex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  scope: SearchScope;
  folder: string;
  include: string;
  exclude: string;
}

interface SearchState extends Params {
  open: boolean;
  replace: string;
  showReplace: boolean;
  running: boolean;
  searchId: number | null;
  results: FileResult[];
  summary: string;
  error: string | null;
  /** Parameters that produced `results` (replace acts on these, not on edited inputs). */
  lastParams: Params | null;
  collapsed: Record<string, boolean>;
  selected: { file: number; match: number } | null;
  /** Bumped to ask the panel to focus + select its query input. */
  focusTick: number;
}

export const useSearch = create<SearchState>(() => ({
  open: false,
  query: "",
  replace: "",
  showReplace: false,
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  scope: "folder",
  folder: "",
  include: useSettings.getState().searchInclude,
  exclude: useSettings.getState().searchExclude,
  running: false,
  searchId: null,
  results: [],
  summary: "",
  error: null,
  lastParams: null,
  collapsed: {},
  selected: null,
  focusTick: 0,
}));

const MAX_DOC_MATCHES = 20_000;
const PREVIEW_LEAD = 40;
const PREVIEW_LEN = 240;
const WORD_SEPARATORS = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";

const params = (): Params => {
  const s = useSearch.getState();
  return {
    query: s.query,
    isRegex: s.isRegex,
    matchCase: s.matchCase,
    wholeWord: s.wholeWord,
    scope: s.scope,
    folder: s.folder,
    include: s.include,
    exclude: s.exclude,
  };
};

const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, "");

export function openSearch(opts: { scope?: SearchScope; replace?: boolean } = {}) {
  const editor = getEditor();
  const sel = editor?.getSelection();
  const selected = sel && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber ? editor!.getModel()?.getValueInRange(sel) : "";
  const s = useSearch.getState();
  const tabPath = activeTab()?.path;
  showPanelTab("search");
  useSearch.setState({
    open: true,
    scope: opts.scope ?? s.scope,
    showReplace: opts.replace ?? s.showReplace,
    query: selected || s.query,
    folder: s.folder || searchRoot() || (tabPath ? dirname(tabPath) : (useSettings.getState().folderHistory[0] ?? "")),
    focusTick: s.focusTick + 1,
  });
}

export function closeSearch() {
  useSearch.setState({ open: false });
  getEditor()?.focus();
}

// ---- Folder search: results stream in as events; buffer them and flush a few times a second.

let pending: FileResult[] = [];
let searchSeq = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  flushTimer = null;
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  useSearch.setState((s) => ({ results: [...s.results, ...batch] }));
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

void listen<FileMatches>("search-result", (e) => {
  if (e.payload.searchId !== useSearch.getState().searchId) return;
  pending.push({ path: e.payload.path, title: baseName(e.payload.path), matches: e.payload.matches });
  if (!flushTimer) flushTimer = setTimeout(flush, 100);
});

void listen<SearchDone>("search-done", (e) => {
  const d = e.payload;
  if (d.searchId !== useSearch.getState().searchId) return;
  flush();
  // Parallel walk returns files in arbitrary order; sort once at the end for a stable list.
  useSearch.setState((s) => ({
    running: false,
    results: [...s.results].sort((a, b) => a.path.localeCompare(b.path)),
    summary: summarize(d.matches, d.files, d.elapsedMs, {
      truncated: d.truncated,
      cancelled: d.cancelled,
      searched: d.searchedFiles,
    }),
  }));
});

void listen<[number, string]>("search-error", (e) => {
  if (e.payload[0] !== useSearch.getState().searchId) return;
  useSearch.setState({ running: false, error: e.payload[1] });
});

function summarize(
  matches: number,
  files: number,
  ms: number,
  extra: { truncated?: boolean; cancelled?: boolean; searched?: number } = {},
): string {
  const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
  let s = matches ? `${plural(matches, "result")} in ${plural(files, "file")}` : "No results";
  if (extra.searched !== undefined) s += ` (searched ${plural(extra.searched, "file")})`;
  s += ` · ${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}`;
  if (extra.truncated) s += " · stopped at limit";
  if (extra.cancelled) s += " · cancelled";
  return s;
}

// ---- Open documents: search Monaco models directly.

function docMatches(model: monaco.editor.ITextModel, p: Params, capture = false) {
  return model.findMatches(p.query, false, p.isRegex, p.matchCase, p.wholeWord ? WORD_SEPARATORS : null, capture, MAX_DOC_MATCHES);
}

function searchModel(model: monaco.editor.ITextModel, p: Params): LineMatch[] {
  const byLine = new Map<number, [number, number][]>();
  for (const m of docMatches(model, p)) {
    const line = m.range.startLineNumber;
    const end = m.range.endLineNumber === line ? m.range.endColumn : model.getLineMaxColumn(line);
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line)!.push([m.range.startColumn - 1, end - 1]);
  }
  return [...byLine].map(([line, ranges]) => {
    const text = model.getLineContent(line);
    const previewStart = Math.max(0, ranges[0][0] - PREVIEW_LEAD);
    return { line, text: text.slice(previewStart, previewStart + PREVIEW_LEN), previewStart, ranges };
  });
}

function searchDocs(p: Params) {
  const started = performance.now();
  const { tabs } = useTabs.getState();
  const targets = p.scope === "current" ? tabs.filter((t) => t.id === useTabs.getState().activeId) : tabs;
  const results: FileResult[] = [];
  for (const tab of targets) {
    const model = getModel(tab.id);
    if (!model) continue;
    const matches = searchModel(model, p);
    if (matches.length) results.push({ path: tab.path ?? tab.title, tabId: tab.id, title: tab.title, matches });
  }
  const count = results.reduce((n, r) => n + r.matches.reduce((k, m) => k + m.ranges.length, 0), 0);
  useSearch.setState({
    running: false,
    results,
    summary: summarize(count, results.length, Math.round(performance.now() - started)),
  });
}

export async function runSearch() {
  const p = params();
  if (!p.query) return;
  if (useSearch.getState().running) await cancelSearch();
  remember("searchHistory", p.query);
  useSearch.setState({ results: [], summary: "", error: null, collapsed: {}, selected: null, lastParams: p, running: true });
  pending = [];

  if (p.scope !== "folder") {
    try {
      searchDocs(p);
    } catch (e) {
      // Monaco throws on an invalid JS regex.
      useSearch.setState({ running: false, error: errorMessage(e) });
    }
    return;
  }

  if (!p.folder) {
    useSearch.setState({ running: false, error: "Choose a folder to search in" });
    return;
  }
  remember("folderHistory", p.folder);
  useSettings.getState().update({ searchInclude: p.include, searchExclude: p.exclude });
  const id = ++searchSeq;
  useSearch.setState({ searchId: id });
  try {
    await searchStart(toRequest(p), id);
  } catch (e) {
    useSearch.setState({ running: false, error: errorMessage(e) });
  }
}

const toRequest = (p: Params): SearchRequest => ({
  root: p.folder,
  query: p.query,
  isRegex: p.isRegex,
  matchCase: p.matchCase,
  wholeWord: p.wholeWord,
  include: p.include,
  exclude: p.exclude,
});

export async function cancelSearch() {
  await searchCancel();
}

export function clearResults() {
  useSearch.setState({ results: [], summary: "", error: null, selected: null, lastParams: null });
}

// ---- Navigation

export async function modelShown(tabId: string) {
  const model = getModel(tabId);
  // The editor swaps models in a React effect; wait (briefly) for it.
  for (let i = 0; i < 20 && getEditor()?.getModel() !== model; i++) {
    await new Promise((r) => requestAnimationFrame(r));
  }
  return getEditor()?.getModel() === model;
}

export async function revealResult(file: number, match: number, focusEditor: boolean) {
  const r = useSearch.getState().results[file];
  const m = r?.matches[match];
  if (!m) return;
  useSearch.setState({ selected: { file, match } });
  let tabId = r.tabId && getTab(r.tabId) ? r.tabId : findTabByPath(r.path)?.id;
  if (!tabId) {
    await openPaths([r.path]);
    tabId = findTabByPath(r.path)?.id;
  }
  if (!tabId) return;
  activate(tabId);
  if (getTab(tabId)?.big) {
    const [start, end] = m.ranges[0];
    bigReveal(tabId, m.line - 1, { line: m.line - 1, start, end });
    return;
  }
  if (!(await modelShown(tabId))) return;
  const editor = getEditor()!;
  const [start, end] = m.ranges[0];
  const range = new monaco.Range(m.line, start + 1, m.line, end + 1);
  editor.setSelection(range);
  editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth);
  if (focusEditor) editor.focus();
}

export function stepResult(dir: 1 | -1) {
  const { results, selected, collapsed } = useSearch.getState();
  if (!results.length) return;
  let file = selected?.file ?? (dir > 0 ? 0 : results.length - 1);
  let match = selected ? selected.match + dir : dir > 0 ? 0 : results[file].matches.length - 1;
  if (match >= results[file].matches.length) {
    file = (file + 1) % results.length;
    match = 0;
  } else if (match < 0) {
    file = (file - 1 + results.length) % results.length;
    match = results[file].matches.length - 1;
  }
  if (collapsed[results[file].path]) useSearch.setState({ collapsed: { ...collapsed, [results[file].path]: false } });
  void revealResult(file, match, true);
}

// ---- Replace

function expandReplacement(groups: string[] | null, replacement: string): string {
  if (!groups) return replacement;
  return replacement.replace(/\$(\$|&|\d{1,2})/g, (all, g: string) => {
    if (g === "$") return "$";
    if (g === "&") return groups[0];
    const i = Number(g);
    return i < groups.length ? (groups[i] ?? "") : all;
  });
}

function replaceInModel(model: monaco.editor.ITextModel, p: Params, replacement: string): number {
  const matches = docMatches(model, p, p.isRegex);
  if (!matches.length) return 0;
  const edits = matches.map((m) => ({
    range: m.range,
    text: p.isRegex ? expandReplacement(m.matches, replacement) : replacement,
  }));
  model.pushStackElement();
  model.pushEditOperations(null, edits, () => null);
  model.pushStackElement();
  return matches.length;
}

export async function replaceAll() {
  const s = useSearch.getState();
  const p = s.lastParams;
  if (!p || !s.results.length) {
    notify("Search first, then replace the results");
    return;
  }
  remember("replaceHistory", s.replace);
  const total = s.results.reduce((n, r) => n + r.matches.reduce((k, m) => k + m.ranges.length, 0), 0);

  if (p.scope !== "folder") {
    let n = 0;
    for (const r of s.results) {
      const model = r.tabId ? getModel(r.tabId) : undefined;
      if (model) n += replaceInModel(model, p, s.replace);
    }
    notify(`Replaced ${n.toLocaleString()} occurrence${n === 1 ? "" : "s"} (undo with Ctrl+Z in each document)`);
    await runSearch();
    return;
  }

  // Files with unsaved edits in the editor are skipped so neither side's changes get lost.
  const dirty = s.results.filter((r) => findTabByPath(r.path)?.dirty);
  const paths = s.results.filter((r) => !findTabByPath(r.path)?.dirty).map((r) => r.path);
  const choice = await ask(
    `Replace ${total.toLocaleString()} occurrence${total === 1 ? "" : "s"} in ${paths.length} file${paths.length === 1 ? "" : "s"}?`,
    `Files are changed on disk and this cannot be undone.${dirty.length ? ` ${dirty.length} file(s) with unsaved changes will be skipped.` : ""}`,
    [
      { id: "replace", label: "Replace All", primary: true },
      { id: "cancel", label: "Cancel" },
    ],
  );
  if (choice !== "replace") return;
  try {
    const summary = await replaceInFiles(toRequest(p), s.replace, paths);
    for (const path of summary.changedFiles) {
      const tab = findTabByPath(path);
      if (tab) await reloadFromDisk(tab.id);
    }
    const n = summary.replacements;
    notify(`Replaced ${n.toLocaleString()} occurrence${n === 1 ? "" : "s"} in ${summary.changedFiles.length} file(s)`);
    for (const err of summary.errors.slice(0, 5)) notify(err, "error");
  } catch (e) {
    notify(errorMessage(e), "error");
  }
  await runSearch();
}

/** Bookmark every line with a result in documents that are open. */
export function bookmarkResultLines() {
  let n = 0;
  for (const r of useSearch.getState().results) {
    const tabId = r.tabId ?? findTabByPath(r.path)?.id;
    if (!tabId) continue;
    bookmarkLines(
      tabId,
      r.matches.map((m) => m.line),
    );
    n += r.matches.length;
  }
  notify(n ? `Bookmarked ${n} line${n === 1 ? "" : "s"} in open documents` : "No results in open documents");
}
