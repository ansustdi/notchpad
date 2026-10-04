import type { monaco } from "./monaco";
import { useTabs } from "./store/tabs";

/** One Monaco editor per editor group. */
const editors = new Map<string, monaco.editor.IStandaloneCodeEditor>();

export const setEditor = (groupId: string, e: monaco.editor.IStandaloneCodeEditor | null) => {
  if (e) editors.set(groupId, e);
  else editors.delete(groupId);
};

/** Editor of the active group (or of `groupId`). */
export const getEditor = (groupId = useTabs.getState().activeGroup) => editors.get(groupId) ?? null;

export const allEditors = () => [...editors.values()];

export function runEditorAction(actionId: string) {
  const editor = getEditor();
  if (!editor) return;
  editor.focus();
  editor.getAction(actionId)?.run();
}
