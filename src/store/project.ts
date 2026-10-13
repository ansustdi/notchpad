/**
 * Projects (Sublime `.sublime-project` files): a named set of folders, each with its own
 * session (open tabs, unsaved buffers, layout) kept in app data.
 */

import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { fsStat, openFile, saveFile } from "../ipc";
import { useSettings } from "./settings";
import { newUntitled, openPaths, resetAllTabs, useTabs } from "./tabs";
import { addRoot, openAny, useWorkspace } from "./workspace";
import { errorMessage, notify, showQuickPick } from "./ui";
import { restoreSession, saveSessionNow } from "../session";
import { isSecondary, mainOnly } from "../instance";
import { parseProject, PROJECT_EXT, projectName, serializeProject } from "../workspace/project";
import { baseName, samePathish } from "../workspace/tree";

const RECENT_MAX = 15;

export const currentProjectName = () => {
  if (isSecondary()) return null;
  const p = useSettings.getState().currentProject;
  return p ? projectName(p) : null;
};

function remember(path: string | null) {
  const s = useSettings.getState();
  const recent = path ? [path, ...s.recentProjects.filter((r) => !samePathish(r, path))].slice(0, RECENT_MAX) : s.recentProjects;
  s.update({ currentProject: path, recentProjects: recent });
}

async function readProject(path: string) {
  const file = await openFile(path);
  return parseProject(file.content, path);
}

/** Put the sidebar folders back to the project file's list (the file is the source of truth). */
function applyFolders(folders: string[]) {
  const keepExpanded = useWorkspace.getState().expanded;
  useWorkspace.setState({ roots: [], children: {}, selected: null });
  for (const f of folders) addRoot(f, keepExpanded[f] ?? true);
}

/**
 * Leave the current project (or the default session) and load `target` (null = no project).
 * The current state, unsaved buffers included, is saved to its own session first.
 */
async function switchTo(target: string | null, folders: string[]) {
  await saveSessionNow();
  syncPaused = true;
  try {
    resetAllTabs();
    useWorkspace.setState({ roots: [], expanded: {}, children: {}, selected: null });
    remember(target);
    await restoreSession();
    if (target) applyFolders(folders);
    if (useTabs.getState().tabs.length === 0) newUntitled();
  } finally {
    syncPaused = false;
    lastWritten = useWorkspace.getState().roots.join("\n");
  }
}

export async function openProject(path: string) {
  if (!mainOnly()) return;
  let folders: string[];
  try {
    folders = (await readProject(path)).folders.map((f) => f.path);
  } catch (e) {
    return notify(`Can't open project: ${errorMessage(e)}`, "error");
  }
  if (samePathish(useSettings.getState().currentProject ?? "", path)) {
    applyFolders(folders);
    return;
  }
  await switchTo(path, folders);
  notify(`Project: ${projectName(path)}`);
}

export async function openProjectDialog() {
  if (!mainOnly()) return;
  const picked = await openDialog({ filters: [{ name: "Project", extensions: [PROJECT_EXT] }], multiple: false });
  if (typeof picked === "string") await openProject(picked);
}

/** Save the current folders as a project file; the current tabs become that project's session. */
export async function saveProjectAs() {
  if (!mainOnly()) return;
  const { roots } = useWorkspace.getState();
  if (!roots.length) return notify("Open a folder first (File → Open Folder…)");
  const current = useSettings.getState().currentProject;
  const picked = await saveDialog({
    defaultPath: current ?? `${roots[0]}${roots[0].includes("\\") ? "\\" : "/"}${baseName(roots[0])}.${PROJECT_EXT}`,
    filters: [{ name: "Project", extensions: [PROJECT_EXT] }],
  });
  if (!picked) return;
  const existing = (await fsStat(picked).catch(() => null)) === false ? (await openFile(picked).catch(() => null))?.content : undefined;
  try {
    await saveFile({ path: picked, content: serializeProject(roots, picked, existing), encoding: "UTF-8", hasBom: false, eol: "LF" });
  } catch (e) {
    return notify(errorMessage(e), "error");
  }
  remember(picked);
  lastWritten = roots.join("\n");
  await saveSessionNow();
  notify(`Saved project ${projectName(picked)}`);
}

export async function closeProject() {
  if (!mainOnly()) return;
  if (!useSettings.getState().currentProject) return notify("No project is open");
  await switchTo(null, []);
  notify("Project closed");
}

export async function editProject() {
  const p = useSettings.getState().currentProject;
  if (!p) return notify("No project is open");
  await openPaths([p]);
}

/** Recent projects (Sublime: Project → Quick Switch Project, Ctrl+Alt+P). */
export function switchProject() {
  if (!mainOnly()) return;
  const { recentProjects, currentProject } = useSettings.getState();
  showQuickPick({
    placeholder: "Switch project",
    items: [
      ...recentProjects.map((p) => ({ id: p, label: projectName(p), detail: p })),
      { id: "__open", label: "Open Project…", detail: `.${PROJECT_EXT} file` },
      ...(currentProject ? [{ id: "__close", label: "Close Project" }] : []),
    ],
    activeId: currentProject ?? undefined,
    onPick: async (it) => {
      if (it.id === "__open") return void openProjectDialog();
      if (it.id === "__close") return void closeProject();
      if ((await fsStat(it.id).catch(() => null)) === null) {
        useSettings.getState().update({ recentProjects: recentProjects.filter((r) => r !== it.id) });
        return notify(`${it.id} no longer exists; removed from the list`, "error");
      }
      await openProject(it.id);
    },
  });
}

// ---- Keep the project file's folder list in step with the side bar (as Sublime does)

let syncPaused = false;
let lastWritten = "";
let timer: ReturnType<typeof setTimeout> | undefined;

useWorkspace.subscribe((s, prev) => {
  if (s.roots === prev.roots || syncPaused || isSecondary()) return;
  const project = useSettings.getState().currentProject;
  const key = s.roots.join("\n");
  if (!project || key === lastWritten) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      const existing = (await openFile(project)).content;
      await saveFile({ path: project, content: serializeProject(s.roots, project, existing), encoding: "UTF-8", hasBom: false, eol: "LF" });
      lastWritten = key;
    } catch (e) {
      notify(`Couldn't update project file: ${errorMessage(e)}`, "error");
    }
  }, 500);
});

/** At start-up: reopen the last project's folders (its session was restored already). */
export async function restoreProjectFolders() {
  const project = useSettings.getState().currentProject;
  if (!project) return;
  try {
    const parsed = await readProject(project);
    syncPaused = true;
    applyFolders(parsed.folders.map((f) => f.path));
  } catch {
    // Project file gone: carry on without a project.
    remember(null);
  } finally {
    syncPaused = false;
    lastWritten = useWorkspace.getState().roots.join("\n");
  }
}

export const isProjectFile = (path: string) => path.toLowerCase().endsWith(`.${PROJECT_EXT}`);

/** Drag and drop / command line / "Open with": project files open as projects. */
export async function openAnything(paths: string[]) {
  const project = paths.find(isProjectFile);
  if (project) await openProject(project);
  const rest = paths.filter((p) => p !== project);
  if (rest.length) await openAny(rest);
}
