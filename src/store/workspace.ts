import { create } from "zustand";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { fsCopy, fsCreateDir, fsCreateFile, fsListDir, fsListFiles, fsRename, fsReveal, fsStat, fsTrash } from "../ipc";
import { useSettings } from "./settings";
import { activate, activeTab, closeTab, findTabByPath, openPaths, retargetTabs, tabsUnder, useTabs } from "./tabs";
import { ask, askText, errorMessage, notify, showQuickPick } from "./ui";
import { scheduleSessionSave } from "../session";
import { copyText } from "../clipboard";
import {
  ancestorsToReveal,
  baseName,
  Children,
  fuzzyFilter,
  invalidName,
  isInside,
  joinPath,
  parentDir,
  samePathish,
} from "../workspace/tree";

interface WorkspaceState {
  /** Folders open in the sidebar (Sublime "project folders"). */
  roots: string[];
  expanded: Record<string, boolean>;
  children: Record<string, Children>;
  sidebar: boolean;
  width: number;
  selected: string | null;
  /** Bumped to ask the tree to scroll `selected` into view. */
  revealTick: number;
}

export const useWorkspace = create<WorkspaceState>(() => ({
  roots: [],
  expanded: {},
  children: {},
  sidebar: true,
  width: 260,
  selected: null,
  revealTick: 0,
}));

const set = (patch: Partial<WorkspaceState> | ((s: WorkspaceState) => Partial<WorkspaceState>)) => {
  useWorkspace.setState(patch);
  scheduleSessionSave();
};

// ---- Loading

const inflight = new Map<string, Promise<void>>();

export function loadChildren(dir: string, force = false): Promise<void> {
  const have = useWorkspace.getState().children[dir];
  if (!force && have !== undefined && have !== "loading") return Promise.resolve();
  if (inflight.has(dir)) return inflight.get(dir)!;
  if (have === undefined) useWorkspace.setState((s) => ({ children: { ...s.children, [dir]: "loading" } }));
  const p = fsListDir(dir)
    .then((entries) => useWorkspace.setState((s) => ({ children: { ...s.children, [dir]: entries } })))
    .catch((e) => useWorkspace.setState((s) => ({ children: { ...s.children, [dir]: { error: errorMessage(e) } } })))
    .finally(() => inflight.delete(dir));
  inflight.set(dir, p);
  return p;
}

/** Re-read every loaded folder (or just `dir`), e.g. after the files changed outside the editor. */
export async function refresh(dir?: string) {
  const { children } = useWorkspace.getState();
  const dirs = dir ? [dir] : Object.keys(children);
  await Promise.all(dirs.map((d) => loadChildren(d, true)));
  fileListCache = null;
}

// ---- Folders

export function addRoot(path: string, expand = true) {
  const { roots } = useWorkspace.getState();
  if (roots.some((r) => samePathish(r, path))) {
    set((s) => ({ expanded: { ...s.expanded, [path]: true }, sidebar: true }));
  } else {
    set((s) => ({ roots: [...s.roots, path], expanded: expand ? { ...s.expanded, [path]: true } : s.expanded, sidebar: true }));
  }
  fileListCache = null;
  void loadChildren(path);
}

export function removeRoot(path: string) {
  set((s) => ({ roots: s.roots.filter((r) => !samePathish(r, path)) }));
  fileListCache = null;
}

/** Paths picked in a (possibly multi-select) folder dialog. */
async function pickFolders(): Promise<string[]> {
  const dir = await openDialog({ directory: true, multiple: true, defaultPath: useWorkspace.getState().roots[0] });
  if (!dir) return [];
  return Array.isArray(dir) ? dir : [dir];
}

/** File → Open Folder: replaces the sidebar folders with the chosen one(s). */
export async function openFolderDialog() {
  const dirs = await pickFolders();
  if (!dirs.length) return;
  set({ roots: [], expanded: {}, selected: null });
  for (const d of dirs) addRoot(d);
}

export async function addFolderDialog() {
  for (const d of await pickFolders()) addRoot(d);
}

/** Open files as tabs and folders in the sidebar (drag and drop, command line, "Open with"). */
export async function openAny(paths: string[]) {
  const files: string[] = [];
  for (const p of paths) {
    if ((await fsStat(p).catch(() => null)) === true) addRoot(p);
    else files.push(p);
  }
  if (files.length) await openPaths(files);
}

export function toggleSidebar() {
  set((s) => ({ sidebar: !s.sidebar }));
}

export function setSidebarWidth(width: number) {
  set({ width: Math.round(Math.min(800, Math.max(140, width))) });
}

export function toggleExpand(dir: string, open?: boolean) {
  const next = open ?? !useWorkspace.getState().expanded[dir];
  set((s) => ({ expanded: { ...s.expanded, [dir]: next } }));
  if (next) void loadChildren(dir);
}

export function select(path: string | null) {
  useWorkspace.setState({ selected: path });
}

/** Expand the folders down to `path`, select it and scroll it into view. False if outside the roots. */
export async function revealPath(path: string): Promise<boolean> {
  const chain = ancestorsToReveal(path, useWorkspace.getState().roots);
  if (!chain) return false;
  for (const dir of chain) {
    useWorkspace.setState((s) => ({ expanded: { ...s.expanded, [dir]: true } }));
    await loadChildren(dir);
  }
  set((s) => ({ selected: path, sidebar: true, revealTick: s.revealTick + 1 }));
  return true;
}

/** "Reveal in Side Bar": expand down to the active file and select it. */
export async function revealActive() {
  const path = activeTab()?.path;
  if (!path) return notify("This document isn't saved in a folder");
  if (!(await revealPath(path))) notify("The file isn't inside an open folder (File → Add Folder…)");
}

// ---- File operations (right-click menu, F2, Delete)

function promptName(title: string, initial: string, onName: (name: string) => Promise<void>) {
  askText(`${title}${initial ? ` (now: ${initial})` : ""}`, (text) => {
    const name = text.trim();
    const bad = invalidName(name);
    if (bad) return notify(bad, "error");
    onName(name).catch((e) => notify(errorMessage(e), "error"));
  });
}

export function newFileIn(dir: string) {
  promptName(`New file in ${baseName(dir)} — name (sub/folders allowed)`, "", async (name) => {
    const path = joinPath(dir, name.replace(/[\\/]+/g, dir.includes("\\") ? "\\" : "/"));
    await fsCreateFile(path);
    await afterChange(parentDir(path), dir);
    await openPaths([path]);
    await revealPath(path);
  });
}

export function newFolderIn(dir: string) {
  promptName(`New folder in ${baseName(dir)} — name`, "", async (name) => {
    const path = joinPath(dir, name);
    await fsCreateDir(path);
    await afterChange(parentDir(path), dir);
    await revealPath(path);
  });
}

export function renamePath(path: string) {
  const old = baseName(path);
  promptName(`Rename ${old} — new name`, old, async (name) => {
    if (name === old) return;
    const to = joinPath(parentDir(path), name);
    await fsRename(path, to);
    retargetTabs(path, to);
    // Keep expansion state of a renamed folder (and its sub-folders).
    useWorkspace.setState((s) => {
      const expanded: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(s.expanded)) expanded[isInside(k, path) ? to + k.slice(path.length) : k] = v;
      return { expanded, roots: s.roots.map((r) => (samePathish(r, path) ? to : r)) };
    });
    await afterChange(parentDir(path));
    await revealPath(to);
  });
}

export async function deletePath(path: string, isDir: boolean) {
  const open = tabsUnder(path);
  const dirty = open.filter((t) => t.dirty);
  const choice = await ask(
    `Move ${isDir ? "folder" : "file"} "${baseName(path)}" to the Recycle Bin?`,
    dirty.length
      ? `${dirty.length} open document(s) inside have unsaved changes; they stay open as unsaved tabs.`
      : "You can restore it from the Recycle Bin.",
    [
      { id: "delete", label: "Move to Recycle Bin", primary: true },
      { id: "cancel", label: "Cancel" },
    ],
  );
  if (choice !== "delete") return;
  try {
    await fsTrash(path);
  } catch (e) {
    return notify(errorMessage(e), "error");
  }
  // Clean tabs of deleted files close; unsaved work stays open.
  for (const t of open) if (!t.dirty) await closeTab(t.id);
  if (useWorkspace.getState().roots.some((r) => samePathish(r, path))) removeRoot(path);
  await afterChange(parentDir(path));
  select(null);
}

async function afterChange(...dirs: string[]) {
  fileListCache = null;
  for (const d of new Set(dirs)) await loadChildren(d, true);
}

/**
 * Drag and drop in the tree: move (or copy) `src` into folder `targetDir`. Never overwrites;
 * open tabs follow a move.
 */
export async function moveOrCopy(src: string, targetDir: string, copy: boolean) {
  const to = joinPath(targetDir, baseName(src));
  if (!copy && useSettings.getState().confirmDragMove) {
    const choice = await ask(`Move "${baseName(src)}" into "${baseName(targetDir)}"?`, to, [
      { id: "move", label: "Move", primary: true },
      { id: "always", label: "Move, don't ask again" },
      { id: "cancel", label: "Cancel" },
    ]);
    if (choice === "cancel") return;
    if (choice === "always") useSettings.getState().update({ confirmDragMove: false });
  }
  try {
    if (copy) await fsCopy(src, to);
    else await fsRename(src, to);
  } catch (e) {
    return notify(errorMessage(e), "error");
  }
  if (!copy) {
    retargetTabs(src, to);
    useWorkspace.setState((s) => {
      const expanded: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(s.expanded)) expanded[isInside(k, src) ? to + k.slice(src.length) : k] = v;
      return { expanded };
    });
  }
  await afterChange(parentDir(src), targetDir);
  await revealPath(to);
  notify(`${copy ? "Copied" : "Moved"} ${baseName(src)} to ${baseName(targetDir)}`);
}

export async function copyPathOf(path: string) {
  await copyText(path);
  notify(`Copied: ${path}`);
}

export const revealInExplorer = (path: string) => fsReveal(path).catch((e) => notify(errorMessage(e), "error"));

// ---- Goto Anything (Ctrl+P)

let fileListCache: { at: number; files: string[]; truncated: boolean } | null = null;
const FILE_LIMIT = 100_000;

async function allFiles() {
  const { roots } = useWorkspace.getState();
  // Re-scan at most every 10 s; file operations in the sidebar reset this.
  if (!fileListCache || Date.now() - fileListCache.at > 10_000) {
    const r = await fsListFiles(roots, FILE_LIMIT);
    fileListCache = { at: Date.now(), ...r };
  }
  return fileListCache;
}

const relative = (path: string, roots: string[]) => {
  const root = roots.find((r) => isInside(path, r));
  if (!root) return path;
  const rel = path.slice(root.length).replace(/^[\\/]/, "");
  return roots.length > 1 ? `${baseName(root)}/${rel}` : rel;
};

export async function gotoAnything() {
  const { roots } = useWorkspace.getState();
  // Without folders, Ctrl+P switches between open tabs.
  if (!roots.length) {
    const { tabs } = useTabs.getState();
    const items = tabs.map((t) => ({ id: t.id, label: t.title, detail: t.path ?? "unsaved" }));
    return showQuickPick({
      placeholder: "Go to open document (File → Open Folder… to search a project)",
      items,
      filter: (q) => fuzzyFilter(q, items, (i) => `${i.detail}/${i.label}`),
      onPick: (it) => activate(it.id),
    });
  }
  let list: Awaited<ReturnType<typeof allFiles>>;
  try {
    list = await allFiles();
  } catch (e) {
    return notify(errorMessage(e), "error");
  }
  const items = list.files.map((f) => ({ id: f, label: baseName(f), detail: relative(parentDir(f), roots) }));
  showQuickPick({
    placeholder: `Go to file in ${roots.map(baseName).join(", ")}${list.truncated ? ` (first ${FILE_LIMIT.toLocaleString()} files)` : ""}`,
    items,
    // Match the path inside the project only: the folders above it would match almost anything.
    filter: (q) => fuzzyFilter(q, items, (i) => (i.detail ? `${i.detail}/${i.label}` : i.label)),
    onPick: (it) => {
      const existing = findTabByPath(it.id);
      if (existing) activate(existing.id);
      else void openPaths([it.id]);
    },
  });
}

/** Default folder for Find in Files: the open folder containing the active file, else the first. */
export function searchRoot(): string | null {
  const { roots } = useWorkspace.getState();
  const path = activeTab()?.path;
  return (path && roots.find((r) => isInside(path, r))) || roots[0] || null;
}

// ---- Session

export interface WorkspaceSession {
  roots: string[];
  expanded: string[];
  sidebar: boolean;
  width: number;
}

export function workspaceSnapshot(): WorkspaceSession {
  const s = useWorkspace.getState();
  return { roots: s.roots, expanded: Object.keys(s.expanded).filter((k) => s.expanded[k]), sidebar: s.sidebar, width: s.width };
}

export async function restoreWorkspace(w: WorkspaceSession | undefined) {
  if (!w) return;
  // Folders that disappeared since last time are dropped quietly.
  const roots: string[] = [];
  for (const r of w.roots) if ((await fsStat(r).catch(() => null)) === true) roots.push(r);
  useWorkspace.setState({
    roots,
    expanded: Object.fromEntries(w.expanded.map((k) => [k, true])),
    sidebar: w.sidebar,
    width: w.width || 260,
  });
  for (const r of roots) void loadChildren(r);
}
