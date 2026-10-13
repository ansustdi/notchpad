import { create } from "zustand";
import { fileSig } from "../ipc";
import { allEditors } from "../editorRef";
import { followDisk, getModel, getTab } from "./tabs";
import { getBigView, toggleBigFollow } from "./bigview";
import { errorMessage, notify } from "./ui";

/**
 * Monitoring (tail -f), like Notepad++: a monitored text tab is read-only, reloads whenever its
 * file changes and stays scrolled to the end. Big-file tabs use their own Follow mode instead.
 */
export const useMonitor = create<{ ids: string[] }>(() => ({ ids: [] }));

/** Last seen [size, mtime] per monitored tab. */
const sigs = new Map<string, string>();

export const isMonitored = (id: string) => useMonitor.getState().ids.includes(id);

function stop(id: string) {
  sigs.delete(id);
  useMonitor.setState((s) => ({ ids: s.ids.filter((x) => x !== id) }));
}

function scrollToEnd(id: string) {
  const model = getModel(id);
  if (!model) return;
  const line = model.getLineCount();
  for (const editor of allEditors()) {
    if (editor.getModel() !== model) continue;
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.revealLine(line);
  }
}

async function poll(id: string, force = false) {
  const tab = getTab(id);
  if (!tab?.path || !getModel(id)) return stop(id);
  const sig = await fileSig(tab.path).catch(() => null);
  // Missing (rotated / being recreated): keep waiting, like tail -F.
  if (!sig) return;
  const key = sig.join(":");
  if (!force && sigs.get(id) === key) return;
  sigs.set(id, key);
  await followDisk(id);
  scrollToEnd(id);
}

export async function toggleMonitoring(id: string) {
  const tab = getTab(id);
  if (!tab) return;
  if (getBigView(id)) return void toggleBigFollow(id);
  if (isMonitored(id)) return stop(id);
  if (!tab.path || tab.hex) return notify("Monitoring needs a file saved on disk", "error");
  if (tab.dirty) return notify("Save or revert the file before monitoring it", "error");
  useMonitor.setState((s) => ({ ids: [...s.ids, id] }));
  try {
    await poll(id, true);
  } catch (e) {
    stop(id);
    notify(errorMessage(e), "error");
  }
}

// Polling (not a watcher): same on every OS, works on network shares, survives log rotation.
let busy = false;
setInterval(() => {
  if (busy) return;
  const ids = useMonitor.getState().ids;
  if (!ids.length) return;
  busy = true;
  void Promise.all(ids.map((id) => poll(id).catch(() => {}))).finally(() => (busy = false));
}, 1000);
