import { invoke } from "@tauri-apps/api/core";

export type Eol = "LF" | "CRLF";

export interface OpenedFile {
  path: string;
  name: string;
  content: string;
  encoding: string;
  hasBom: boolean;
  eol: Eol;
  size: number;
  hadErrors: boolean;
}

export interface SaveRequest {
  path: string;
  content: string;
  encoding: string;
  hasBom: boolean;
  eol: Eol;
}

export const openFile = (path: string, encoding?: string) =>
  invoke<OpenedFile>("open_file", { path, encoding: encoding ?? null });

export const saveFile = (req: SaveRequest) => invoke<void>("save_file", { req });

/** App-data files the backend allows: the global session/settings and per-project sessions. */
export type AppFile = "session.json" | "settings.json" | `projects/${string}.json`;

export const readAppFile = (name: AppFile) => invoke<string | null>("read_app_file", { name });

export const writeAppFile = (name: AppFile, content: string) =>
  invoke<void>("write_app_file", { name, content });

export const startupFiles = () => invoke<string[]>("startup_files");

export interface SearchRequest {
  root: string;
  query: string;
  isRegex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
}

export interface LineMatch {
  line: number;
  text: string;
  /** UTF-16 offset in the full line where `text` begins. */
  previewStart: number;
  /** [start, end) UTF-16 offsets in the full line. */
  ranges: [number, number][];
}

export interface FileMatches {
  searchId: number;
  path: string;
  matches: LineMatch[];
}

export interface SearchDone {
  searchId: number;
  files: number;
  matches: number;
  searchedFiles: number;
  truncated: boolean;
  cancelled: boolean;
  elapsedMs: number;
}

export interface ReplaceSummary {
  changedFiles: string[];
  replacements: number;
  errors: string[];
}

export const searchStart = (req: SearchRequest, id: number) => invoke<void>("search_start", { req, id });

export const searchCancel = () => invoke<void>("search_cancel");

export const replaceInFiles = (req: SearchRequest, replacement: string, paths: string[]) =>
  invoke<ReplaceSummary>("replace_in_files", { req, replacement, paths });

// ---- Big-file mode

export interface IndexStatus {
  /** Lines known so far (all lines once `complete`). */
  lines: number;
  indexedBytes: number;
  size: number;
  complete: boolean;
}

export interface BigOpened {
  id: number;
  path: string;
  name: string;
  encoding: string;
  hasBom: boolean;
  status: IndexStatus;
}

export interface LinePage {
  start: number;
  lines: string[];
  truncated: number[];
  status: IndexStatus;
}

export interface BigFound {
  /** 0-based line. */
  line: number;
  start: number;
  end: number;
  wrapped: boolean;
}

/** [size in bytes, needs big-file mode] */
export const probeFile = (path: string) => invoke<[number, boolean, boolean]>("probe_file", { path });

export const bigfileOpen = (path: string) => invoke<BigOpened>("bigfile_open", { path });

export const bigfileLines = (id: number, start: number, count: number) =>
  invoke<LinePage>("bigfile_lines", { id, start, count });

export const bigfileFind = (id: number, req: SearchRequest, fromLine: number, fromCol: number, backwards: boolean) =>
  invoke<BigFound | null>("bigfile_find", { id, req, fromLine, fromCol, backwards });

/** [index was reset, status] */
export const bigfileRefresh = (id: number) => invoke<[boolean, IndexStatus]>("bigfile_refresh", { id });

export const bigfileClose = (id: number) => invoke<void>("bigfile_close", { id });

// ---- Running scripts

export interface Interpreter {
  program: string;
  /** Args placed before the script, e.g. ["-3"] for the Windows py launcher. */
  args: string[];
  version: string;
  source: string;
}

export interface RunOutput {
  id: number;
  stream: "stdout" | "stderr";
  text: string;
}

export interface RunExit {
  id: number;
  code: number | null;
  elapsedMs: number;
  killed: boolean;
}

export const detectInterpreters = (dir: string | null) =>
  invoke<Interpreter[]>("run_detect_interpreters", { dir });

export const runStart = (id: number, program: string, args: string[], cwd: string, env: [string, string][]) =>
  invoke<number>("run_start", { id, program, args, cwd, env });

export const runStdin = (id: number, data: string) => invoke<void>("run_stdin", { id, data });

export const runEof = (id: number) => invoke<void>("run_eof", { id });

export const runKill = (id: number) => invoke<void>("run_kill", { id });

/** Write a file under the app's run cache (`rel` like `scripts/new 1.py`); returns its path. */
export const writeRunFile = (rel: string, content: string) => invoke<string>("write_run_file", { rel, content });

export const runCacheDir = () => invoke<string>("run_cache_dir");

/** Find a runtime / build tool: node, deno, bun, tsx, go, java, dotnet, cargo, rustc. */
export const detectRuntime = (kind: string, dir: string | null) =>
  invoke<Interpreter | null>("run_detect_runtime", { kind, dir });

/** Nearest project file at or above `dir`; names may be `*.ext`. */
export const findUp = (dir: string, names: string[]) => invoke<string | null>("run_find_up", { dir, names });

// ---- Formatters

export interface Piped {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Feed `input` to `program args` on stdin; the formatted text comes back on stdout. */
export const formatPipe = (program: string, args: string[], cwd: string, input: string | null, timeoutMs = 30000) =>
  invoke<Piped>("format_pipe", { program, args, cwd, input, timeoutMs });

/** First output line of `program args` if it succeeds (e.g. `python -m black --version`). */
export const runProbe = (program: string, args: string[]) => invoke<string | null>("run_probe", { program, args });

// ---- Folders (sidebar, Goto Anything)

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export const fsListDir = (path: string) => invoke<DirEntry[]>("fs_list_dir", { path });
export const fsListFiles = (roots: string[], limit: number) =>
  invoke<{ files: string[]; truncated: boolean }>("fs_list_files", { roots, limit });
/** true = folder, false = file, null = missing. */
export const fsStat = (path: string) => invoke<boolean | null>("fs_stat", { path });
export const fsCreateFile = (path: string) => invoke<void>("fs_create_file", { path });
export const fsCreateDir = (path: string) => invoke<void>("fs_create_dir", { path });
export const fsRename = (from: string, to: string) => invoke<void>("fs_rename", { from, to });
/** Copy a file or folder; never overwrites. */
export const fsCopy = (from: string, to: string) => invoke<void>("fs_copy", { from, to });
/** Moves to the Recycle Bin / Trash. */
export const fsTrash = (path: string) => invoke<void>("fs_trash", { path });
export const fsReveal = (path: string) => invoke<void>("fs_reveal", { path });

// ---- Integrated terminal

export interface TermOutput {
  id: number;
  data: string;
}

export interface TermExit {
  id: number;
  code: number;
}

/** Start a shell in a PTY; `shell` null = the user's default. Resolves to the shell's path. */
export const termSpawn = (id: number, shell: string | null, cwd: string, cols: number, rows: number) =>
  invoke<string>("term_spawn", { id, shell, cwd, cols, rows });
export const termWrite = (id: number, data: string) => invoke<void>("term_write", { id, data });
export const termResize = (id: number, cols: number, rows: number) => invoke<void>("term_resize", { id, cols, rows });
export const termKill = (id: number) => invoke<void>("term_kill", { id });

/** Local image as a data: URL (Markdown preview). */
export const readImageDataUrl = (path: string) => invoke<string>("read_image_data_url", { path });

// ---- Hex editor

export interface HexChecksum {
  name: string;
  value: string;
}

export const hexOpen = (path: string | null) => invoke<{ id: number; len: number }>("hex_open", { path });
export const hexRead = async (id: number, offset: number, len: number) =>
  new Uint8Array(await invoke<ArrayBuffer>("hex_read", { id, offset, len }));
/** `removed` is null when more than `keepLimit` bytes were removed (too big to send back). */
export const hexReplace = (id: number, offset: number, del: number, bytes: Uint8Array, keepLimit: number) =>
  invoke<{ removed: number[] | null; len: number }>("hex_replace", { id, offset, del, bytes: Array.from(bytes), keepLimit });
export const hexSave = (id: number, path: string) => invoke<void>("hex_save", { id, path });
export const hexFind = (id: number, pattern: Uint8Array, from: number, backwards: boolean, ignoreCase: boolean) =>
  invoke<number | null>("hex_find", { id, pattern: Array.from(pattern), from, backwards, ignoreCase });
export const hexChecksums = (id: number, offset: number, len: number) => invoke<HexChecksum[]>("hex_checksums", { id, offset, len });
export const hexClose = (id: number) => invoke<void>("hex_close", { id });
