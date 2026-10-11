import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TermExit, TermOutput, termKill, termResize, termSpawn, termWrite } from "../ipc";
import { copyText, pasteText } from "../clipboard";
import { getEditor } from "../editorRef";
import { isMac } from "../platform";
import { showPanelTab, usePanel } from "./panel";
import { onSystemThemeChange, resolvedTheme, useSettings } from "./settings";
import { activeTab } from "./tabs";
import { useWorkspace } from "./workspace";
import { errorMessage } from "./ui";

export interface TermSession {
  id: number;
  title: string;
  exited: boolean;
}

interface TerminalState {
  /** Terminal tab shown in the bottom panel. Hiding it keeps the shells running. */
  open: boolean;
  sessions: TermSession[];
  activeId: number | null;
}

export const useTerminal = create<TerminalState>(() => ({ open: false, sessions: [], activeId: null }));

/** xterm instances live outside React so they survive the panel being hidden or re-rendered. */
interface Live {
  term: Terminal;
  fit: FitAddon;
  /** The element xterm renders into; moved between hosts as the panel mounts. */
  el: HTMLDivElement;
}
const live = new Map<number, Live>();

let seq = 0;

const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, "") || p;
const basename = (p: string) => p.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");

async function startDir(): Promise<string> {
  const root = useWorkspace.getState().roots[0];
  if (root) return root;
  const path = activeTab()?.path;
  if (path) return dirname(path);
  try {
    return await homeDir();
  } catch {
    return "";
  }
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function xtermTheme() {
  const dark = resolvedTheme(useSettings.getState().theme) === "dark";
  return {
    background: cssVar("--bg"),
    foreground: cssVar("--text"),
    cursor: cssVar("--text"),
    selectionBackground: dark ? "#264f78" : "#add6ff",
    // VS Code's ANSI palette, readable on either background.
    ...(dark
      ? {
          black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510", blue: "#2472c8",
          magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5", brightBlack: "#666666",
          brightRed: "#f14c4c", brightGreen: "#23d18b", brightYellow: "#f5f543", brightBlue: "#3b8eea",
          brightMagenta: "#d670d6", brightCyan: "#29b8db", brightWhite: "#e5e5e5",
        }
      : {
          black: "#000000", red: "#cd3131", green: "#00bc00", yellow: "#949800", blue: "#0451a5",
          magenta: "#bc05bc", cyan: "#0598bc", white: "#555555", brightBlack: "#666666",
          brightRed: "#cd3131", brightGreen: "#14ce14", brightYellow: "#b5ba00", brightBlue: "#0451a5",
          brightMagenta: "#bc05bc", brightCyan: "#0598bc", brightWhite: "#a5a5a5",
        }),
  };
}

/** Re-read colors and font after a theme or settings change. */
export function restyleTerminals() {
  const { fontFamily, fontSize } = useSettings.getState();
  const theme = xtermTheme();
  for (const { term, fit } of live.values()) {
    term.options.theme = theme;
    term.options.fontFamily = fontFamily;
    term.options.fontSize = fontSize;
    fitSoon(fit);
  }
}

function fitSoon(fit: FitAddon) {
  requestAnimationFrame(() => {
    try {
      fit.fit();
    } catch {
      // Not attached / zero size: fitted again when shown.
    }
  });
}

function createLive(id: number): Live {
  const { fontFamily, fontSize } = useSettings.getState();
  const term = new Terminal({
    fontFamily,
    fontSize,
    theme: xtermTheme(),
    cursorBlink: true,
    scrollback: 10_000,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const el = document.createElement("div");
  el.className = "term-instance";

  const mod = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const k = e.key.toLowerCase();
    // Copy: Ctrl+C with a selection (otherwise it's an interrupt), or Ctrl+Shift+C.
    if (mod(e) && k === "c" && (e.shiftKey || term.hasSelection())) {
      if (term.hasSelection()) {
        void copyText(term.getSelection());
        term.clearSelection();
      }
      e.preventDefault();
      return false;
    }
    if (mod(e) && k === "v") {
      e.preventDefault();
      void pasteText().then((t) => t && term.paste(t));
      return false;
    }
    return true;
  });
  term.onData((data) => {
    termWrite(id, data).catch(() => {});
  });
  term.onResize(({ cols, rows }) => {
    termResize(id, cols, rows).catch(() => {});
  });
  term.onTitleChange((title) => {
    if (title) rename(id, basename(title));
  });
  const l = { term, fit, el };
  live.set(id, l);
  return l;
}

function rename(id: number, title: string) {
  useTerminal.setState((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, title } : x)) }));
}

/** Mount the active terminal into `host` (called by the panel). Returns a detach function. */
export function attachTerminal(id: number, host: HTMLElement): () => void {
  const l = live.get(id);
  if (!l) return () => {};
  host.appendChild(l.el);
  if (!l.term.element) l.term.open(l.el);
  fitSoon(l.fit);
  const ro = new ResizeObserver(() => fitSoon(l.fit));
  ro.observe(host);
  return () => {
    ro.disconnect();
    if (l.el.parentElement === host) host.removeChild(l.el);
  };
}

export const focusTerminal = (id = useTerminal.getState().activeId) => {
  if (id !== null) requestAnimationFrame(() => live.get(id)?.term.focus());
};

/** Start a new shell and show it. */
export async function newTerminal() {
  const id = ++seq;
  const l = createLive(id);
  useTerminal.setState((s) => ({ open: true, activeId: id, sessions: [...s.sessions, { id, title: "terminal", exited: false }] }));
  showPanelTab("terminal");
  const shell = useSettings.getState().terminalShell.trim() || null;
  // Spawn with the size the panel will give it; the first fit corrects it anyway.
  await new Promise((r) => requestAnimationFrame(r));
  try {
    const path = await termSpawn(id, shell, await startDir(), l.term.cols, l.term.rows);
    rename(id, basename(path));
  } catch (e) {
    l.term.write(`\x1b[31m${errorMessage(e)}\x1b[0m\r\n`);
    markExited(id);
  }
  focusTerminal(id);
}

function markExited(id: number) {
  useTerminal.setState((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, exited: true } : x)) }));
}

export function showTerminal(id: number) {
  useTerminal.setState({ activeId: id, open: true });
  showPanelTab("terminal");
  focusTerminal(id);
}

/** Kill a shell and drop its tab; hides the panel when it was the last one. */
export function killTerminal(id = useTerminal.getState().activeId) {
  if (id === null) return;
  termKill(id).catch(() => {});
  live.get(id)?.term.dispose();
  live.delete(id);
  const { sessions, activeId } = useTerminal.getState();
  const idx = sessions.findIndex((s) => s.id === id);
  const rest = sessions.filter((s) => s.id !== id);
  const next = activeId === id ? (rest[Math.min(idx, rest.length - 1)]?.id ?? null) : activeId;
  useTerminal.setState({ sessions: rest, activeId: next, open: rest.length > 0 });
  if (rest.length) focusTerminal(next);
  else getEditor()?.focus();
}

export function hideTerminal() {
  useTerminal.setState({ open: false });
  getEditor()?.focus();
}

const terminalFocused = () => !!document.activeElement?.closest(".term-host");

/** Ctrl+`: show and focus the terminal (starting one if needed); hide it when it has focus. */
export function toggleTerminal() {
  const { open, sessions } = useTerminal.getState();
  const shown = open && usePanel.getState().active === "terminal";
  if (shown && terminalFocused()) return hideTerminal();
  if (!sessions.length) return void newTerminal();
  useTerminal.setState({ open: true });
  showPanelTab("terminal");
  focusTerminal();
}

/** Restart an exited shell in place. */
export function restartTerminal(id: number) {
  killTerminal(id);
  void newTerminal();
}

void listen<TermOutput>("term-output", (e) => {
  live.get(e.payload.id)?.term.write(e.payload.data);
});

void listen<TermExit>("term-exit", (e) => {
  const { id, code } = e.payload;
  const l = live.get(id);
  if (!l) return;
  markExited(id);
  l.term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`);
});

useSettings.subscribe((s, prev) => {
  if (s.theme !== prev.theme || s.fontFamily !== prev.fontFamily || s.fontSize !== prev.fontSize) {
    // Let the theme attribute land on <html> before reading CSS variables.
    requestAnimationFrame(restyleTerminals);
  }
});


onSystemThemeChange(() => requestAnimationFrame(restyleTerminals));
