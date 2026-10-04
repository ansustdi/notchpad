import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { monaco } from "../monaco";
import { getEditor } from "../editorRef";
import {
  detectInterpreters,
  detectRuntime,
  findUp,
  Interpreter,
  openFile,
  runCacheDir,
  RunExit,
  RunOutput,
  runEof,
  runKill,
  runStart,
  runStdin,
  writeRunFile,
} from "../ipc";
import { activate, activeTab, findTabByPath, getModel, getTab, openPaths, saveTab, Tab } from "./tabs";
import { useSettings } from "./settings";
import { ask, askText, errorMessage, notify, showQuickPick } from "./ui";
import {
  cargoPackageName,
  cmakeTarget,
  DEFAULT_EXT,
  extOf,
  Lang,
  LANG_LABEL,
  langOf,
  Plan,
  planRun,
  PROJECT_FILES,
  Project,
  Step,
  Tool,
  ToolKind,
  toolsFor,
} from "../run/plan";
import { showPanelTab } from "./panel";
import { modelShown } from "./search";

export type ChunkKind = "stdout" | "stderr" | "stdin" | "info";

export interface Chunk {
  kind: ChunkKind;
  text: string;
}

interface RunState {
  open: boolean;
  running: boolean;
  runId: number | null;
  chunks: Chunk[];
  /** Characters dropped from the start to keep the buffer bounded. */
  trimmed: number;
  exit: Omit<RunExit, "id"> | null;
  /** What ran last, for "Run Again". */
  last: { tabId: string; title: string } | null;
  startedAt: number | null;
  /** Folder the program runs in; relative paths in its output resolve against it. */
  cwd: string | null;
}

export const useRun = create<RunState>(() => ({
  open: false,
  running: false,
  runId: null,
  chunks: [],
  trimmed: 0,
  exit: null,
  last: null,
  startedAt: null,
  cwd: null,
}));

/** Keep at most this much output (a runaway print loop shouldn't eat all memory). */
const MAX_CHARS = 2_000_000;

const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, "") || p;

// ---- Output buffering: events can arrive thousands of times a second, render at most per frame.

let pending: Chunk[] = [];
let frame = 0;

function append(kind: ChunkKind, text: string) {
  // Windows programs print CRLF; the panel only needs LF.
  pending.push({ kind, text: text.replace(/\r\n/g, "\n") });
  if (!frame) frame = requestAnimationFrame(flush);
}

function flush() {
  frame = 0;
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  useRun.setState((s) => {
    const chunks = [...s.chunks];
    for (const c of batch) {
      const last = chunks[chunks.length - 1];
      if (last && last.kind === c.kind) chunks[chunks.length - 1] = { kind: c.kind, text: last.text + c.text };
      else chunks.push(c);
    }
    let total = chunks.reduce((n, c) => n + c.text.length, 0);
    let trimmed = s.trimmed;
    while (total > MAX_CHARS && chunks.length) {
      const over = total - MAX_CHARS;
      const first = chunks[0];
      if (first.text.length <= over) {
        chunks.shift();
        total -= first.text.length;
        trimmed += first.text.length;
      } else {
        chunks[0] = { ...first, text: first.text.slice(over) };
        total -= over;
        trimmed += over;
      }
    }
    return { chunks, trimmed };
  });
}

void listen<RunOutput>("run-output", (e) => {
  if (e.payload.id === useRun.getState().runId) append(e.payload.stream, e.payload.text);
});

/** Steps still to run after the current one (build → run), and their environment. */
let queue: Step[] = [];
let queueEnv: [string, string][] = [];
let currentStep: Step | null = null;

void listen<RunExit>("run-exit", (e) => {
  const { id, ...exit } = e.payload;
  if (id !== useRun.getState().runId) return;
  flush();
  const secs = (exit.elapsedMs / 1000).toFixed(2);
  const building = currentStep?.kind === "build";
  if (!exit.killed && exit.code === 0 && queue.length) {
    append("info", `[Build finished in ${secs}s]\n\n`);
    void startStep(queue.shift()!);
    return;
  }
  queue = [];
  const how = exit.killed
    ? "Stopped"
    : exit.code === 0
      ? "Finished"
      : building
        ? `Build failed (code ${exit.code ?? "?"})`
        : `Exited with code ${exit.code ?? "?"}`;
  append("info", `\n[${how} in ${secs}s]\n`);
  flush();
  useRun.setState({ running: false, exit });
});

// ---- Interpreter

const detected = new Map<string, Interpreter[]>();

async function interpretersFor(dir: string | null, refresh = false): Promise<Interpreter[]> {
  const key = dir ?? "";
  if (!refresh && detected.has(key)) return detected.get(key)!;
  const list = await detectInterpreters(dir);
  detected.set(key, list);
  return list;
}

/** The chosen interpreter, or the best detected one for `dir` (venvs only apply to saved files). */
export async function resolvePython(dir: string, hasSavedPath: boolean): Promise<Interpreter | null> {
  return useSettings.getState().python ?? (await interpretersFor(hasSavedPath ? dir : null))[0] ?? null;
}

const describe = (i: Interpreter) => [i.program, ...i.args].join(" ");

export async function selectInterpreter() {
  const tab = activeTab();
  const list = await interpretersFor(tab?.path ? dirname(tab.path) : null, true);
  const current = useSettings.getState().python;
  showQuickPick({
    placeholder: list.length ? "Select Python interpreter" : "No Python found — install from python.org, then try again",
    items: [
      { id: "auto", label: "Auto-detect", detail: "nearest .venv / venv, then py / python / python3 on PATH" },
      ...list.map((i, n) => ({ id: String(n), label: `${i.version} — ${describe(i)}`, detail: i.source })),
    ],
    activeId: current ? String(list.findIndex((i) => describe(i) === describe(current))) : "auto",
    onPick: (item) => {
      const python = item.id === "auto" ? null : list[Number(item.id)];
      useSettings.getState().update({ python });
      notify(python ? `Python: ${python.version} (${describe(python)})` : "Python: auto-detect");
    },
  });
}

// ---- Running

/** Language a tab would run as, or null. */
export const runLangOf = (tab: Tab | undefined): Lang | null => (tab ? langOf(tab.language, tab.path ?? tab.title) : null);

export function openOutput() {
  useRun.setState({ open: true });
  showPanelTab("output");
}

export function closeOutput() {
  useRun.setState({ open: false });
  getEditor()?.focus();
}

let runSeq = 0;
/** Temp copies of unsaved buffers → the tab they came from (so error links open the buffer). */
const tempScripts = new Map<string, string>();
const normPath = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/** Detected tools per kind (+ folder for project-local ones like tsx). Cleared by re-detect. */
const toolCache = new Map<string, Promise<Tool | null>>();

function tool(kind: ToolKind, dir: string): Promise<Tool | null> {
  const key = kind === "tsx" ? `tsx|${dir}` : kind;
  if (!toolCache.has(key)) toolCache.set(key, detectRuntime(kind, dir).catch(() => null));
  return toolCache.get(key)!;
}

async function gatherTools(lang: Lang, project: Project, dir: string, hasSavedPath: boolean) {
  const tools: Partial<Record<ToolKind, Tool | null>> = {};
  if (lang === "python") {
    tools.python = await resolvePython(dir, hasSavedPath);
    return tools;
  }
  // Preference order; stop at the first usable one (detection spawns processes).
  for (const k of toolsFor(lang, project)) {
    const t = await tool(k, dir);
    tools[k] = t;
    if (t && t.source !== "too-old") break;
  }
  return tools;
}

let cacheDir: Promise<string> | null = null;
const getCacheDir = () => (cacheDir ??= runCacheDir());

async function startStep(step: Step) {
  const id = ++runSeq;
  currentStep = step;
  useRun.setState({ runId: id, running: true, cwd: step.cwd });
  append("info", `> ${[step.program, ...step.args].map(quote).join(" ")}\n  in ${step.cwd}\n\n`);
  try {
    await runStart(id, step.program, step.args, step.cwd, queueEnv);
  } catch (e) {
    queue = [];
    append("stderr", `${errorMessage(e)}\n`);
    flush();
    useRun.setState({ running: false });
  }
}

function showError(message: string) {
  openOutput();
  pending = [];
  useRun.setState({ chunks: [{ kind: "stderr", text: `${message}\n` }], trimmed: 0, exit: null, running: false });
}

export async function runActiveFile(tabId?: string) {
  const tab = tabId ? getTab(tabId) : activeTab();
  if (!tab) return;
  if (tab.big || !getModel(tab.id)) return notify("Big-file tabs can't be run");
  const lang = runLangOf(tab);
  if (!lang) {
    return notify(
      `Run supports ${Object.values(LANG_LABEL).join(", ")}. Save the file with its extension or set the language mode.`,
    );
  }

  if (useRun.getState().running) {
    const choice = await ask("A program is still running.", "Stop it and start again?", [
      { id: "restart", label: "Stop and Run", primary: true },
      { id: "cancel", label: "Cancel" },
    ]);
    if (choice !== "restart") return;
    await stopRun();
  }

  // Run what's on screen: save edits first; unsaved buffers run from a temp copy.
  let path = tab.path;
  if (path && tab.dirty && !(await saveTab(tab.id))) return;
  const source = getModel(tab.id)!.getValue();
  if (!path) {
    const name = extOf(tab.title) ? tab.title : `${tab.title}.${DEFAULT_EXT[lang]}`;
    path = await writeRunFile(`scripts/${name}`, source);
    tempScripts.set(normPath(path), tab.id);
  }
  const dir = path.replace(/[\\/][^\\/]*$/, "");

  const project: Project = {};
  const pf = PROJECT_FILES[lang];
  // Only saved files belong to a project; temp copies live in the app cache.
  if (pf && tab.path) project[pf.key] = await findUp(dir, pf.names);
  if (project.cargoToml) {
    project.cargoPackage = cargoPackageName((await openFile(project.cargoToml).catch(() => null))?.content ?? "");
  }
  if (project.cmakeLists) {
    project.cmakeTarget = cmakeTarget((await openFile(project.cmakeLists).catch(() => null))?.content ?? "", path);
  }

  pending = [];
  useRun.setState({
    open: true,
    running: true,
    runId: null,
    chunks: [],
    trimmed: 0,
    exit: null,
    last: { tabId: tab.id, title: tab.title },
    startedAt: Date.now(),
  });
  showPanelTab("output");

  let plan: Plan;
  try {
    const [tools, cache] = await Promise.all([gatherTools(lang, project, dir, !!tab.path), getCacheDir()]);
    plan = planRun({
      lang,
      file: path,
      source,
      tools,
      project,
      cacheDir: cache,
      windows: navigator.userAgent.includes("Windows"),
      custom: useSettings.getState().runCommands[lang],
    });
  } catch (e) {
    plan = { error: errorMessage(e) };
  }
  if ("error" in plan) return showError(plan.error);

  for (const f of plan.files ?? []) {
    const written = await writeRunFile(f.rel, f.content);
    // A generated project's Program.cs is a copy of this tab: send its error links back here.
    if (f.content === source) tempScripts.set(normPath(written), tab.id);
  }
  queueEnv = plan.env ?? [];
  queue = plan.steps.slice(1);
  await startStep(plan.steps[0]);
}

/** Per-language command override, e.g. `node --inspect {file}`; empty = automatic. */
export function configureRunCommand() {
  const lang = runLangOf(activeTab());
  if (!lang) return notify("Open a file of a runnable language first");
  const current = useSettings.getState().runCommands[lang] ?? "";
  askText(
    `${LANG_LABEL[lang]} run command — {file} {dir} {name} {ext}; empty = automatic${current ? ` (now: ${current})` : ""}`,
    (text) => {
      const runCommands = { ...useSettings.getState().runCommands };
      if (text) runCommands[lang] = text;
      else delete runCommands[lang];
      useSettings.getState().update({ runCommands });
      notify(text ? `${LANG_LABEL[lang]} runs with: ${text}` : `${LANG_LABEL[lang]}: automatic run command`);
    },
  );
}

/** Forget detected tools (after installing something new). */
export function redetectTools() {
  toolCache.clear();
  detected.clear();
  notify("Runtimes will be detected again on the next run");
}

const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

export async function rerun() {
  const last = useRun.getState().last;
  await runActiveFile(last && getTab(last.tabId) ? last.tabId : undefined);
}

export async function stopRun() {
  const { runId, running } = useRun.getState();
  if (runId === null || !running) return;
  try {
    await runKill(runId);
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

export async function sendInput(text: string) {
  const { runId, running } = useRun.getState();
  if (runId === null || !running) return;
  append("stdin", `${text}\n`);
  try {
    await runStdin(runId, `${text}\n`);
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

export async function sendEof() {
  const { runId, running } = useRun.getState();
  if (runId !== null && running) await runEof(runId);
}

export function clearOutput() {
  useRun.setState({ chunks: [], trimmed: 0 });
}

/** Jump to a file position mentioned in output (traceback lines). */
export async function openLocation(path: string, line: number, column = 0) {
  // Relative paths (Java stack traces, cargo errors) are relative to where the program ran.
  const cwd = useRun.getState().cwd;
  if (cwd && !/^([A-Za-z]:[\\/]|[\\/])/.test(path)) path = `${cwd}/${path}`;
  const fromTemp = tempScripts.get(normPath(path));
  let tab = (fromTemp && getTab(fromTemp)) || findTabByPath(path);
  if (!tab) {
    await openPaths([path]);
    tab = findTabByPath(path);
  }
  if (!tab) return;
  activate(tab.id);
  if (!(await modelShown(tab.id))) return;
  const editor = getEditor()!;
  const model = editor.getModel()!;
  const ln = Math.min(Math.max(1, line), model.getLineCount());
  if (column > 0) editor.setPosition({ lineNumber: ln, column: Math.min(column, model.getLineMaxColumn(ln)) });
  else editor.setSelection(new monaco.Range(ln, model.getLineFirstNonWhitespaceColumn(ln) || 1, ln, model.getLineMaxColumn(ln)));
  editor.revealLineInCenterIfOutsideViewport(ln);
  editor.focus();
}
