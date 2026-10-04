import { useEffect, useRef, useState } from "react";
import { monaco } from "../monaco";
import { closeDiff, disposeStaleTemps, swapDiff, useDiff } from "../store/diff";
import { useSettings } from "../store/settings";
import { getEditor } from "../editorRef";

/** Line a change is anchored at on the modified side (deletions have no modified lines). */
const anchor = (c: monaco.editor.ILineChange) => Math.max(1, c.modifiedStartLineNumber);

export function DiffView() {
  const { left, right, sideBySide, ignoreWhitespace } = useDiff();
  const fontSize = useSettings((s) => s.fontSize);
  const fontFamily = useSettings((s) => s.fontFamily);
  const hostRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [changes, setChanges] = useState<monaco.editor.ILineChange[] | null>(null);
  const [curLine, setCurLine] = useState(0);

  useEffect(() => {
    const diff = monaco.editor.createDiffEditor(hostRef.current!, {
      automaticLayout: true,
      originalEditable: false,
      renderSideBySide: useDiff.getState().sideBySide,
      ignoreTrimWhitespace: useDiff.getState().ignoreWhitespace,
      fontSize: useSettings.getState().fontSize,
      fontFamily: useSettings.getState().fontFamily,
      renderOverviewRuler: true,
      glyphMargin: false,
    });
    diffRef.current = diff;
    const subs = [
      diff.onDidUpdateDiff(() => setChanges(diff.getLineChanges())),
      diff.getModifiedEditor().onDidChangeCursorPosition((e) => setCurLine(e.position.lineNumber)),
    ];
    return () => {
      subs.forEach((s) => s.dispose());
      // Detach models first: they belong to open tabs (or the diff store) and must survive.
      diff.setModel(null);
      diff.dispose();
      diffRef.current = null;
      disposeStaleTemps();
      getEditor()?.focus();
    };
  }, []);

  useEffect(() => {
    if (left && right) {
      setChanges(null);
      diffRef.current?.setModel({ original: left.model, modified: right.model });
      disposeStaleTemps();
      diffRef.current?.getModifiedEditor().focus();
    }
  }, [left, right]);

  useEffect(() => {
    diffRef.current?.updateOptions({ renderSideBySide: sideBySide, ignoreTrimWhitespace: ignoreWhitespace, fontSize, fontFamily });
  }, [sideBySide, ignoreWhitespace, fontSize, fontFamily]);

  const go = (dir: 1 | -1) => {
    const diff = diffRef.current;
    const list = changes ?? diff?.getLineChanges();
    if (!diff || !list?.length) return;
    const ed = diff.getModifiedEditor();
    const cur = ed.getPosition()?.lineNumber ?? 0;
    const target =
      dir > 0
        ? (list.find((c) => anchor(c) > cur) ?? list[0])
        : ([...list].reverse().find((c) => anchor(c) < cur) ?? list[list.length - 1]);
    ed.setPosition({ lineNumber: anchor(target), column: 1 });
    ed.revealLineInCenter(anchor(target));
    ed.focus();
  };

  const count = changes?.length;
  const index = changes ? changes.findIndex((c) => anchor(c) === curLine) + 1 : 0;

  return (
    <div
      className="diff-view"
      role="region"
      aria-label="Compare"
      // Capture phase: Monaco's diff editor binds F7 itself and would swallow it.
      onKeyDownCapture={(e) => {
        if (e.key === "Escape" && !document.querySelector(".diff-view .suggest-widget.visible, .diff-view .find-widget.visible")) closeDiff();
        else if (e.key === "F7") go(e.shiftKey ? -1 : 1);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="diff-bar">
        <span className="diff-title" title={left?.title}>
          {left?.title}
        </span>
        <span className="diff-arrow">↔</span>
        <span className="diff-title" title={right?.title}>
          {right?.title}
          <span className="diff-editable"> (editable)</span>
        </span>
        <span className="bf-spacer" />
        <span className="diff-count" role="status">
          {count === undefined ? "Comparing…" : count === 0 ? "Identical" : `${index ? `${index} of ` : ""}${count} change${count === 1 ? "" : "s"}`}
        </span>
        <button className="sp-btn" onClick={() => go(-1)} disabled={!count} title="Previous change (Shift+F7)">
          ↑
        </button>
        <button className="sp-btn" onClick={() => go(1)} disabled={!count} title="Next change (F7)">
          ↓
        </button>
        <button
          className={`sp-toggle${ignoreWhitespace ? " on" : ""}`}
          aria-pressed={ignoreWhitespace}
          onClick={() => useDiff.setState({ ignoreWhitespace: !ignoreWhitespace })}
          title="Ignore leading/trailing whitespace"
        >
          Ignore whitespace
        </button>
        <button className="sp-btn" onClick={() => useDiff.setState({ sideBySide: !sideBySide })}>
          {sideBySide ? "Inline" : "Side by side"}
        </button>
        <button className="sp-btn" onClick={swapDiff} title="Swap sides">
          ⇄
        </button>
        <button className="sp-icon" onClick={closeDiff} title="Close (Esc)" aria-label="Close compare">
          ×
        </button>
      </div>
      <div className="diff-host" ref={hostRef} />
    </div>
  );
}
