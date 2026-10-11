import { create } from "zustand";
import { readAppFile, writeAppFile } from "../ipc";
import type { SavedMacro } from "../macro/macro";
import type { Interpreter } from "../ipc";
import type { SqlCase, SqlDialect, SqlLayout } from "../format/sql";
import type { HexCharset, OffsetBase } from "../hex/format";

export type ThemeSetting = "system" | "light" | "dark";

export interface Settings {
  theme: ThemeSetting;
  fontSize: number;
  fontFamily: string;
  wordWrap: boolean;
  minimap: boolean;
  renderWhitespace: boolean;
  tabSize: number;
  insertSpaces: boolean;
  searchHistory: string[];
  replaceHistory: string[];
  folderHistory: string[];
  searchInclude: string;
  searchExclude: string;
  searchPanelHeight: number;
  macros: SavedMacro[];
  /** Chosen Python interpreter; null = auto-detect (nearest venv, then PATH). */
  python: Interpreter | null;
  /** Per-language run command overrides (e.g. `javascript: "node --inspect {file}"`). */
  runCommands: Partial<Record<string, string>>;
  /** Format documents with their language's formatter before saving. */
  formatOnSave: boolean;
  /** Per-language formatter overrides: a stdin → stdout command, e.g. `goimports`. */
  formatCommands: Partial<Record<string, string>>;
  /** SQL formatting: dialect, layout ("toad" = right-aligned river) and keyword case. */
  sqlDialect: SqlDialect;
  sqlLayout: SqlLayout;
  sqlKeywordCase: SqlCase;
  /** Notepad++ smart highlighting: other occurrences of the selection light up. */
  smartHighlight: boolean;
  smartHighlightMatchCase: boolean;
  smartHighlightWholeWord: boolean;
  /** Single-click in the side bar opens a preview tab (replaced by the next single click). */
  previewTabs: boolean;
  /** Ask before moving files by drag and drop in the side bar. */
  confirmDragMove: boolean;
  /** Open project file (.sublime-project), restored at start; null = no project. */
  currentProject: string | null;
  recentProjects: string[];
  /** Shell for the integrated terminal; empty = default (PowerShell on Windows, $SHELL elsewhere). */
  terminalShell: string;
  /** Hex editor display. */
  hexBytesPerRow: number;
  hexCharset: HexCharset;
  hexOffsetBase: OffsetBase;
  hexBigEndian: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  fontSize: 14,
  fontFamily: "'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
  wordWrap: false,
  minimap: true,
  renderWhitespace: false,
  tabSize: 4,
  insertSpaces: true,
  searchHistory: [],
  replaceHistory: [],
  folderHistory: [],
  searchInclude: "",
  searchExclude: "node_modules, target, dist, build, *.min.js",
  searchPanelHeight: 260,
  macros: [],
  python: null,
  runCommands: {},
  formatOnSave: false,
  formatCommands: {},
  sqlDialect: "plsql",
  sqlLayout: "toad",
  sqlKeywordCase: "upper",
  smartHighlight: true,
  smartHighlightMatchCase: false,
  smartHighlightWholeWord: true,
  previewTabs: true,
  confirmDragMove: true,
  currentProject: null,
  recentProjects: [],
  terminalShell: "",
  hexBytesPerRow: 16,
  hexCharset: "ansi",
  hexOffsetBase: "hex",
  hexBigEndian: false,
};

interface SettingsState extends Settings {
  update: (patch: Partial<Settings>) => void;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,
  update: (patch) => {
    set(patch);
    const { update: _, ...plain } = get();
    writeAppFile("settings.json", JSON.stringify(plain, null, 2)).catch(console.error);
  },
}));

export async function loadSettings() {
  try {
    const raw = await readAppFile("settings.json");
    if (raw) useSettings.setState({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
  } catch (e) {
    console.error("settings load failed", e);
  }
}

const HISTORY_MAX = 20;

/** Move `value` to the front of a history list setting. */
export function remember(key: "searchHistory" | "replaceHistory" | "folderHistory", value: string) {
  if (!value) return;
  const list = useSettings.getState()[key].filter((v) => v !== value);
  useSettings.getState().update({ [key]: [value, ...list].slice(0, HISTORY_MAX) });
}

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function resolvedTheme(theme: ThemeSetting): "light" | "dark" {
  if (theme === "system") return darkQuery.matches ? "dark" : "light";
  return theme;
}

export function onSystemThemeChange(cb: () => void): () => void {
  darkQuery.addEventListener("change", cb);
  return () => darkQuery.removeEventListener("change", cb);
}
