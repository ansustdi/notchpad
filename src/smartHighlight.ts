/**
 * Notepad++-style smart highlighting: select text and every other occurrence lights up,
 * with marks in the scrollbar. Replaces Monaco's faint built-in selection highlight.
 */

import { monaco } from "./monaco";
import { useSettings } from "./store/settings";
import { useUi } from "./store/ui";

/** More matches than this are counted but not all painted (keeps huge files responsive). */
const MAX_MATCHES = 10_000;
const MAX_LENGTH = 256;

/** Monaco's default word separators, used for "whole word" matching. */
const WORD_SEPARATORS = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";

export interface SmartQuery {
  text: string;
  wholeWord: boolean;
}

/**
 * What to highlight for a selection, or null. Like Notepad++: nothing for empty, multi-line,
 * very long or whitespace-only selections; "whole word" only applies when the selection is
 * itself a word (selecting `15550102` won't light up `9155501021`).
 */
export function smartQuery(selected: string, wholeWordSetting: boolean): SmartQuery | null {
  if (!selected || selected.length > MAX_LENGTH || /[\r\n]/.test(selected) || !selected.trim()) return null;
  const isWord = /^[\p{L}\p{N}_]+$/u.test(selected);
  return { text: selected, wholeWord: wholeWordSetting && isWord };
}

export function attachSmartHighlight(editor: monaco.editor.IStandaloneCodeEditor, isActive: () => boolean): monaco.IDisposable[] {
  const decorations = editor.createDecorationsCollection();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const publish = (count: number | null) => {
    if (isActive()) useUi.setState({ smartMatches: count });
  };

  const update = () => {
    timer = undefined;
    const model = editor.getModel();
    const sel = editor.getSelection();
    const s = useSettings.getState();
    const query = model && sel && !sel.isEmpty() && s.smartHighlight ? smartQuery(model.getValueInRange(sel), s.smartHighlightWholeWord) : null;
    if (!model || !query) {
      decorations.clear();
      publish(null);
      return;
    }
    const matches = model.findMatches(
      query.text,
      false,
      false,
      s.smartHighlightMatchCase,
      query.wholeWord ? WORD_SEPARATORS : null,
      false,
      MAX_MATCHES,
    );
    // A lone match is just the selection itself: nothing to point out.
    if (matches.length < 2) {
      decorations.clear();
      publish(matches.length || null);
      return;
    }
    decorations.set(
      matches.map((m) => ({
        range: m.range,
        options: {
          className: "smart-hl",
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          overviewRuler: { color: "#2fb52f", position: monaco.editor.OverviewRulerLane.Center },
          minimap: { color: "#2fb52f", position: monaco.editor.MinimapPosition.Inline },
        },
      })),
    );
    publish(matches.length);
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(update, 60);
  };

  const unsubscribe = useSettings.subscribe((s, prev) => {
    if (
      s.smartHighlight !== prev.smartHighlight ||
      s.smartHighlightMatchCase !== prev.smartHighlightMatchCase ||
      s.smartHighlightWholeWord !== prev.smartHighlightWholeWord
    ) {
      schedule();
    }
  });

  return [
    editor.onDidChangeCursorSelection(schedule),
    editor.onDidChangeModel(schedule),
    editor.onDidChangeModelContent(schedule),
    editor.onDidFocusEditorWidget(schedule),
    {
      dispose() {
        if (timer) clearTimeout(timer);
        unsubscribe();
        decorations.clear();
      },
    },
  ];
}
