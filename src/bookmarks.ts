import { copyText } from "./clipboard";
import { monaco } from "./monaco";
import { getEditor } from "./editorRef";
import { activeTab, getModel } from "./store/tabs";
import { notify } from "./store/ui";
import { scheduleSessionSave } from "./session";

/** Decoration ids per model. Decorations live on the model, so they move with edits. */
const decorations = new WeakMap<monaco.editor.ITextModel, string[]>();

const OPTIONS: monaco.editor.IModelDecorationOptions = {
  isWholeLine: true,
  glyphMarginClassName: "bookmark-glyph",
  glyphMarginHoverMessage: { value: "Bookmark (Ctrl+F2 to toggle)" },
  className: "bookmark-line",
  stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
  overviewRuler: { color: "#3b8eea", position: monaco.editor.OverviewRulerLane.Left },
  minimap: { color: "#3b8eea", position: monaco.editor.MinimapPosition.Inline },
};

function linesOf(model: monaco.editor.ITextModel): number[] {
  const ids = decorations.get(model) ?? [];
  const lines = new Set<number>();
  for (const id of ids) {
    const r = model.getDecorationRange(id);
    if (r) lines.add(r.startLineNumber);
  }
  return [...lines].sort((a, b) => a - b);
}

function setLines(model: monaco.editor.ITextModel, lines: Iterable<number>) {
  const max = model.getLineCount();
  const unique = [...new Set(lines)].filter((l) => l >= 1 && l <= max);
  const next = model.deltaDecorations(
    decorations.get(model) ?? [],
    unique.map((l) => ({ range: new monaco.Range(l, 1, l, 1), options: OPTIONS })),
  );
  decorations.set(model, next);
  scheduleSessionSave();
}

export function getBookmarks(tabId: string): number[] {
  const model = getModel(tabId);
  return model ? linesOf(model) : [];
}

export function setBookmarks(tabId: string, lines: number[]) {
  const model = getModel(tabId);
  if (model) setLines(model, lines);
}

function activeModel() {
  const tab = activeTab();
  return tab ? getModel(tab.id) : undefined;
}

export function toggleBookmark(line?: number) {
  const editor = getEditor();
  const model = activeModel();
  if (!editor || !model) return;
  const target = line ?? editor.getPosition()?.lineNumber;
  if (!target) return;
  const lines = new Set(linesOf(model));
  if (lines.has(target)) lines.delete(target);
  else lines.add(target);
  setLines(model, lines);
}

export function gotoBookmark(dir: 1 | -1) {
  const editor = getEditor();
  const model = activeModel();
  if (!editor || !model) return;
  const lines = linesOf(model);
  if (!lines.length) {
    notify("No bookmarks in this document");
    return;
  }
  const cur = editor.getPosition()?.lineNumber ?? 1;
  // Wrap around at either end, like Notepad++.
  const target = dir > 0 ? (lines.find((l) => l > cur) ?? lines[0]) : ([...lines].reverse().find((l) => l < cur) ?? lines[lines.length - 1]);
  editor.setPosition({ lineNumber: target, column: 1 });
  editor.revealLineInCenterIfOutsideViewport(target);
  editor.focus();
}

export function clearBookmarks() {
  const model = activeModel();
  if (model) setLines(model, []);
}

export function bookmarkLines(tabId: string, lines: number[]) {
  const model = getModel(tabId);
  if (!model) return;
  setLines(model, [...linesOf(model), ...lines]);
}

export async function copyBookmarkedLines() {
  const model = activeModel();
  if (!model) return;
  const lines = linesOf(model);
  if (!lines.length) return notify("No bookmarks in this document");
  const eol = model.getEOL();
  await copyText(lines.map((l) => model.getLineContent(l)).join(eol));
  notify(`Copied ${lines.length} bookmarked line${lines.length === 1 ? "" : "s"}`);
}

/** Delete bookmarked lines (keep = false) or every other line (keep = true), as one undo step. */
export function removeLines(keepBookmarked: boolean) {
  const editor = getEditor();
  const model = activeModel();
  if (!editor || !model) return;
  const marked = new Set(linesOf(model));
  if (!marked.size) return notify("No bookmarks in this document");
  const count = model.getLineCount();
  const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
  // Group consecutive lines to delete into single ranges.
  for (let l = 1; l <= count; ) {
    if (marked.has(l) === keepBookmarked) {
      l++;
      continue;
    }
    const start = l;
    while (l <= count && marked.has(l) !== keepBookmarked) l++;
    const end = l - 1;
    const range =
      end < count
        ? new monaco.Range(start, 1, end + 1, 1)
        : start > 1
          ? new monaco.Range(start - 1, model.getLineMaxColumn(start - 1), end, model.getLineMaxColumn(end))
          : new monaco.Range(start, 1, end, model.getLineMaxColumn(end));
    edits.push({ range, text: "" });
  }
  model.pushStackElement();
  model.pushEditOperations(editor.getSelections(), edits, () => null);
  model.pushStackElement();
  // Deleted lines' decorations collapse onto neighbours, so reset them explicitly.
  setLines(model, keepBookmarked ? Array.from({ length: marked.size }, (_, i) => i + 1) : []);
}
