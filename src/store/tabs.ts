import { create } from "zustand";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { monaco, languageForPath, PLAINTEXT } from "../monaco";
import { bigfileClose, bigfileOpen, Eol, hexClose, hexOpen, openFile, probeFile, saveFile } from "../ipc";
import { getBigView, registerBig, unregisterBig } from "./bigview";
import { getHexView, registerHex, saveHexDoc, unregisterHex } from "./hexview";
import { baseName, samePath } from "../platform";
import { askSave, errorMessage, notify } from "./ui";
import { useSettings } from "./settings";
import { scheduleSessionSave } from "../session";

/** One open document. A document can be shown in several groups (a "clone"). */
export interface Tab {
  id: string;
  path: string | null;
  title: string;
  language: string;
  encoding: string;
  hasBom: boolean;
  eol: Eol;
  dirty: boolean;
  /** Read-only big-file viewer tab (no Monaco model). */
  big?: boolean;
  /** Hex editor tab (bytes, no Monaco model). */
  hex?: boolean;
  /** Pinned tabs sit at the left and survive "Close Others / All". */
  pinned?: boolean;
  /**
   * Preview (Sublime / VS Code): opened by a single click in the side bar, shown in italics, and
   * replaced by the next single-clicked file. Editing, saving or double-clicking keeps it.
   */
  preview?: boolean;
}

/** An editor group: its own tab strip and editor. */
export interface Group {
  id: string;
  tabIds: string[];
  activeId: string | null;
  /** Relative size (flex-grow) within the layout. */
  size: number;
}

export type Orientation = "columns" | "rows";

interface TabsState {
  /** Every open document, in opening order. Groups decide display order. */
  tabs: Tab[];
  groups: Group[];
  activeGroup: string;
  orientation: Orientation;
  /** Active document of the active group (derived; kept in sync by `commitGroups`). */
  activeId: string | null;
  untitledCounter: number;
}

export const MAX_GROUPS = 4;

let idSeq = 0;
const newId = (prefix = "t") => `${prefix}${Date.now().toString(36)}${(idSeq++).toString(36)}`;

const firstGroup: Group = { id: "g1", tabIds: [], activeId: null, size: 1 };

export const useTabs = create<TabsState>(() => ({
  tabs: [],
  groups: [firstGroup],
  activeGroup: firstGroup.id,
  orientation: "columns",
  activeId: null,
  untitledCounter: 0,
}));

const models = new Map<string, monaco.editor.ITextModel>();
/** Model alternativeVersionId at last save; -1 means "never matches", i.e. always dirty. */
const savedVersions = new Map<string, number>();
/** Editor view state (scroll, cursor, folding) per group + document. */
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
const closedPaths: string[] = [];

const vsKey = (groupId: string, docId: string) => `${groupId}|${docId}`;
export const getViewState = (groupId: string, docId: string) => viewStates.get(vsKey(groupId, docId));
export const setViewState = (groupId: string, docId: string, vs: monaco.editor.ICodeEditorViewState | null) =>
  viewStates.set(vsKey(groupId, docId), vs);
/** Any saved view state for a document (used by the session, which stores one per document). */
export const anyViewState = (docId: string) => {
  for (const g of useTabs.getState().groups) {
    const vs = viewStates.get(vsKey(g.id, docId));
    if (vs) return vs;
  }
  return null;
};

export const getModel = (id: string) => models.get(id);
export const getTab = (id: string) => useTabs.getState().tabs.find((t) => t.id === id);
export const getGroup = (id: string) => useTabs.getState().groups.find((g) => g.id === id);
export const activeGroup = () => getGroup(useTabs.getState().activeGroup)!;
export const activeTab = () => {
  const { tabs, activeId } = useTabs.getState();
  return tabs.find((t) => t.id === activeId);
};
export const groupsOf = (docId: string) => useTabs.getState().groups.filter((g) => g.tabIds.includes(docId));

/** Pinned tabs first, otherwise keep order. */
function normalize(g: Group): Group {
  const pinned = new Set(useTabs.getState().tabs.filter((t) => t.pinned).map((t) => t.id));
  const tabIds = [...g.tabIds.filter((id) => pinned.has(id)), ...g.tabIds.filter((id) => !pinned.has(id))];
  const activeId = g.activeId && tabIds.includes(g.activeId) ? g.activeId : (tabIds[0] ?? null);
  return { ...g, tabIds, activeId };
}

/** Apply a change to the group list, drop empty extra groups and recompute `activeId`. */
function commitGroups(update: (s: TabsState) => Pick<TabsState, "groups"> & Partial<Pick<TabsState, "activeGroup">>) {
  useTabs.setState((s) => {
    const next = update(s);
    let groups = next.groups.map(normalize);
    let activeGroupId = next.activeGroup ?? s.activeGroup;
    if (groups.length > 1) {
      const kept = groups.filter((g) => g.tabIds.length > 0);
      if (kept.length && !kept.some((g) => g.id === activeGroupId)) {
        // The active group vanished: pick the neighbour at the same position.
        const idx = groups.findIndex((g) => g.id === activeGroupId);
        activeGroupId = kept[Math.min(Math.max(0, idx - 1), kept.length - 1)].id;
      }
      // A group went away: the rest share the space evenly again.
      if (kept.length !== groups.length) groups = (kept.length ? kept : [groups[0]]).map((g) => ({ ...g, size: 1 }));
    }
    if (groups.length === 1 && groups[0].size !== 1) groups = [{ ...groups[0], size: 1 }];
    if (!groups.some((g) => g.id === activeGroupId)) activeGroupId = groups[0].id;
    const ag = groups.find((g) => g.id === activeGroupId)!;
    return { groups, activeGroup: activeGroupId, activeId: ag.activeId };
  });
  scheduleSessionSave();
}

function patchTab(id: string, patch: Partial<Tab>) {
  useTabs.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  scheduleSessionSave();
}

/** Dirty flag for documents without a Monaco model (hex tabs). */
export function setTabDirty(id: string, dirty: boolean) {
  if (getTab(id) && getTab(id)!.dirty !== dirty) patchTab(id, { dirty });
}

function refreshDirty(id: string) {
  const model = models.get(id);
  const tab = getTab(id);
  if (!model || !tab) return;
  const dirty = model.getAlternativeVersionId() !== savedVersions.get(id);
  if (dirty !== tab.dirty) patchTab(id, { dirty });
}

function markSaved(id: string) {
  const model = models.get(id)!;
  savedVersions.set(id, model.getAlternativeVersionId());
  refreshDirty(id);
}

/** Insert `docId` into a group right after its active tab (or at `index`). */
function placeInGroup(groupId: string, docId: string, activate: boolean, index?: number) {
  commitGroups((s) => ({
    groups: s.groups.map((g) => {
      if (g.id !== groupId) return g;
      const without = g.tabIds.filter((id) => id !== docId);
      const at = index ?? (g.activeId ? without.indexOf(g.activeId) + 1 : without.length);
      const tabIds = [...without.slice(0, at), docId, ...without.slice(at)];
      return { ...g, tabIds, activeId: activate ? docId : (g.activeId ?? docId) };
    }),
    activeGroup: activate ? groupId : s.activeGroup,
  }));
}

export interface TabInit {
  id?: string;
  path: string | null;
  title?: string;
  content: string;
  language?: string;
  encoding?: string;
  hasBom?: boolean;
  eol?: Eol;
  dirty?: boolean;
  pinned?: boolean;
  preview?: boolean;
}

/** Placement for new documents: a group id, the active group (default), or null = not shown yet. */
type Placement = { group?: string | null; activate?: boolean; index?: number };

export function createTab(init: TabInit, place: Placement = {}): Tab {
  const id = init.id ?? newId();
  const language = init.language ?? languageForPath(init.path);
  const eol = init.eol ?? "LF";
  const model = monaco.editor.createModel(init.content, language);
  model.setEOL(eol === "CRLF" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
  const { insertSpaces, tabSize } = useSettings.getState();
  model.detectIndentation(insertSpaces, tabSize);
  models.set(id, model);
  savedVersions.set(id, init.dirty ? -1 : model.getAlternativeVersionId());
  model.onDidChangeContent(() => {
    refreshDirty(id);
    // Editing a preview keeps it.
    if (getTab(id)?.preview) makePermanent(id);
    scheduleSessionSave();
  });

  const tab: Tab = {
    id,
    path: init.path,
    title: init.title ?? (init.path ? baseName(init.path) : "untitled"),
    language,
    encoding: init.encoding ?? "UTF-8",
    hasBom: init.hasBom ?? false,
    eol,
    dirty: !!init.dirty,
    pinned: init.pinned,
    preview: init.preview || undefined,
  };
  useTabs.setState((s) => ({ tabs: [...s.tabs, tab] }));
  if (place.group !== null) placeInGroup(place.group ?? useTabs.getState().activeGroup, id, place.activate ?? true, place.index);
  scheduleSessionSave();
  return tab;
}

/** Open `path` in the read-only big-file viewer. */
export async function openBig(path: string, opts: { id?: string; top?: number; preview?: boolean } & Placement = {}): Promise<Tab> {
  const opened = await bigfileOpen(path);
  const id = opts.id ?? newId();
  registerBig(id, opened.id, opened.status, opts.top ?? 0);
  const tab: Tab = {
    id,
    path: opened.path,
    title: opened.name,
    language: PLAINTEXT,
    encoding: opened.encoding,
    hasBom: opened.hasBom,
    eol: "LF",
    dirty: false,
    big: true,
    preview: opts.preview || undefined,
  };
  useTabs.setState((s) => ({ tabs: [...s.tabs, tab] }));
  if (opts.group !== null) placeInGroup(opts.group ?? useTabs.getState().activeGroup, id, opts.activate ?? true, opts.index);
  scheduleSessionSave();
  return tab;
}

/** Open `path` (null = a new empty document) in the hex editor. */
export async function openHex(path: string | null, opts: { id?: string; top?: number; cursor?: number; preview?: boolean } & Placement = {}): Promise<Tab> {
  const opened = await hexOpen(path);
  const id = opts.id ?? newId();
  registerHex(id, opened.id, opened.len, opts.top ?? 0, opts.cursor ?? 0);
  let title = path ? baseName(path) : "";
  if (!path) {
    const n = useTabs.getState().untitledCounter + 1;
    useTabs.setState({ untitledCounter: n });
    title = `new ${n}.bin`;
  }
  const tab: Tab = {
    id,
    path,
    title,
    language: PLAINTEXT,
    encoding: "binary",
    hasBom: false,
    eol: "LF",
    dirty: false,
    hex: true,
    preview: opts.preview || undefined,
  };
  useTabs.setState((s) => ({ tabs: [...s.tabs, tab] }));
  if (opts.group !== null) placeInGroup(opts.group ?? useTabs.getState().activeGroup, id, opts.activate ?? true, opts.index);
  scheduleSessionSave();
  return tab;
}

export function newUntitled(groupId?: string): Tab {
  const n = useTabs.getState().untitledCounter + 1;
  useTabs.setState({ untitledCounter: n });
  const eol: Eol = navigator.userAgent.includes("Windows") ? "CRLF" : "LF";
  return createTab({ path: null, title: `new ${n}`, content: "", eol }, { group: groupId });
}

export function setActiveGroup(groupId: string) {
  if (useTabs.getState().activeGroup === groupId || !getGroup(groupId)) return;
  commitGroups((s) => ({ groups: s.groups, activeGroup: groupId }));
}

/**
 * Show document `id`: in `groupId` if given, else in the active group if it's there,
 * else in whichever group has it, else add it to the active group.
 */
export function activate(id: string, groupId?: string) {
  const s = useTabs.getState();
  const target =
    (groupId && getGroup(groupId)) ||
    (activeGroup().tabIds.includes(id) ? activeGroup() : s.groups.find((g) => g.tabIds.includes(id)));
  if (!target) return placeInGroup(s.activeGroup, id, true);
  if (!target.tabIds.includes(id)) return placeInGroup(target.id, id, true);
  if (target.activeId === id && s.activeGroup === target.id) return;
  commitGroups((st) => ({
    groups: st.groups.map((g) => (g.id === target.id ? { ...g, activeId: id } : g)),
    activeGroup: target.id,
  }));
}

export function cycleTab(delta: number) {
  const g = activeGroup();
  if (g.tabIds.length < 2) return;
  const i = g.tabIds.indexOf(g.activeId ?? "");
  activate(g.tabIds[(i + delta + g.tabIds.length) % g.tabIds.length], g.id);
}

export function moveTab(docId: string, toIndex: number, groupId = useTabs.getState().activeGroup) {
  const g = getGroup(groupId);
  if (!g) return;
  const from = g.tabIds.indexOf(docId);
  if (from < 0 || from === toIndex) return;
  // Don't let a normal tab jump in front of pinned ones (or vice versa).
  const pinned = g.tabIds.filter((id) => getTab(id)?.pinned).length;
  const isPinned = !!getTab(docId)?.pinned;
  const clamped = isPinned ? Math.min(toIndex, pinned - 1) : Math.max(toIndex, pinned);
  commitGroups((s) => ({
    groups: s.groups.map((x) => {
      if (x.id !== groupId) return x;
      const tabIds = [...x.tabIds];
      tabIds.splice(from, 1);
      tabIds.splice(clamped, 0, docId);
      return { ...x, tabIds };
    }),
  }));
}

export function togglePin(docId: string) {
  const tab = getTab(docId);
  if (!tab) return;
  patchTab(docId, { pinned: !tab.pinned, preview: undefined });
  commitGroups((s) => ({ groups: s.groups }));
}

// ---- Groups

function neighbourGroup(from: string): Group | undefined {
  const { groups } = useTabs.getState();
  const i = groups.findIndex((g) => g.id === from);
  return groups[i + 1] ?? groups[i - 1];
}

function newGroupAfter(groupId: string): string {
  const id = newId("g");
  useTabs.setState((s) => {
    const i = s.groups.findIndex((g) => g.id === groupId);
    const groups = [...s.groups];
    groups.splice(i + 1, 0, { id, tabIds: [], activeId: null, size: 1 });
    // Fresh split: share space evenly.
    return { groups: groups.map((g) => ({ ...g, size: 1 })) };
  });
  return id;
}

/** Move a document from one group to another ("new" creates a group to the right/below). */
export function moveToGroup(docId: string, fromGroup: string, target: string | "new", index?: number) {
  const { groups } = useTabs.getState();
  if (target === "new" && groups.length >= MAX_GROUPS) {
    notify(`At most ${MAX_GROUPS} groups`);
    return;
  }
  const to = target === "new" ? newGroupAfter(fromGroup) : target;
  if (to === fromGroup) return;
  // Docs already in the target group just get activated there.
  const already = getGroup(to)?.tabIds.includes(docId);
  const fromVs = getViewState(fromGroup, docId);
  if (fromVs && !already) setViewState(to, docId, fromVs);
  commitGroups((s) => ({
    groups: s.groups.map((g) => {
      if (g.id === fromGroup) {
        const i = g.tabIds.indexOf(docId);
        const tabIds = g.tabIds.filter((id) => id !== docId);
        const activeId = g.activeId === docId ? (tabIds[Math.min(i, tabIds.length - 1)] ?? null) : g.activeId;
        return { ...g, tabIds, activeId };
      }
      if (g.id === to) {
        if (already) return { ...g, activeId: docId };
        const tabIds = [...g.tabIds];
        tabIds.splice(index ?? tabIds.length, 0, docId);
        return { ...g, tabIds, activeId: docId };
      }
      return g;
    }),
    activeGroup: to,
  }));
}

/** Show the same document in another group too (Notepad++ "Clone to Other View"). */
export function cloneToGroup(docId: string, fromGroup: string, target: string | "new") {
  if (getTab(docId)?.big || getTab(docId)?.hex) {
    notify("Big files and hex documents can be moved to another group, not cloned");
    return;
  }
  const { groups } = useTabs.getState();
  if (target === "new" && groups.length >= MAX_GROUPS) {
    notify(`At most ${MAX_GROUPS} groups`);
    return;
  }
  const to = target === "new" ? newGroupAfter(fromGroup) : target;
  const vs = getViewState(fromGroup, docId);
  if (vs) setViewState(to, docId, vs);
  placeInGroup(to, docId, true);
}

/** Target for "move/clone to other group": the neighbour, or a new group if there's only one. */
export const otherGroup = (groupId: string): string | "new" => neighbourGroup(groupId)?.id ?? "new";

/** Split: show the active document in a new group next to the current one. */
export function splitActive() {
  const g = activeGroup();
  const doc = g.activeId && getTab(g.activeId);
  if (!doc) return;
  if (doc.big || doc.hex) moveToGroup(doc.id, g.id, "new");
  else cloneToGroup(doc.id, g.id, "new");
}

export async function closeGroup(groupId: string) {
  const g = getGroup(groupId);
  if (!g) return;
  for (const id of [...g.tabIds]) {
    if (!(await closeTab(id, groupId))) return;
  }
}

export function focusGroup(index: number) {
  const g = useTabs.getState().groups[index];
  if (g) setActiveGroup(g.id);
}

export function setOrientation(orientation: Orientation) {
  useTabs.setState({ orientation });
  scheduleSessionSave();
}

export function setGroupSizes(sizes: Record<string, number>) {
  useTabs.setState((s) => ({ groups: s.groups.map((g) => (sizes[g.id] ? { ...g, size: sizes[g.id] } : g)) }));
  scheduleSessionSave();
}

/** Restore a saved layout; unknown docs are dropped, orphan docs go to the first group. */
export function resetAllTabs() {
  for (const t of [...useTabs.getState().tabs]) disposeTab(t.id);
  viewStates.clear();
  useTabs.setState({ tabs: [], groups: [{ ...firstGroup }], activeGroup: firstGroup.id, activeId: null, untitledCounter: 0 });
}

export function restoreLayout(saved: { groups: Group[]; activeGroup: string; orientation: Orientation }) {
  const known = new Set(useTabs.getState().tabs.map((t) => t.id));
  let groups = saved.groups
    .map((g) => ({ ...g, tabIds: g.tabIds.filter((id) => known.has(id)) }))
    .filter((g) => g.tabIds.length);
  if (!groups.length) groups = [{ ...firstGroup }];
  const placed = new Set(groups.flatMap((g) => g.tabIds));
  const orphans = [...known].filter((id) => !placed.has(id));
  groups[0] = { ...groups[0], tabIds: [...groups[0].tabIds, ...orphans] };
  useTabs.setState({ orientation: saved.orientation ?? "columns" });
  commitGroups(() => ({ groups, activeGroup: saved.activeGroup }));
}

// ---- Opening files

/** An empty, unmodified untitled tab gets replaced by the next opened file (Notepad++ style). */
function pristineUntitled(): Tab | undefined {
  const tab = activeTab();
  if (!tab || tab.path || tab.dirty || tab.hex || models.get(tab.id)?.getValueLength()) return undefined;
  return useTabs.getState().tabs.length === 1 ? tab : undefined;
}

/** Keep a preview tab (it stops being replaced by the next single-clicked file). */
export function makePermanent(id: string) {
  const tab = getTab(id);
  if (tab?.preview) patchTab(id, { preview: undefined });
}

/** The active group's preview tab, if any (only clean previews are ever replaced). */
function currentPreview(): { tab: Tab; index: number } | undefined {
  const g = activeGroup();
  const index = g.tabIds.findIndex((id) => {
    const t = getTab(id);
    return t?.preview && !t.dirty;
  });
  return index < 0 ? undefined : { tab: getTab(g.tabIds[index])!, index };
}

/**
 * Open files as tabs. With `preview`, a single file opens as the preview tab, taking the
 * place of the current preview (Sublime's single-click in the side bar).
 */
export async function openPaths(paths: string[], { preview = false } = {}) {
  let replace = pristineUntitled();
  const asPreview = preview && paths.length === 1;
  for (const path of paths) {
    const samePathTabs = useTabs.getState().tabs.filter((t) => t.path && samePath(t.path, path));
    const existing = samePathTabs.find((t) => !t.hex) ?? samePathTabs[0];
    if (existing) {
      activate(existing.id);
      continue;
    }
    const old = asPreview ? currentPreview() : undefined;
    const place = old ? { index: old.index } : {};
    try {
      const [size, big, binary] = await probeFile(path);
      if (binary) {
        // Opened meanwhile by another call (a quick double click): don't duplicate it.
        const raced = useTabs.getState().tabs.find((t) => t.path && samePath(t.path, path));
        if (raced) {
          activate(raced.id);
          continue;
        }
        await openHex(path, { preview: asPreview, ...place });
      } else if (big) {
        await openBig(path, { preview: asPreview, ...place });
        notify(`${baseName(path)} is ${(size / 1024 / 1024).toFixed(0)} MB — opened read-only in big-file mode`);
      } else {
        const file = await openFile(path);
        // Opened meanwhile by another call (e.g. a quick double click): don't duplicate it.
        const raced = useTabs.getState().tabs.find((t) => t.path && samePath(t.path, path));
        if (raced) {
          activate(raced.id);
          continue;
        }
        createTab({ ...file, title: file.name, preview: asPreview }, place);
        if (file.hadErrors) notify(`${file.name}: some bytes could not be decoded as ${file.encoding}`, "error");
      }
      if (replace) {
        disposeTab(replace.id);
        replace = undefined;
      }
      // The new preview took the old one's place: close the old one (it had no edits).
      if (old && !getTab(old.tab.id)?.dirty) disposeTab(old.tab.id);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }
}

export async function openWithDialog() {
  const cur = activeTab()?.path;
  const picked = await openDialog({ multiple: true, directory: false, defaultPath: cur ?? undefined });
  if (!picked) return;
  await openPaths(Array.isArray(picked) ? picked : [picked]);
}

let beforeSave: ((id: string) => Promise<unknown>) | null = null;

/** Hook run just before a document is written (format on save). Its failure never blocks saving. */
export function setBeforeSave(fn: (id: string) => Promise<unknown>) {
  beforeSave = fn;
}

/** Returns false if the user cancelled or the save failed. */
export async function saveTab(id: string, forceDialog = false): Promise<boolean> {
  const tab = getTab(id);
  if (tab?.hex) return saveHexTab(tab, forceDialog);
  const model = models.get(id);
  if (tab?.big) notify(`${tab.title} is open read-only (big-file mode)`);
  if (!tab || !model) return false;
  let path = tab.path;
  if (!path || forceDialog) {
    const picked = await saveDialog({ defaultPath: tab.path ?? `${tab.title}.txt` });
    if (!picked) return false;
    path = picked;
  }
  if (beforeSave) await beforeSave(id).catch((e) => console.error("before-save hook failed", e));
  try {
    await saveFile({ path, content: model.getValue(), encoding: tab.encoding, hasBom: tab.hasBom, eol: tab.eol });
  } catch (e) {
    notify(errorMessage(e), "error");
    return false;
  }
  if (path !== tab.path) {
    const language = tab.language === PLAINTEXT || !tab.path ? languageForPath(path) : tab.language;
    monaco.editor.setModelLanguage(model, language);
    patchTab(id, { path, title: baseName(path), language });
  }
  markSaved(id);
  makePermanent(id);
  return true;
}

async function saveHexTab(tab: Tab, forceDialog: boolean): Promise<boolean> {
  const view = getHexView(tab.id);
  if (!view) return false;
  let path = tab.path;
  if (!path || forceDialog) {
    const picked = await saveDialog({ defaultPath: tab.path ?? tab.title });
    if (!picked) return false;
    path = picked;
  }
  try {
    await saveHexDoc(tab.id, path);
  } catch (e) {
    notify(errorMessage(e), "error");
    return false;
  }
  if (path !== tab.path) patchTab(tab.id, { path, title: baseName(path) });
  makePermanent(tab.id);
  return true;
}

/** Open the active document's file in the hex editor (or a new empty hex document). */
export async function reopenInHex(id = useTabs.getState().activeId) {
  const tab = id ? getTab(id) : undefined;
  if (tab?.hex) return;
  if (!tab?.path) {
    await openHex(null);
    return;
  }
  const existing = useTabs.getState().tabs.find((t) => t.hex && t.path && samePath(t.path, tab.path!));
  if (existing) return activate(existing.id);
  if (tab.dirty) notify(`${tab.title} has unsaved changes; the hex editor shows the file as saved on disk`);
  try {
    await openHex(tab.path);
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

/** Open the active hex document's file as text. */
export async function reopenAsText(id = useTabs.getState().activeId) {
  const tab = id ? getTab(id) : undefined;
  if (!tab?.hex || !tab.path) return;
  const existing = useTabs.getState().tabs.find((t) => !t.hex && t.path && samePath(t.path, tab.path!));
  if (existing) return activate(existing.id);
  try {
    const file = await openFile(tab.path);
    createTab({ ...file, title: file.name });
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

export async function saveAll() {
  for (const tab of useTabs.getState().tabs) {
    if (tab.dirty && !(await saveTab(tab.id))) return;
  }
}

// ---- Closing

function removeFromGroup(groupId: string, docId: string) {
  viewStates.delete(vsKey(groupId, docId));
  commitGroups((s) => ({
    groups: s.groups.map((g) => {
      if (g.id !== groupId) return g;
      const i = g.tabIds.indexOf(docId);
      const tabIds = g.tabIds.filter((id) => id !== docId);
      const activeId = g.activeId === docId ? (tabIds[Math.min(i, tabIds.length - 1)] ?? null) : g.activeId;
      return { ...g, tabIds, activeId };
    }),
  }));
}

function disposeTab(id: string) {
  for (const g of groupsOf(id)) removeFromGroup(g.id, id);
  useTabs.setState((s) => ({ tabs: s.tabs.filter((t) => t.id !== id) }));
  const big = getBigView(id);
  if (big) {
    void bigfileClose(big.bigId);
    unregisterBig(id);
  }
  const hex = getHexView(id);
  if (hex) {
    void hexClose(hex.hexId);
    unregisterHex(id);
  }
  models.get(id)?.dispose();
  models.delete(id);
  savedVersions.delete(id);
  scheduleSessionSave();
}

/**
 * Close document `id` in `groupId` (default: the active group, or wherever it is).
 * If the document is also shown in another group, only this view goes away.
 */
export async function closeTab(id: string, groupId?: string): Promise<boolean> {
  const tab = getTab(id);
  if (!tab) return true;
  const inGroups = groupsOf(id);
  const gid = groupId ?? (activeGroup().tabIds.includes(id) ? activeGroup().id : inGroups[0]?.id);
  if (inGroups.length > 1 && gid) {
    removeFromGroup(gid, id);
    return true;
  }
  if (tab.dirty) {
    activate(id, gid);
    const choice = await askSave(`Save changes to "${tab.title}"?`);
    if (choice === "cancel") return false;
    if (choice === "save" && !(await saveTab(id))) return false;
  }
  if (tab.path) {
    closedPaths.push(tab.path);
    if (closedPaths.length > 50) closedPaths.shift();
  }
  const onlyGroup = useTabs.getState().groups.length === 1;
  disposeTab(id);
  if (useTabs.getState().tabs.length === 0 || (onlyGroup && activeGroup().tabIds.length === 0)) newUntitled();
  return true;
}

async function closeMany(groupId: string, ids: string[]) {
  for (const id of ids) {
    if (!(await closeTab(id, groupId))) return;
  }
}

const unpinned = (ids: string[]) => ids.filter((id) => !getTab(id)?.pinned);

export async function closeOthers(keepId: string, groupId = useTabs.getState().activeGroup) {
  const g = getGroup(groupId);
  if (g) await closeMany(groupId, unpinned(g.tabIds.filter((id) => id !== keepId)));
}

export async function closeToRight(fromId: string, groupId = useTabs.getState().activeGroup) {
  const g = getGroup(groupId);
  if (g) await closeMany(groupId, unpinned(g.tabIds.slice(g.tabIds.indexOf(fromId) + 1)));
}

export async function closeAll(groupId = useTabs.getState().activeGroup) {
  const g = getGroup(groupId);
  if (g) await closeMany(groupId, unpinned(g.tabIds));
}

export async function reopenClosed() {
  const path = closedPaths.pop();
  if (path) await openPaths([path]);
}

// ---- Document properties

export function setEol(id: string, eol: Eol) {
  const model = models.get(id);
  if (!model) return;
  model.pushEOL(eol === "CRLF" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
  patchTab(id, { eol });
  // Switching EOL only changes bytes on disk; force a save to be needed.
  savedVersions.set(id, -1);
  refreshDirty(id);
}

export function setSaveEncoding(id: string, encoding: string, hasBom: boolean) {
  patchTab(id, { encoding, hasBom });
  savedVersions.set(id, -1);
  refreshDirty(id);
}

export async function reopenWithEncoding(id: string, encoding: string) {
  const tab = getTab(id);
  const model = models.get(id);
  if (!tab?.path || !model) return;
  if (tab.dirty) {
    const choice = await askSave(`Reopening "${tab.title}" discards unsaved changes. Save first?`);
    if (choice === "cancel") return;
    if (choice === "save" && !(await saveTab(id))) return;
  }
  try {
    const file = await openFile(tab.path, encoding);
    model.setValue(file.content);
    patchTab(id, { encoding: file.encoding, hasBom: file.hasBom });
    markSaved(id);
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

export function setLanguage(id: string, language: string) {
  const model = models.get(id);
  if (!model) return;
  monaco.editor.setModelLanguage(model, language);
  patchTab(id, { language });
}

export const findTabByPath = (path: string) => useTabs.getState().tabs.find((t) => t.path && samePath(t.path, path));

/** Re-read a clean tab after its file changed on disk; the reload is one undoable edit. */
export async function reloadFromDisk(id: string) {
  const tab = getTab(id);
  const model = models.get(id);
  if (!tab?.path || !model || tab.dirty) return;
  try {
    const file = await openFile(tab.path, tab.encoding);
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: file.content }], () => null);
    markSaved(id);
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

/**
 * Monitoring (tail -f): bring a clean tab in line with its file. Growth is appended, anything
 * else replaces the text. Not undoable — the tab is read-only while monitored.
 */
export async function followDisk(id: string) {
  const tab = getTab(id);
  const model = models.get(id);
  if (!tab?.path || !model || tab.dirty) return;
  const file = await openFile(tab.path, tab.encoding);
  // Line endings are normalised by the model, so compare in its EOL.
  const next = model.getEOL() === "\n" ? file.content.replace(/\r\n/g, "\n") : file.content.replace(/\r?\n/g, "\r\n");
  const old = model.getValue();
  if (next === old) return;
  if (next.startsWith(old)) {
    const end = model.getFullModelRange().getEndPosition();
    model.applyEdits([{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text: next.slice(old.length) }]);
  } else {
    model.applyEdits([{ range: model.getFullModelRange(), text: next }]);
  }
  markSaved(id);
}

/**
 * A file or folder was renamed/moved on disk: point open tabs at the new location.
 * Tabs inside a renamed folder follow it too.
 */
export function retargetTabs(from: string, to: string) {
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const f = norm(from);
  useTabs.setState((s) => ({
    tabs: s.tabs.map((t) => {
      if (!t.path) return t;
      const p = norm(t.path);
      if (p !== f && !p.startsWith(f + "/")) return t;
      const path = to + t.path.slice(from.length);
      return { ...t, path, title: baseName(path) };
    }),
  }));
  scheduleSessionSave();
}

/** Tabs whose file is `path` or lies inside folder `path`. */
export function tabsUnder(path: string): Tab[] {
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const f = norm(path);
  return useTabs.getState().tabs.filter((t) => t.path && (norm(t.path) === f || norm(t.path).startsWith(f + "/")));
}
