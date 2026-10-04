/**
 * Picks the formatter for a document and the exact command line. Pure, so each language's
 * rules are unit-tested; the format store detects tools and applies the result.
 */

import { expandTemplate, extOf, Tool } from "../run/plan";

export type FmtLang =
  | "python"
  | "c"
  | "cpp"
  | "csharp"
  | "java"
  | "go"
  | "rust"
  | "javascript"
  | "typescript"
  | "css"
  | "html"
  | "json"
  | "xml"
  | "sql";

export type Formatter =
  | "py-ruff"
  | "py-black"
  | "py-autopep8"
  | "ruff"
  | "black"
  | "autopep8"
  | "clang-format"
  | "google-java-format"
  | "dotnet-format"
  | "gofmt"
  | "rustfmt"
  | "prettier"
  | "monaco"
  | "json"
  | "xml"
  | "sql";

export const FMT_LABEL: Record<FmtLang, string> = {
  python: "Python",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  java: "Java",
  go: "Go",
  rust: "Rust",
  javascript: "JavaScript",
  typescript: "TypeScript",
  css: "CSS",
  html: "HTML",
  json: "JSON",
  xml: "XML",
  sql: "SQL",
};

const EXT: Record<string, FmtLang> = {
  py: "python",
  pyw: "python",
  pyi: "python",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  ino: "cpp",
  cs: "csharp",
  java: "java",
  go: "go",
  rs: "rust",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  htm: "html",
  json: "json",
  jsonc: "json",
  xml: "xml",
  svg: "xml",
  xaml: "xml",
  csproj: "xml",
  sql: "sql",
  ddl: "sql",
  dml: "sql",
  pls: "sql",
  plsql: "sql",
  pks: "sql",
  pkb: "sql",
  pck: "sql",
  prc: "sql",
  fnc: "sql",
  trg: "sql",
  vw: "sql",
};

const MONACO: Record<string, FmtLang> = {
  python: "python",
  c: "c",
  cpp: "cpp",
  csharp: "csharp",
  java: "java",
  go: "go",
  rust: "rust",
  javascript: "javascript",
  typescript: "typescript",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  json: "json",
  xml: "xml",
  sql: "sql",
  mysql: "sql",
  pgsql: "sql",
  redshift: "sql",
};

export function fmtLangOf(monacoLanguage: string, fileName: string): FmtLang | null {
  return EXT[extOf(fileName)] ?? MONACO[monacoLanguage] ?? null;
}

/** Default extension so formatters can infer the language of an unsaved buffer. */
export const FMT_EXT: Record<FmtLang, string> = {
  python: "py",
  c: "c",
  cpp: "cpp",
  csharp: "cs",
  java: "java",
  go: "go",
  rust: "rs",
  javascript: "js",
  typescript: "ts",
  css: "css",
  html: "html",
  json: "json",
  xml: "xml",
  sql: "sql",
};

/**
 * Preference order. Python tries the project's own interpreter first (`python -m ruff`), so a
 * venv's pinned formatter wins over a global one. The editor's built-in formatter is the last
 * resort for web languages.
 */
export function formattersFor(lang: FmtLang): Formatter[] {
  switch (lang) {
    case "python":
      return ["py-ruff", "py-black", "ruff", "black", "py-autopep8", "autopep8"];
    case "c":
    case "cpp":
      return ["clang-format"];
    case "java":
      return ["google-java-format", "clang-format"];
    case "csharp":
      return ["dotnet-format", "clang-format"];
    case "go":
      return ["gofmt"];
    case "rust":
      return ["rustfmt"];
    case "javascript":
    case "typescript":
    case "css":
    case "html":
      return ["prettier", "monaco"];
    case "json":
      return ["json"];
    case "xml":
      return ["xml"];
    case "sql":
      return ["sql"];
  }
}

/** Tool to detect for a formatter (`py-*` run through the Python interpreter instead). */
export const TOOL_OF: Partial<Record<Formatter, string>> = {
  ruff: "ruff",
  black: "black",
  autopep8: "autopep8",
  "clang-format": "clang-format",
  "google-java-format": "google-java-format",
  "dotnet-format": "dotnet",
  gofmt: "gofmt",
  rustfmt: "rustfmt",
  prettier: "prettier",
};

/** `python -m <module>` for the py-* formatters. */
export const PY_MODULE: Partial<Record<Formatter, string>> = {
  "py-ruff": "ruff",
  "py-black": "black",
  "py-autopep8": "autopep8",
};

export const FMT_INSTALL: Record<FmtLang, string> = {
  python: "Install one with `pip install ruff` (or black / autopep8).",
  c: "Install clang-format (LLVM): `winget install LLVM.LLVM`, `brew install clang-format` or `apt install clang-format`.",
  cpp: "Install clang-format (LLVM): `winget install LLVM.LLVM`, `brew install clang-format` or `apt install clang-format`.",
  java: "Install google-java-format, or clang-format (LLVM).",
  csharp: "Install the .NET SDK (includes `dotnet format`) from https://dotnet.microsoft.com/download.",
  go: "Go includes gofmt: install Go from https://go.dev/dl.",
  rust: "Run `rustup component add rustfmt`.",
  javascript: "",
  typescript: "",
  css: "",
  html: "",
  json: "",
  xml: "",
  sql: "",
};

export type FmtPlan =
  /** Text goes in on stdin, formatted text comes out on stdout. */
  | { kind: "pipe"; program: string; args: string[]; cwd: string; label: string }
  /**
   * `dotnet format` works on projects: format a copy inside a scratch project and read it
   * back. (`--folder` mode reports success without writing on the .NET 9 SDK.)
   */
  | { kind: "dotnet"; program: string; label: string; targetFramework: string }
  | { kind: "monaco" }
  | { kind: "builtin"; which: "json" | "xml" | "sql" };

export interface FmtInput {
  lang: FmtLang;
  formatter: Formatter;
  /** The detected tool (for py-*: the Python interpreter). */
  tool: Tool | null;
  /** Real path, or a name with the right extension for unsaved buffers. */
  file: string;
  cwd: string;
  /** Rust edition from Cargo.toml (rustfmt's default, 2015, rejects newer syntax). */
  rustEdition?: string | null;
  /** User override (stdin → stdout command), e.g. `prettier --stdin-filepath {file}`. */
  custom?: string;
}

const version = (t: Tool) => t.version.replace(/^(\S+)\s+(?:version\s+)?/i, "$1 ").split(" (")[0];

export function planFormat(input: FmtInput): FmtPlan {
  const { formatter, tool, file, cwd } = input;
  if (input.custom?.trim()) {
    const [program, ...args] = expandTemplate(input.custom, file);
    return { kind: "pipe", program, args, cwd, label: program };
  }
  if (formatter === "monaco") return { kind: "monaco" };
  if (formatter === "json" || formatter === "xml" || formatter === "sql") return { kind: "builtin", which: formatter };
  if (!tool) throw new Error(`${formatter} is not available`);

  const pipe = (args: string[], label = version(tool)) => ({
    kind: "pipe" as const,
    program: tool.program,
    args: [...tool.args, ...args],
    cwd,
    label,
  });

  switch (formatter) {
    case "py-ruff":
      return pipe(["-m", "ruff", "format", "--stdin-filename", file, "-"], "ruff");
    case "ruff":
      return pipe(["format", "--stdin-filename", file, "-"]);
    case "py-black":
      return pipe(["-m", "black", "-q", "--stdin-filename", file, "-"], "black");
    case "black":
      return pipe(["-q", "--stdin-filename", file, "-"]);
    case "py-autopep8":
      return pipe(["-m", "autopep8", "-"], "autopep8");
    case "autopep8":
      return pipe(["-"]);
    case "clang-format": {
      // .clang-format is found from the (assumed) file's folder; without one, use the
      // community style of the language (Google for Java, Microsoft for C#, LLVM for C/C++).
      const fallback = input.lang === "java" ? "Google" : input.lang === "csharp" ? "Microsoft" : "LLVM";
      return pipe([`--assume-filename=${file}`, `--fallback-style=${fallback}`]);
    }
    case "google-java-format":
      return pipe(["-"]);
    case "gofmt":
      return pipe([], "gofmt");
    case "rustfmt":
      return pipe(["--edition", input.rustEdition || "2021"]);
    case "prettier":
      return pipe(["--stdin-filepath", file]);
    case "dotnet-format":
      return {
        kind: "dotnet",
        program: tool.program,
        label: "dotnet format",
        targetFramework: `net${/^(\d+)/.exec(tool.version)?.[1] ?? "8"}.0`,
      };
  }
}

/**
 * Decide whether formatter output may replace the buffer. Never accept empty output for a
 * non-empty document: some formatters print nothing (and still exit 0) on a syntax error.
 */
export function acceptOutput(input: string, code: number | null, stdout: string, stderr: string): { ok: true } | { ok: false; error: string } {
  if (code !== 0) return { ok: false, error: firstLines(stderr || stdout) || `exit code ${code ?? "?"}` };
  if (!stdout.trim() && input.trim()) return { ok: false, error: firstLines(stderr) || "the formatter returned no output" };
  return { ok: true };
}

export function firstLines(text: string, n = 4): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(0, n)
    .join("\n");
}

/**
 * The smallest single edit turning `before` into `after`: strip the common prefix and suffix.
 * Keeps the cursor and scroll position stable when only part of the file changes.
 */
export function minimalEdit(before: string, after: string): { start: number; end: number; text: string } | null {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before.charCodeAt(endB - 1) === after.charCodeAt(endA - 1)) {
    endB--;
    endA--;
  }
  return { start, end: endB, text: after.slice(start, endA) };
}
