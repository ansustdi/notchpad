import { isMac } from "../platform";

export interface Command {
  id: string;
  label: string;
  category?: string;
  /** e.g. "Mod+Shift+S". Mod = Cmd on macOS, Ctrl elsewhere. "Ctrl" is literal Ctrl everywhere. */
  keys?: string;
  run: () => unknown;
  /** Hidden from the command palette (still reachable by key or menu). */
  hidden?: boolean;
  /** Opens UI that waits for the user (pickers, prompts, panels): never recorded into macros. */
  interactive?: boolean;
}

const commands = new Map<string, Command>();

export function registerCommands(list: Command[]) {
  for (const c of list) commands.set(c.id, c);
}

export const allCommands = () => [...commands.values()];

let observer: ((id: string) => void) | null = null;

/** Called for every command run through `runCommand` (macro recording). */
export function setCommandObserver(fn: (id: string) => void) {
  observer = fn;
}

export function runCommand(id: string) {
  const cmd = commands.get(id);
  if (!cmd) {
    console.warn("unknown command", id);
    return;
  }
  observer?.(id);
  Promise.resolve(cmd.run()).catch((e) => console.error(`command ${id} failed`, e));
}

interface Chord {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

function parse(keys: string): Chord {
  const parts = keys.split("+");
  const key = parts.pop()!.toLowerCase();
  const has = (m: string) => parts.includes(m);
  return { mod: has("Mod"), ctrl: has("Ctrl"), alt: has("Alt"), shift: has("Shift"), key };
}

/** Layout-independent key name from KeyboardEvent.code, so Shift doesn't change it. */
function eventKey(e: KeyboardEvent): string {
  const c = e.code;
  if (c.startsWith("Key")) return c.slice(3).toLowerCase();
  if (c.startsWith("Digit")) return c.slice(5);
  if (c === "Equal" || c === "NumpadAdd") return "=";
  if (c === "Minus" || c === "NumpadSubtract") return "-";
  return e.key.toLowerCase();
}

function matches(chord: Chord, e: KeyboardEvent): boolean {
  const wantCtrl = chord.ctrl || (chord.mod && !isMac);
  const wantMeta = chord.mod && isMac;
  return (
    e.ctrlKey === wantCtrl &&
    e.metaKey === wantMeta &&
    e.altKey === chord.alt &&
    e.shiftKey === chord.shift &&
    eventKey(e) === chord.key
  );
}

const parsed = new Map<string, Chord>();

export function commandForEvent(e: KeyboardEvent): Command | undefined {
  for (const cmd of commands.values()) {
    if (!cmd.keys) continue;
    let chord = parsed.get(cmd.keys);
    if (!chord) parsed.set(cmd.keys, (chord = parse(cmd.keys)));
    if (matches(chord, e)) return cmd;
  }
  return undefined;
}

export function formatKeys(keys?: string): string {
  if (!keys) return "";
  const parts = keys.split("+");
  const nice = (k: string) => (k.length === 1 ? k.toUpperCase() : k);
  if (isMac) {
    const sym: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };
    return parts.map((p) => sym[p] ?? nice(p)).join("");
  }
  return parts.map((p) => (p === "Mod" ? "Ctrl" : nice(p))).join("+");
}

export const getCommand = (id: string) => commands.get(id);
