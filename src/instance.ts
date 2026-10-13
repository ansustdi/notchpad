import { instanceSecondary, spawnInstance } from "./ipc";
import { activate, closeTab, getTab, groupsOf, saveTab } from "./store/tabs";
import { askSave, errorMessage, notify } from "./store/ui";

/**
 * Multiple instances, like Notepad++: the main window owns the session and projects; extra
 * windows (started with --new-instance) start empty and save nothing when they close.
 */
let secondary = false;

export async function initInstance() {
  secondary = await instanceSecondary().catch(() => false);
}

export const isSecondary = () => secondary;

/** Projects and sessions belong to the main window only. */
export function mainOnly(): boolean {
  if (secondary) notify("Projects are only available in the main window");
  return !secondary;
}

export async function newInstance() {
  try {
    await spawnInstance([]);
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

/** Open the tab's file in a new window too. */
export async function openInNewInstance(id: string) {
  const tab = getTab(id);
  if (!tab?.path) return notify("Save the file first", "error");
  try {
    await spawnInstance([tab.path]);
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

/** Notepad++ "Move to New Instance": open the file in a new window and close it here. */
export async function moveToNewInstance(id: string) {
  const tab = getTab(id);
  if (!tab?.path) return notify("Save the file first", "error");
  if (tab.dirty) {
    activate(id);
    const choice = await askSave(`Save changes to "${tab.title}" before moving it?`);
    if (choice === "cancel" || (choice === "save" && !(await saveTab(id)))) return;
  }
  try {
    await spawnInstance([tab.path]);
  } catch (e) {
    return notify(errorMessage(e), "error");
  }
  // "Don't Save" was already answered: close without asking again.
  for (const g of groupsOf(id)) await closeTab(id, g.id, true);
}
