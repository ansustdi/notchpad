import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { monaco } from "../monaco";
import { setEditor } from "../editorRef";
import { getModel, getViewState, setActiveGroup, setViewState, useTabs } from "../store/tabs";
import { resolvedTheme, onSystemThemeChange, useSettings } from "../store/settings";
import { useUi } from "../store/ui";
import { toggleBookmark } from "../bookmarks";
import { attachRecorder } from "../macro/macro";
import { attachSmartHighlight } from "../smartHighlight";

function publishCursor(editor: monaco.editor.IStandaloneCodeEditor) {
  const model = editor.getModel();
  const selections = editor.getSelections() ?? [];
  const pos = editor.getPosition();
  const opts = model?.getOptions();
  useUi.setState({
    cursor: {
      line: pos?.lineNumber ?? 1,
      column: pos?.column ?? 1,
      selected: model ? selections.reduce((n, s) => n + model.getValueLengthInRange(s), 0) : 0,
      cursors: selections.length || 1,
      tabSize: opts?.tabSize ?? 4,
      insertSpaces: opts?.insertSpaces ?? true,
    },
  });
}

/** Focus moves into an editor only if it isn't sitting in some other input (search panel, dialogs). */
const focusIsFree = () => {
  const el = document.activeElement;
  return !el || el === document.body || !!el.closest(".editor-group");
};

/** App-wide theme: CSS variables, Monaco theme and the native title bar. */
export function useThemeSync() {
  const theme = useSettings((s) => s.theme);
  useEffect(() => {
    const apply = () => {
      const resolved = resolvedTheme(theme);
      document.documentElement.dataset.theme = resolved;
      monaco.editor.setTheme(resolved === "dark" ? "vs-dark" : "vs");
      // null means follow the OS.
      void getCurrentWindow()
        .setTheme(theme === "system" ? null : resolved)
        .catch(() => {});
    };
    apply();
    return onSystemThemeChange(apply);
  }, [theme]);
}

export function EditorHost({ groupId, hidden = false }: { groupId: string; hidden?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const shownId = useRef<string | null>(null);
  const activeId = useTabs((s) => s.groups.find((g) => g.id === groupId)?.activeId ?? null);
  const isActiveGroup = useTabs((s) => s.activeGroup === groupId);
  const settings = useSettings();

  useEffect(() => {
    const s = useSettings.getState();
    const editor = monaco.editor.create(hostRef.current!, {
      model: null,
      automaticLayout: true,
      theme: resolvedTheme(s.theme) === "dark" ? "vs-dark" : "vs",
      fontSize: s.fontSize,
      fontFamily: s.fontFamily,
      wordWrap: s.wordWrap ? "on" : "off",
      minimap: { enabled: s.minimap },
      renderWhitespace: s.renderWhitespace ? "all" : "selection",
      fontLigatures: true,
      smoothScrolling: true,
      cursorSmoothCaretAnimation: "on",
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: "active", indentation: true },
      stickyScroll: { enabled: true },
      // Ctrl+wheel is handled app-wide (src/zoom.ts) so there is only one zoom.
      mouseWheelZoom: false,
      multiCursorModifier: "alt",
      columnSelection: false,
      largeFileOptimizations: true,
      unicodeHighlight: { ambiguousCharacters: false },
      fixedOverflowWidgets: true,
      glyphMargin: true,
      // Replaced by the stronger Notepad++-style smart highlighting (src/smartHighlight.ts).
      selectionHighlight: false,
    });
    editorRef.current = editor;
    setEditor(groupId, editor);
    const ifActive = () => {
      if (useTabs.getState().activeGroup === groupId) publishCursor(editor);
    };
    const subs = [
      editor.onDidChangeCursorSelection(ifActive),
      editor.onDidChangeModel(ifActive),
      editor.onDidChangeModelOptions(ifActive),
      editor.onDidFocusEditorWidget(() => {
        setActiveGroup(groupId);
        publishCursor(editor);
      }),
      editor.onMouseDown((e) => {
        setActiveGroup(groupId);
        if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) {
          toggleBookmark(e.target.position.lineNumber);
        }
      }),
      ...attachRecorder(editor, groupId),
      ...attachSmartHighlight(editor, () => useTabs.getState().activeGroup === groupId),
    ];
    return () => {
      const shown = shownId.current;
      if (shown && getModel(shown)) setViewState(groupId, shown, editor.saveViewState());
      subs.forEach((d) => d.dispose());
      setEditor(groupId, null);
      editor.dispose();
      editorRef.current = null;
    };
  }, [groupId]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const prev = shownId.current;
    if (prev && prev !== activeId && getModel(prev)) setViewState(groupId, prev, editor.saveViewState());
    const model = activeId ? getModel(activeId) : undefined;
    if (editor.getModel() !== (model ?? null)) editor.setModel(model ?? null);
    shownId.current = activeId;
    if (activeId && model) {
      const vs = getViewState(groupId, activeId);
      if (vs && prev !== activeId) editor.restoreViewState(vs);
      if (useTabs.getState().activeGroup === groupId && focusIsFree()) editor.focus();
    }
  }, [activeId, groupId]);

  // Focusing a group (Ctrl+1..4, clicking its tabs) moves the caret there.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !isActiveGroup || hidden) return;
    publishCursor(editor);
    if (editor.getModel() && focusIsFree()) editor.focus();
  }, [isActiveGroup, hidden]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      wordWrap: settings.wordWrap ? "on" : "off",
      minimap: { enabled: settings.minimap },
      renderWhitespace: settings.renderWhitespace ? "all" : "selection",
    });
  }, [settings.fontSize, settings.fontFamily, settings.wordWrap, settings.minimap, settings.renderWhitespace]);

  return <div className="editor-host" ref={hostRef} style={hidden ? { display: "none" } : undefined} />;
}
