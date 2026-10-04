/**
 * Decides how to run a file: which tool, which arguments, in which folder, and whether a
 * build step comes first. Pure (no I/O) so every language's rules are unit-tested; the
 * run store gathers the inputs (detected tools, project files) and executes the plan.
 */

export type Lang = "python" | "javascript" | "typescript" | "go" | "java" | "csharp" | "rust";
export type ToolKind = "python" | "node" | "deno" | "bun" | "tsx" | "go" | "java" | "dotnet" | "cargo" | "rustc";

export interface Tool {
  program: string;
  args: string[];
  version: string;
  /** "PATH", "venv", "project", "JAVA_HOME"… or "too-old" for a rejected Java. */
  source: string;
}

export interface Step {
  program: string;
  args: string[];
  cwd: string;
  /** Build steps run first; the run step only starts if they succeed. */
  kind: "build" | "run";
}

export interface WriteFile {
  /** Path relative to the run cache directory. */
  rel: string;
  content: string;
}

export type Plan = { steps: Step[]; files?: WriteFile[]; env?: [string, string][] } | { error: string };

export const LANG_LABEL: Record<Lang, string> = {
  python: "Python",
  javascript: "JavaScript",
  typescript: "TypeScript",
  go: "Go",
  java: "Java",
  csharp: "C#",
  rust: "Rust",
};

const EXT: Record<string, Lang> = {
  py: "python",
  pyw: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  go: "go",
  java: "java",
  cs: "csharp",
  rs: "rust",
};

const MONACO: Record<string, Lang> = {
  python: "python",
  javascript: "javascript",
  typescript: "typescript",
  go: "go",
  java: "java",
  csharp: "csharp",
  rust: "rust",
};

/** File extension (lower case, no dot) or "". */
export const extOf = (name: string) => /\.([^.\\/]+)$/.exec(name)?.[1].toLowerCase() ?? "";

/** Runnable language of a document: its extension wins, then the editor's language mode. */
export function langOf(monacoLanguage: string, fileName: string): Lang | null {
  return EXT[extOf(fileName)] ?? MONACO[monacoLanguage] ?? null;
}

/** Preferred file extension when an unsaved buffer must be written out to run. */
export const DEFAULT_EXT: Record<Lang, string> = {
  python: "py",
  javascript: "js",
  typescript: "ts",
  go: "go",
  java: "java",
  csharp: "cs",
  rust: "rs",
};

/** Tools to look for, in preference order; the first one found is used. */
export function toolsFor(lang: Lang, project: Project): ToolKind[] {
  switch (lang) {
    case "python":
      return ["python"];
    case "javascript":
      return ["node", "bun", "deno"];
    case "typescript":
      return ["tsx", "deno", "bun", "node"];
    case "go":
      return ["go"];
    case "java":
      return ["java"];
    case "csharp":
      return ["dotnet"];
    case "rust":
      return project.cargoToml ? ["cargo"] : ["rustc"];
  }
}

/** Project files that change how a language runs. */
export const PROJECT_FILES: Partial<Record<Lang, { key: keyof Project; names: string[] }>> = {
  go: { key: "goMod", names: ["go.mod"] },
  rust: { key: "cargoToml", names: ["Cargo.toml"] },
  csharp: { key: "csproj", names: ["*.csproj"] },
};

export interface Project {
  goMod?: string | null;
  cargoToml?: string | null;
  /** `[package] name` from Cargo.toml: the default binary's name. */
  cargoPackage?: string | null;
  csproj?: string | null;
}

/** A string field (e.g. `name`, `edition`) of the `[package]` table in a Cargo.toml. */
export function cargoPackageField(toml: string, field: string): string | null {
  let inPackage = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (/^\[.*\]$/.test(line)) inPackage = line === "[package]";
    else if (inPackage) {
      const m = new RegExp(`^${field}\\s*=\\s*["']([^"']+)["']`).exec(line);
      if (m) return m[1];
    }
  }
  return null;
}

export const cargoPackageName = (toml: string) => cargoPackageField(toml, "name");

export interface PlanInput {
  lang: Lang;
  /** Absolute path of the file to run (a temp copy for unsaved buffers). */
  file: string;
  /** Text of the file (needed when a throwaway project is generated around it). */
  source: string;
  tools: Partial<Record<ToolKind, Tool | null>>;
  project: Project;
  cacheDir: string;
  windows: boolean;
  /** User override, e.g. `node --inspect {file}`. */
  custom?: string;
}

const INSTALL: Record<Lang, string> = {
  python: "Install Python from https://www.python.org (tick \"Add to PATH\"), or create a .venv next to your script.",
  javascript: "Install Node.js from https://nodejs.org (or Bun / Deno).",
  typescript: "Install Node.js 22.6+ from https://nodejs.org, or run `npm i -g tsx`, or install Deno / Bun.",
  go: "Install Go from https://go.dev/dl.",
  java: "Install a JDK 11 or newer, e.g. from https://adoptium.net, and set JAVA_HOME.",
  csharp: "Install the .NET SDK from https://dotnet.microsoft.com/download.",
  rust: "Install Rust from https://rustup.rs.",
};

export const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, "") || p;
export const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;
const stem = (p: string) => basename(p).replace(/\.[^.]*$/, "");
const join = (a: string, ...parts: string[]) => {
  const sep = a.includes("\\") ? "\\" : "/";
  return [a.replace(/[\\/]+$/, ""), ...parts].join(sep);
};

/** Identifier-safe name for generated projects / binaries. */
export function safeName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_]/g, "_") || "app";
  return /^[0-9]/.test(s) ? `App_${s}` : s;
}

/** Split a command template into argv, honouring "double" and 'single' quotes. */
export function splitArgs(template: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  let has = false;
  for (const c of template) {
    if (quote) {
      if (c === quote) quote = "";
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** `{file}`, `{dir}`, `{name}` (no extension) and `{ext}` in a custom command. */
export function expandTemplate(template: string, file: string): string[] {
  const vars: Record<string, string> = { file, dir: dirname(file), name: stem(file), ext: extOf(file) };
  return splitArgs(template).map((a) => a.replace(/\{(file|dir|name|ext)\}/g, (_, k: string) => vars[k]));
}

function nodeSupportsTypes(version: string): boolean {
  const m = /v?(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 22 || (major === 22 && minor >= 6);
}

function firstTool(input: PlanInput, kinds: ToolKind[]): [ToolKind, Tool] | null {
  for (const k of kinds) {
    const t = input.tools[k];
    if (t && t.program && t.source !== "too-old") return [k, t];
  }
  return null;
}

const toArgv = (t: Tool, ...rest: string[]) => ({ program: t.program, args: [...t.args, ...rest] });

export function planRun(input: PlanInput): Plan {
  const { lang, file } = input;
  const dir = dirname(file);

  if (input.custom?.trim()) {
    const [program, ...args] = expandTemplate(input.custom, file);
    if (!program) return { error: "The custom run command is empty" };
    return { steps: [{ program, args, cwd: dir, kind: "run" }] };
  }

  const found = firstTool(input, toolsFor(lang, input.project));
  const missing = (what: string): Plan => ({ error: `${what} not found. ${INSTALL[lang]}` });

  switch (lang) {
    case "python": {
      if (!found) return missing("No Python interpreter");
      return {
        steps: [{ ...toArgv(found[1], "-u", file), cwd: dir, kind: "run" }],
        // Live output, and Unicode-safe printing even on legacy Windows consoles.
        env: [
          ["PYTHONUNBUFFERED", "1"],
          ["PYTHONIOENCODING", "utf-8"],
        ],
      };
    }

    case "javascript": {
      if (!found) return missing("Node.js");
      const [kind, t] = found;
      const args = kind === "deno" ? ["run", "-A", file] : [file];
      return { steps: [{ ...toArgv(t, ...args), cwd: dir, kind: "run" }] };
    }

    case "typescript": {
      const isTsx = extOf(file) === "tsx";
      // Node's type stripping handles .ts but not .tsx, and needs Node 22.6+.
      const usable = toolsFor(lang, input.project).filter(
        (k) => k !== "node" || (!isTsx && nodeSupportsTypes(input.tools.node?.version ?? "")),
      );
      const pick = firstTool(input, usable);
      if (!pick) {
        const node = input.tools.node;
        if (node && !isTsx) return { error: `Node ${node.version} can't run TypeScript directly (needs 22.6+). ${INSTALL.typescript}` };
        return missing(isTsx ? "A runner for .tsx (tsx, Deno or Bun)" : "A TypeScript runner");
      }
      const [kind, t] = pick;
      const args =
        kind === "deno"
          ? ["run", "-A", file]
          : kind === "node"
            ? ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", file]
            : [file];
      return { steps: [{ ...toArgv(t, ...args), cwd: dir, kind: "run" }] };
    }

    case "go": {
      if (!found) return missing("Go");
      // Inside a module, run the whole package (other files in the folder are part of it).
      const args = input.project.goMod ? ["run", "."] : ["run", file];
      return { steps: [{ ...toArgv(found[1], ...args), cwd: dir, kind: "run" }] };
    }

    case "java": {
      const old = input.tools.java;
      if (old?.source === "too-old") return { error: `${old.version}. ${INSTALL.java}` };
      if (!found) return missing("Java");
      // Java 11+ compiles and runs a single source file in one go.
      return { steps: [{ ...toArgv(found[1], file), cwd: dir, kind: "run" }] };
    }

    case "csharp": {
      if (!found) return missing("The .NET SDK");
      const t = found[1];
      if (input.project.csproj) {
        return {
          steps: [{ ...toArgv(t, "run", "--project", input.project.csproj), cwd: dirname(input.project.csproj), kind: "run" }],
          env: [["DOTNET_NOLOGO", "1"]],
        };
      }
      const major = Number(/^(\d+)/.exec(t.version)?.[1] ?? 0);
      if (major >= 10) {
        // .NET 10 runs a lone .cs file directly.
        return { steps: [{ ...toArgv(t, "run", file), cwd: dir, kind: "run" }], env: [["DOTNET_NOLOGO", "1"]] };
      }
      // Older SDKs need a project: generate a throwaway one around the file.
      const name = safeName(stem(file));
      const rel = `cs/${name}`;
      const csproj = join(input.cacheDir, "cs", name, `${name}.csproj`);
      return {
        files: [
          {
            rel: `${rel}/${name}.csproj`,
            content: [
              '<Project Sdk="Microsoft.NET.Sdk">',
              "  <PropertyGroup>",
              "    <OutputType>Exe</OutputType>",
              `    <TargetFramework>net${major || 8}.0</TargetFramework>`,
              "    <ImplicitUsings>enable</ImplicitUsings>",
              "    <Nullable>enable</Nullable>",
              "  </PropertyGroup>",
              "</Project>",
              "",
            ].join("\n"),
          },
          { rel: `${rel}/Program.cs`, content: input.source },
        ],
        // Working directory stays the file's folder so relative paths in the program behave.
        steps: [{ ...toArgv(t, "run", "--project", csproj), cwd: dir, kind: "run" }],
        env: [["DOTNET_NOLOGO", "1"]],
      };
    }

    case "rust": {
      if (!found) return missing(input.project.cargoToml ? "Cargo" : "rustc");
      const t = found[1];
      if (input.project.cargoToml) {
        const root = dirname(input.project.cargoToml);
        const rel = file.slice(root.length + 1).replace(/\\/g, "/");
        const target =
          /^src\/bin\/([^/]+)\.rs$/.exec(rel)?.[1] ?? /^src\/bin\/([^/]+)\/main\.rs$/.exec(rel)?.[1];
        const example = /^examples\/([^/]+)\.rs$/.exec(rel)?.[1];
        // Any other file under src/ belongs to the package's main binary; naming it keeps
        // `cargo run` unambiguous when src/bin/ holds more binaries.
        const main = !target && !example && rel.startsWith("src/") ? input.project.cargoPackage : null;
        const pick = target ? ["--bin", target] : example ? ["--example", example] : main ? ["--bin", main] : [];
        const args = ["run", "-q", ...pick];
        return { steps: [{ ...toArgv(t, ...args), cwd: root, kind: "run" }], env: [["CARGO_TERM_COLOR", "never"]] };
      }
      const exe = join(input.cacheDir, "rs", safeName(stem(file)) + (input.windows ? ".exe" : ""));
      return {
        steps: [
          { ...toArgv(t, "--edition", "2021", "-o", exe, file), cwd: dir, kind: "build" },
          { program: exe, args: [], cwd: dir, kind: "run" },
        ],
      };
    }
  }
}
