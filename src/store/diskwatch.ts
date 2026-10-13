import { getCurrentWindow } from "@tauri-apps/api/window";
import { fileSig } from "../ipc";
import { activate, getTab, isSaving, reloadFromDisk, setAfterSave, useTabs } from "./tabs";
import { isMonitored } from "./monitor";
import { ask, notify } from "./ui";

/**
 * Files changed by other programs (Notepad++ "auto-detect file changes"): clean tabs reload
 * silently, tabs with unsaved edits ask first. Visible tabs are checked every two seconds,
 * all tabs when the window gets focus. Big-file and hex tabs have their own follow logic.
 */

/** Last seen [size, mtime] per tab; the first check only records it. */
const sigs = new Map<string, string>();
const checking = new Set<string>();

async function check(id: string) {
  const tab = getTab(id);
  if (!tab?.path || tab.big || tab.hex || isMonitored(id) || isSaving(id) || checking.has(id)) return;
  checking.add(id);
  try {
    const sig = await fileSig(tab.path).catch(() => null);
    // A save may have started while the stat was in flight.
    if (!sig || isSaving(id)) return;
    const key = sig.join(":");
    const prev = sigs.get(id);
    sigs.set(id, key);
    if (prev === undefined || prev === key) return;
    if (!getTab(id)?.dirty) {
      await reloadFromDisk(id);
      return;
    }
    activate(id);
    const choice = await ask(`"${tab.title}" was changed by another program.`, "Reload it and lose your unsaved changes here?", [
      { id: "reload", label: "Reload", primary: true },
      { id: "keep", label: "Keep My Version" },
    ]);
    if (choice === "reload") await reloadFromDisk(id, true);
  } finally {
    checking.delete(id);
  }
}

/** File → Reload from Disk. */
export async function reloadTab(id: string) {
  const tab = getTab(id);
  if (!tab?.path || tab.big || tab.hex) return notify("Nothing to reload");
  if (tab.dirty) {
    const choice = await ask(`Reload "${tab.title}" from disk?`, "Your unsaved changes will be lost.", [
      { id: "reload", label: "Reload", primary: true },
      { id: "cancel", label: "Cancel" },
    ]);
    if (choice !== "reload") return;
  }
  if (!(await reloadFromDisk(id, true))) notify("Already up to date");
}

const visibleIds = () => {
  const ids = new Set<string>();
  for (const g of useTabs.getState().groups) if (g.activeId) ids.add(g.activeId);
  return ids;
};

function checkAll(ids: Iterable<string>) {
  for (const id of ids) void check(id);
  // Forget closed tabs.
  const open = new Set(useTabs.getState().tabs.map((t) => t.id));
  for (const id of sigs.keys()) if (!open.has(id)) sigs.delete(id);
}

// Our own saves change the file too: take the new size/mtime as the baseline.
setAfterSave(async (id) => {
  const path = getTab(id)?.path;
  const sig = path ? await fileSig(path).catch(() => null) : null;
  if (sig) sigs.set(id, sig.join(":"));
});

let tick = 0;
setInterval(() => {
  // Visible tabs every 2 s, every tab every 20 s (baselines for tabs not yet shown).
  tick++;
  checkAll(tick % 10 === 0 ? useTabs.getState().tabs.map((t) => t.id) : visibleIds());
}, 2000);
void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
  if (focused) checkAll(useTabs.getState().tabs.map((t) => t.id));
});
