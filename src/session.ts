import { readAppFile, writeAppFile, Eol, openFile, type AppFile } from "./ipc";
import { useSettings } from "./store/settings";
import { projectId } from "./workspace/project";

/** Where the session lives: one per project (like .sublime-workspace), else the global one. */
export function sessionSlot(): AppFile {
  const project = useSettings.getState().currentProject;
  return project ? `projects/${projectId(project)}.json` : "session.json";
}
import {
  anyViewState,
  createTab,
  getModel,
  Group,
  openBig,
  Orientation,
  restoreLayout,
  setViewState,
  Tab,
  useTabs,
} from "./store/tabs";
import { getBigView } from "./store/bigview";
import { getEditor } from "./editorRef";
import { monaco } from "./monaco";
import { getBookmarks, setBookmarks } from "./bookmarks";
import { restoreWorkspace, workspaceSnapshot, type WorkspaceSession } from "./store/workspace";

interface SessionTab {
  id: string;
  path: string | null;
  title: string;
  language: string;
  encoding: string;
  hasBom: boolean;
  eol: Eol;
  dirty: boolean;
  pinned?: boolean;
  /** Present for untitled and dirty tabs: the unsaved buffer itself. */
  content?: string;
  viewState?: monaco.editor.ICodeEditorViewState | null;
  bookmarks?: number[];
  big?: boolean;
  /** Big-file tabs: first visible line. */
  bigTop?: number;
}

interface Session {
  version: 1;
  activeId: string | null;
  untitledCounter: number;
  tabs: SessionTab[];
  /** Folders in the sidebar. */
  workspace?: WorkspaceSession;
  /** Editor groups; missing in sessions saved before split view existed. */
  layout?: { groups: Group[]; activeGroup: string; orientation: Orientation };
}

const SAVE_DELAY_MS = 1000;
let timer: ReturnType<typeof setTimeout> | null = null;
let restoring = false;

export function scheduleSessionSave() {
  if (restoring) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void saveSessionNow(), SAVE_DELAY_MS);
}

function snapshot(): Session {
  const { tabs, activeId, untitledCounter, groups, activeGroup, orientation } = useTabs.getState();
  // Capture live scroll/cursor of every visible editor.
  for (const g of groups) {
    const editor = getEditor(g.id);
    if (editor && g.activeId && editor.getModel()) setViewState(g.id, g.activeId, editor.saveViewState());
  }
  return {
    version: 1,
    activeId,
    untitledCounter,
    tabs: tabs.map((t: Tab) => ({
      ...t,
      content: t.dirty || !t.path ? getModel(t.id)?.getValue() : undefined,
      viewState: anyViewState(t.id),
      bookmarks: getBookmarks(t.id),
      bigTop: t.big ? getBigView(t.id)?.top : undefined,
    })),
    layout: { groups, activeGroup, orientation },
    workspace: workspaceSnapshot(),
  };
}

export async function saveSessionNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  try {
    await writeAppFile(sessionSlot(), JSON.stringify(snapshot()));
  } catch (e) {
    console.error("session save failed", e);
  }
}

/** Restore tabs from the last run. Clean file tabs are re-read from disk so external edits show up. */
export async function restoreSession() {
  let session: Session;
  try {
    const raw = await readAppFile(sessionSlot());
    if (!raw) return;
    session = JSON.parse(raw);
    if (session.version !== 1) return;
  } catch (e) {
    console.error("session load failed", e);
    return;
  }

  restoring = true;
  try {
    await restoreWorkspace(session.workspace);
    const disk = await Promise.all(
      session.tabs.map((t) => (t.content === undefined && t.path && !t.big ? openFile(t.path).catch(() => null) : null)),
    );
    useTabs.setState({ untitledCounter: session.untitledCounter });
    // Documents are created unplaced; the saved layout puts them into groups afterwards.
    for (const [i, t] of session.tabs.entries()) {
      if (t.big) {
        if (t.path) await openBig(t.path, { id: t.id, group: null, top: t.bigTop ?? 0 }).catch(() => {});
        continue;
      }
      const file = disk[i];
      if (t.content === undefined && !file) continue; // file vanished and nothing unsaved to keep
      createTab(
        {
          id: t.id,
          path: t.path,
          title: t.title,
          language: t.language,
          encoding: file?.encoding ?? t.encoding,
          hasBom: file?.hasBom ?? t.hasBom,
          eol: file?.eol ?? t.eol,
          content: t.content ?? file!.content,
          dirty: t.dirty,
          pinned: t.pinned,
        },
        { group: null },
      );
      if (t.bookmarks?.length) setBookmarks(t.id, t.bookmarks);
    }
    const layout = session.layout ?? {
      groups: [{ id: "g1", tabIds: session.tabs.map((t) => t.id), activeId: session.activeId, size: 1 }],
      activeGroup: "g1",
      orientation: "columns" as Orientation,
    };
    restoreLayout(layout);
    for (const t of session.tabs) {
      if (!t.viewState) continue;
      for (const g of useTabs.getState().groups) if (g.tabIds.includes(t.id)) setViewState(g.id, t.id, t.viewState);
    }
  } finally {
    restoring = false;
  }
}
