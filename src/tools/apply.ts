import { monaco } from "../monaco";
import { getEditor } from "../editorRef";
import { activeTab } from "../store/tabs";
import { notify } from "../store/ui";
import { JsonError } from "./json";
import { XmlError } from "./xml";

type Positioned = JsonError | XmlError;
const isPositioned = (e: unknown): e is Positioned => e instanceof JsonError || e instanceof XmlError;

/** The text a tool works on: each non-empty selection, or the whole document when none. */
function targets(editor: monaco.editor.IStandaloneCodeEditor, model: monaco.editor.ITextModel) {
  const sels = (editor.getSelections() ?? []).filter((s) => !s.isEmpty());
  return sels.length ? sels.map((s) => monaco.Range.lift(s)) : [model.getFullModelRange()];
}

/**
 * Replace each target with `fn(text)` as one undo step. On a positioned parse error,
 * move the caret to the offending spot and say what's wrong.
 */
export function transformText(label: string, fn: (text: string) => string): boolean {
  const editor = getEditor();
  const model = editor?.getModel();
  if (!editor || !model || activeTab()?.big) {
    notify(`${label}: open a text document first`);
    return false;
  }
  const ranges = targets(editor, model);
  const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
  for (const range of ranges) {
    try {
      edits.push({ range, text: fn(model.getValueInRange(range)) });
    } catch (e) {
      reportError(label, e, editor, model, range);
      return false;
    }
  }
  model.pushStackElement();
  editor.executeEdits(label, edits);
  model.pushStackElement();
  return true;
}

/** Run a check over each target without changing anything. */
export function checkText(label: string, fn: (text: string) => void): boolean {
  const editor = getEditor();
  const model = editor?.getModel();
  if (!editor || !model || activeTab()?.big) {
    notify(`${label}: open a text document first`);
    return false;
  }
  for (const range of targets(editor, model)) {
    try {
      fn(model.getValueInRange(range));
    } catch (e) {
      reportError(label, e, editor, model, range);
      return false;
    }
  }
  return true;
}

function reportError(
  label: string,
  e: unknown,
  editor: monaco.editor.IStandaloneCodeEditor,
  model: monaco.editor.ITextModel,
  range: monaco.IRange,
) {
  if (isPositioned(e)) {
    // Error offsets are relative to the text we handed the tool.
    const base = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
    const pos = model.getPositionAt(base + e.offset);
    editor.setSelection(new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column + 1));
    editor.revealPositionInCenterIfOutsideViewport(pos);
    editor.focus();
    notify(`${label}: ${e.message.replace(/\(line \d+, column \d+\)/, `(line ${pos.lineNumber}, column ${pos.column})`)}`, "error");
  } else {
    notify(`${label}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

/** Indent unit of the active document (tab size / spaces from the model). */
export function indentUnit(): string {
  const opts = getEditor()?.getModel()?.getOptions();
  if (!opts) return "  ";
  return opts.insertSpaces ? " ".repeat(opts.indentSize ?? opts.tabSize) : "\t";
}

/** Text of the selections (joined by newlines) or the whole document. */
export function currentText(): string | null {
  const editor = getEditor();
  const model = editor?.getModel();
  if (!editor || !model) return null;
  return targets(editor, model)
    .map((r) => model.getValueInRange(r))
    .join(model.getEOL());
}
