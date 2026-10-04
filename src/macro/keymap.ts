/**
 * Maps a key press seen while recording a macro to something replayable.
 * Monaco has no public "which command does this key run" API, so common editing
 * keys are listed here per platform.
 */

export type MacroStep =
  | { type: "text"; text: string }
  | { type: "paste"; text: string }
  | { type: "cmd"; id: string }
  /** Ctrl+X: without clipboard access on replay, cut deletes the selection (or line). */
  | { type: "cut" }
  | { type: "app"; id: string };

export interface KeyInfo {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/** "ignore" = recordable no-op (e.g. copy); null = can't be recorded. */
export type KeyResult = MacroStep | "ignore" | "paste" | null;

const cmd = (id: string): MacroStep => ({ type: "cmd", id });

export function mapKey(k: KeyInfo, isMac: boolean): KeyResult {
  const mod = isMac ? k.meta : k.ctrl;
  // Word-wise movement: Ctrl on Windows/Linux, Option on macOS.
  const word = isMac ? k.alt && !k.meta : k.ctrl && !k.alt;
  // Line-move / copy: Alt everywhere.
  const lineAlt = k.alt && !mod;
  const sel = k.shift ? "Select" : "";

  // Plain typing, incl. Option-typed characters on macOS and AltGr (reported as Ctrl+Alt) elsewhere.
  if (k.key.length === 1 && ((!k.ctrl && !k.meta) || (!isMac && k.ctrl && k.alt))) {
    return { type: "text", text: k.key };
  }

  switch (k.key) {
    case "ArrowLeft":
      if (isMac && k.meta) return cmd(`cursorHome${sel}`);
      return cmd(word ? `cursorWordLeft${sel}` : `cursorLeft${sel}`);
    case "ArrowRight":
      if (isMac && k.meta) return cmd(`cursorEnd${sel}`);
      return cmd(word ? `cursorWordEndRight${sel}` : `cursorRight${sel}`);
    case "ArrowUp":
    case "ArrowDown": {
      const dir = k.key === "ArrowUp" ? "Up" : "Down";
      if (lineAlt) return cmd(k.shift ? `editor.action.copyLines${dir}Action` : `editor.action.moveLines${dir}Action`);
      if (isMac && k.meta) return cmd(dir === "Up" ? `cursorTop${sel}` : `cursorBottom${sel}`);
      return cmd(`cursor${dir}${sel}`);
    }
    case "Home":
      return cmd(mod ? `cursorTop${sel}` : `cursorHome${sel}`);
    case "End":
      return cmd(mod ? `cursorBottom${sel}` : `cursorEnd${sel}`);
    case "PageUp":
      return cmd(`cursorPageUp${sel}`);
    case "PageDown":
      return cmd(`cursorPageDown${sel}`);
    case "Backspace":
      return cmd(word ? "deleteWordLeft" : "deleteLeft");
    case "Delete":
      return cmd(word ? "deleteWordRight" : "deleteRight");
    case "Tab":
      return cmd(k.shift ? "outdent" : "tab");
    case "Enter":
      if (mod) return cmd(k.shift ? "editor.action.insertLineBefore" : "editor.action.insertLineAfter");
      return { type: "text", text: "\n" };
    case "Escape":
    case "Shift":
    case "Control":
    case "Alt":
    case "Meta":
    case "CapsLock":
      return "ignore";
  }

  if (mod && !k.alt) {
    switch (k.key.toLowerCase()) {
      case "c":
        return "ignore";
      case "v":
        return "paste"; // text arrives via the editor's paste event
      case "x":
        return { type: "cut" };
      case "z":
        return cmd(k.shift ? "redo" : "undo");
      case "y":
        return cmd("redo");
      case "a":
        return cmd("editor.action.selectAll");
      case "d":
        return cmd("editor.action.addSelectionToNextFindMatch");
      case "/":
        return cmd("editor.action.commentLine");
      case "]":
        return cmd("editor.action.indentLines");
      case "[":
        return cmd("editor.action.outdentLines");
      case "k":
        if (k.shift) return cmd("editor.action.deleteLines");
        break;
      case "l":
        if (!k.shift) return cmd("expandLineSelection");
        break;
    }
  }
  return null;
}

/** Append a step, merging consecutive typing into one text step. */
export function pushStep(steps: MacroStep[], step: MacroStep) {
  const last = steps[steps.length - 1];
  if (step.type === "text" && last?.type === "text") last.text += step.text;
  else steps.push(step);
}

export function describeStep(s: MacroStep): string {
  switch (s.type) {
    case "text":
      return `type ${JSON.stringify(s.text)}`;
    case "paste":
      return `paste ${JSON.stringify(s.text.slice(0, 40))}`;
    case "cut":
      return "cut";
    case "cmd":
    case "app":
      return s.id;
  }
}
