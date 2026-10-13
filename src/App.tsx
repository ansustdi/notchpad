import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { MenuBar } from "./components/MenuBar";
import { EditorGroups } from "./components/EditorGroups";
import { DiffView } from "./components/DiffView";
import { useDiff } from "./store/diff";
import { useThemeSync } from "./components/EditorHost";
import { installWheelZoom } from "./zoom";
import { StatusBar } from "./components/StatusBar";
import { Overlays } from "./components/Overlays";
import { BottomPanel } from "./components/BottomPanel";
import { Sidebar } from "./components/Sidebar";
import { refresh as refreshFolders, useWorkspace } from "./store/workspace";
import { currentProjectName, openAnything, restoreProjectFolders } from "./store/project";
import { commandForEvent, runCommand } from "./commands/registry";
import { loadSettings } from "./store/settings";
import { askSave, isModalOpen } from "./store/ui";
import { activate, newUntitled, saveTab, setActiveGroup, useTabs } from "./store/tabs";
import { restoreSession, saveSessionNow } from "./session";
import { startupFiles } from "./ipc";
import { isMac } from "./platform";
import { initInstance, isSecondary } from "./instance";

let initialized = false;

async function init() {
  if (initialized) return;
  initialized = true;
  await loadSettings();
  installWheelZoom();
  await initInstance();
  // Extra windows (File → New Instance, Move to New Instance) start without the session.
  if (!isSecondary()) {
    await restoreSession();
    await restoreProjectFolders();
  }
  // Files open as tabs, folders in the sidebar.
  const files = await startupFiles().catch(() => []);
  if (files.length) await openAnything(files);
  if (useTabs.getState().tabs.length === 0) newUntitled();
}

const TREE_KEYS = new Set(["F2", "Delete", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

/** Browser shortcuts that make no sense in a desktop editor (reload, print, caret browsing…). */
/** Commands whose keys still work while the terminal has focus. */
const TERMINAL_PASSTHROUGH = new Set(["terminal.toggle", "terminal.new", "view.palette", "file.gotoAnything", "view.sidebar", "run.file"]);

function isBrowserShortcut(e: KeyboardEvent): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const k = e.key.toLowerCase();
  return e.key === "F5" || e.key === "F7" || (mod && (k === "r" || k === "p" || k === "j" || k === "u"));
}

export default function App() {
  const [dropping, setDropping] = useState(false);
  useThemeSync();
  const diffOpen = useDiff((s) => s.left !== null);
  const sidebar = useWorkspace((s) => s.sidebar);

  useEffect(() => {
    void init();

    const onKey = (e: KeyboardEvent) => {
      if (isModalOpen()) return;
      // The folder tree owns its navigation keys (F2 = rename there, not "next bookmark").
      if ((e.target as HTMLElement | null)?.closest?.(".sb-tree") && TREE_KEYS.has(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) return;
      const cmd = commandForEvent(e);
      // The terminal gets every key (Ctrl+F, F2, … mean something to the shell) except a few.
      if ((e.target as HTMLElement | null)?.closest?.(".term-host") && !(cmd && TERMINAL_PASSTHROUGH.has(cmd.id))) {
        // Still no webview reload on F5 / Ctrl+R; xterm sees the key regardless.
        if (import.meta.env.PROD && isBrowserShortcut(e)) e.preventDefault();
        return;
      }
      if (cmd) {
        e.preventDefault();
        e.stopPropagation();
        runCommand(cmd.id);
      } else if (import.meta.env.PROD && isBrowserShortcut(e)) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey, true);

    const onContext = (e: MouseEvent) => {
      // Keep Monaco's own context menu; hide the webview's "Reload / Inspect" menu elsewhere.
      if (import.meta.env.PROD && !(e.target as HTMLElement).closest(".monaco-editor")) e.preventDefault();
    };
    window.addEventListener("contextmenu", onContext);

    const win = getCurrentWindow();
    const unlisteners = [
      win.onCloseRequested(async (event) => {
        // Text buffers survive in the session; hex edits don't, so ask about those.
        // Extra instances keep no session: ask about every unsaved tab.
        const secondary = isSecondary();
        for (const tab of useTabs.getState().tabs.filter((t) => t.dirty && (secondary || t.hex))) {
          activate(tab.id);
          const choice = await askSave(`Save changes to "${tab.title}"?`);
          if (choice === "cancel" || (choice === "save" && !(await saveTab(tab.id)))) {
            event.preventDefault();
            return;
          }
        }
        await saveSessionNow();
      }),
      // A second launch ("Open with" while running) forwards its files here instead of opening a window.
      listen<string[]>("open-files", (e) => void openAnything(e.payload)),
      // Pick up files created / deleted outside the editor when coming back to it.
      win.onFocusChanged(({ payload: focused }) => {
        if (focused) void refreshFolders();
      }),
      getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") setDropping(true);
        else setDropping(false);
        if (p.type === "drop" && p.paths.length) {
          // Open into the group under the drop point.
          const x = p.position.x / window.devicePixelRatio;
          const y = p.position.y / window.devicePixelRatio;
          const group = document.elementFromPoint(x, y)?.closest<HTMLElement>(".editor-group")?.dataset.group;
          if (group) setActiveGroup(group);
          void openAnything(p.paths);
        }
      }),
    ];

    const unsubTitle = useTabs.subscribe((s) => {
      const tab = s.tabs.find((t) => t.id === s.activeId);
      const roots = useWorkspace.getState().roots;
      const name = currentProjectName();
      const project = name ? ` (${name})` : roots.length ? ` (${roots.map((r) => r.split(/[\\/]/).pop()).join(", ")})` : "";
      const title = tab ? `${tab.dirty ? "● " : ""}${tab.path ?? tab.title}${project} - NotchPad` : "NotchPad";
      if (document.title !== title) {
        document.title = title;
        void win.setTitle(title);
      }
    });

    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("contextmenu", onContext);
      unlisteners.forEach((p) => p.then((un) => un()));
      unsubTitle();
    };
  }, []);

  return (
    <div className="app">
      <MenuBar />
      <div className="main">
        {sidebar && <Sidebar />}
        <div className="main-col">
          <div className="workspace">
            <EditorGroups />
            {diffOpen && <DiffView />}
          </div>
          <BottomPanel />
        </div>
      </div>
      <StatusBar />
      <Overlays />
      {dropping && <div className="drop-hint">Drop files or folders to open</div>}
    </div>
  );
}
