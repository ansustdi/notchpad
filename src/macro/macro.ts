import { create } from "zustand";
import type { monaco } from "../monaco";
import { getEditor } from "../editorRef";
import { getCommand } from "../commands/registry";
import { isMac } from "../platform";
import { useTabs } from "../store/tabs";
import { useSettings } from "../store/settings";
import { askText, notify, showQuickPick } from "../store/ui";
import { mapKey, MacroStep, pushStep } from "./keymap";

export interface SavedMacro {
  name: string;
  steps: MacroStep[];
}

interface MacroState {
  recording: boolean;
  playing: boolean;
  steps: MacroStep[];
  /** The last recorded macro; what "Play" runs. */
  last: MacroStep[] | null;
}

export const useMacro = create<MacroState>(() => ({ recording: false, playing: false, steps: [], last: null }));

let skipped = 0;
/** Safety net for "run to end of file" on a macro that doesn't advance. */
const MAX_RUNS = 100_000;

export function toggleRecording() {
  const s = useMacro.getState();
  if (s.playing) return;
  if (!s.recording) {
    skipped = 0;
    useMacro.setState({ recording: true, steps: [] });
    notify("Recording macro (keyboard only). Stop with Ctrl+Shift+R.");
    getEditor()?.focus();
    return;
  }
  const steps = s.steps;
  useMacro.setState({ recording: false, last: steps.length ? steps : s.last });
  if (!steps.length) notify("Macro is empty; nothing recorded");
  else notify(`Recorded ${steps.length} step${steps.length === 1 ? "" : "s"}${skipped ? ` · ${skipped} key(s) couldn't be recorded` : ""}`);
}

/** App commands run while recording (menu, palette, our shortcuts) become macro steps. */
export function recordAppCommand(id: string) {
  if (!useMacro.getState().recording || id.startsWith("macro.") || getCommand(id)?.interactive) return;
  useMacro.setState((s) => {
    const steps = [...s.steps];
    pushStep(steps, { type: "app", id });
    return { steps };
  });
}

function record(step: MacroStep) {
  useMacro.setState((s) => {
    const steps = s.steps.map((x) => ({ ...x }));
    pushStep(steps, step);
    return { steps };
  });
}

/** Hook one group's editor; only the active group records. */
export function attachRecorder(editor: monaco.editor.IStandaloneCodeEditor, groupId: string): monaco.IDisposable[] {
  const active = () => useMacro.getState().recording && useTabs.getState().activeGroup === groupId;
  return [
    editor.onKeyDown((e) => {
      if (!active() || e.browserEvent.isComposing) return;
      const ev = e.browserEvent;
      const r = mapKey({ key: ev.key, ctrl: ev.ctrlKey, shift: ev.shiftKey, alt: ev.altKey, meta: ev.metaKey }, isMac);
      if (r === null) skipped++;
      else if (r !== "ignore" && r !== "paste") record(r);
    }),
    editor.onDidPaste((e) => {
      if (!active()) return;
      const text = editor.getModel()?.getValueInRange(e.range);
      if (text) record({ type: "paste", text });
    }),
  ];
}

async function runSteps(editor: monaco.editor.IStandaloneCodeEditor, steps: MacroStep[]) {
  for (const s of steps) {
    switch (s.type) {
      case "text":
        editor.trigger("macro", "type", { text: s.text });
        break;
      case "paste":
        editor.trigger("macro", "paste", { text: s.text });
        break;
      case "cmd":
        editor.trigger("macro", s.id, null);
        break;
      case "cut": {
        const empty = editor.getSelections()?.every((sel) => sel.isEmpty()) ?? true;
        editor.trigger("macro", empty ? "editor.action.deleteLines" : "deleteLeft", null);
        break;
      }
      case "app":
        await getCommand(s.id)?.run();
        break;
    }
  }
}

/** Play `steps` `times` times, or until the caret reaches the last line ("eof"). */
export async function playMacro(times: number | "eof", steps = useMacro.getState().last) {
  const s = useMacro.getState();
  if (s.recording || s.playing) return;
  if (!steps?.length) {
    notify("No macro recorded yet (Ctrl+Shift+R to record)");
    return;
  }
  const editor = getEditor();
  const model = editor?.getModel();
  if (!editor || !model) {
    notify("Macros run in a text editor tab");
    return;
  }
  useMacro.setState({ playing: true });
  let runs = 0;
  try {
    model.pushStackElement();
    const limit = times === "eof" ? MAX_RUNS : times;
    while (runs < limit) {
      const before = editor.getPosition();
      const version = model.getVersionId();
      await runSteps(editor, steps);
      runs++;
      if (times === "eof") {
        // Keep going while the caret advances; the run that starts on the last line is the final one.
        const after = editor.getPosition();
        if (!after || !before) break;
        const stuck = after.equals(before) && model.getVersionId() === version;
        if (stuck || before.lineNumber >= model.getLineCount()) break;
      }
      // Stay responsive on long runs.
      if (runs % 200 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    model.pushStackElement();
  } catch (e) {
    notify(`Macro stopped: ${e instanceof Error ? e.message : String(e)}`, "error");
  } finally {
    useMacro.setState({ playing: false });
    editor.focus();
  }
  if (times !== 1) notify(`Macro ran ${runs.toLocaleString()} time${runs === 1 ? "" : "s"}`);
}

export function playMultiple() {
  askText("Run macro how many times? (number, or 'eof' for until end of file)", (text) => {
    if (/^e(of)?$/i.test(text)) return void playMacro("eof");
    const n = Number(text);
    if (Number.isInteger(n) && n > 0) void playMacro(Math.min(n, MAX_RUNS));
    else notify("Enter a positive number or 'eof'", "error");
  });
}

export function saveMacro() {
  const steps = useMacro.getState().last;
  if (!steps?.length) return notify("Record a macro first");
  askText("Name for this macro", (name) => {
    if (!name) return;
    const others = useSettings.getState().macros.filter((m) => m.name !== name);
    useSettings.getState().update({ macros: [...others, { name, steps }].sort((a, b) => a.name.localeCompare(b.name)) });
    notify(`Saved macro "${name}"`);
  });
}

export function runSavedMacro() {
  const macros = useSettings.getState().macros;
  if (!macros.length) return notify("No saved macros");
  showQuickPick({
    placeholder: "Run saved macro",
    items: macros.map((m) => ({ id: m.name, label: m.name, detail: `${m.steps.length} steps` })),
    onPick: (item) => {
      const m = macros.find((x) => x.name === item.id);
      if (!m) return;
      useMacro.setState({ last: m.steps });
      setTimeout(() => void playMacro(1, m.steps));
    },
  });
}

export function deleteSavedMacro() {
  const macros = useSettings.getState().macros;
  if (!macros.length) return notify("No saved macros");
  showQuickPick({
    placeholder: "Delete saved macro",
    items: macros.map((m) => ({ id: m.name, label: m.name })),
    onPick: (item) => {
      useSettings.getState().update({ macros: macros.filter((m) => m.name !== item.id) });
      notify(`Deleted macro "${item.id}"`);
    },
  });
}
