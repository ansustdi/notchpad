import { pasteText } from "../clipboard";
import { create } from "zustand";
import { monaco } from "../monaco";
import { openFile } from "../ipc";
import { activeTab, getModel, useTabs } from "./tabs";
import { errorMessage, notify, showQuickPick } from "./ui";

export interface DiffSide {
  title: string;
  model: monaco.editor.ITextModel;
  /** Temporary model (disk / clipboard snapshot) owned by the diff view. */
  temp: boolean;
}

interface DiffState {
  left: DiffSide | null;
  right: DiffSide | null;
  sideBySide: boolean;
  ignoreWhitespace: boolean;
}

export const useDiff = create<DiffState>(() => ({ left: null, right: null, sideBySide: true, ignoreWhitespace: false }));

/**
 * Temp models that are no longer shown. They're disposed by the diff view only after it has
 * detached them; disposing a model the diff widget still holds throws.
 */
let stale: monaco.editor.ITextModel[] = [];

function retireTemps() {
  const { left, right } = useDiff.getState();
  for (const side of [left, right]) if (side?.temp) stale.push(side.model);
}

export function disposeStaleTemps() {
  const keep = new Set([useDiff.getState().left?.model, useDiff.getState().right?.model]);
  for (const m of stale) if (!keep.has(m) && !m.isDisposed()) m.dispose();
  stale = [];
}

export function openDiff(left: DiffSide, right: DiffSide) {
  retireTemps();
  useDiff.setState({ left, right });
}

export function closeDiff() {
  retireTemps();
  useDiff.setState({ left: null, right: null });
}

export function swapDiff() {
  const { left, right } = useDiff.getState();
  if (left && right) useDiff.setState({ left: right, right: left });
}

function activeTextSide(): DiffSide | null {
  const tab = activeTab();
  const model = tab && getModel(tab.id);
  if (!tab || !model) {
    notify("Compare works on text documents (not big-file tabs)");
    return null;
  }
  return { title: tab.title, model, temp: false };
}

/** Compare the active document (right) with another open document (left). */
export function compareWithTab() {
  const right = activeTextSide();
  if (!right) return;
  const others = useTabs
    .getState()
    .tabs.filter((t) => getModel(t.id) && getModel(t.id) !== right.model)
    .map((t) => ({ id: t.id, label: t.title, detail: t.path ?? "unsaved" }));
  if (!others.length) return notify("Open another document to compare with");
  showQuickPick({
    placeholder: `Compare "${right.title}" with…`,
    items: others,
    onPick: (item) => {
      const tab = useTabs.getState().tabs.find((t) => t.id === item.id);
      const model = getModel(item.id);
      if (tab && model) openDiff({ title: tab.title, model, temp: false }, right);
    },
  });
}

/** Unsaved changes: the file on disk (left) vs the buffer (right). */
export async function compareWithSaved() {
  const right = activeTextSide();
  const tab = activeTab();
  if (!right || !tab) return;
  if (!tab.path) return notify("This document has never been saved");
  try {
    const file = await openFile(tab.path, tab.encoding);
    const model = monaco.editor.createModel(file.content, right.model.getLanguageId());
    openDiff({ title: `${tab.title} (on disk)`, model, temp: true }, { ...right, title: `${tab.title} (editor)` });
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

export async function compareWithClipboard() {
  const right = activeTextSide();
  if (!right) return;
  let text: string;
  try {
    text = await pasteText();
  } catch {
    return notify("Couldn't read the clipboard", "error");
  }
  const model = monaco.editor.createModel(text, right.model.getLanguageId());
  openDiff({ title: "Clipboard", model, temp: true }, right);
}
