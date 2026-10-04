/**
 * Decides how to run a file: which tool, which arguments, in which folder, and whether a
 * build step comes first. Pure (no I/O) so every language's rules are unit-tested; the
 * run store gathers the inputs (detected tools, project files) and executes the plan.
 */

export type Lang = "python" | "javascript" | "typescript" | "go" | "java" | "csharp" | "rust" | "c" | "cpp";
export type ToolKind =
  | "python"
  | "node"
  | "deno"
  | "bun"
  | "tsx"
  | "go"
  | "java"
  | "dotnet"
  | "cargo"
  | "rustc"
  | "gcc"
  | "g++"
  | "clang"
  | "clang++"
  | "msvc"
  | "cmake";

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
  c: "C",
  cpp: "C++",
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
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  "c++": "cpp",
};

const MONACO: Record<string, Lang> = {
  python: "python",
  javascript: "javascript",
  typescript: "typescript",
  go: "go",
  java: "java",
  csharp: "csharp",
  rust: "rust",
  c: "c",
  cpp: "cpp",
};

/** File extension (lower case, no dot) or "". */
export const extOf = (name: string) => /\.([^.\\/]+)$/.exec(name)?.[1].toLowerCase() ?? "";

/** Runnable language of a document: its extension wins, then the editor's language mode. */
export function langOf(monacoLanguage: string, fileName: string): Lang | null {
  // Headers aren't programs (Monaco shows them as C / C++).
  if (/^(h|hh|hpp|hxx|inl)$/.test(extOf(fileName))) return null;
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
  c: "c",
  cpp: "cpp",
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
    case "c":
      return project.cmakeTarget ? ["cmake"] : ["gcc", "clang", "msvc"];
    case "cpp":
      return project.cmakeTarget ? ["cmake"] : ["g++", "clang++", "msvc"];
  }
}

/** Project files that change how a language runs. */
export const PROJECT_FILES: Partial<Record<Lang, { key: keyof Project; names: string[] }>> = {
  go: { key: "goMod", names: ["go.mod"] },
  rust: { key: "cargoToml", names: ["Cargo.toml"] },
  csharp: { key: "csproj", names: ["*.csproj"] },
  c: { key: "cmakeLists", names: ["CMakeLists.txt"] },
  cpp: { key: "cmakeLists", names: ["CMakeLists.txt"] },
};

export interface Project {
  goMod?: string | null;
  cargoToml?: string | null;
  /** `[package] name` from Cargo.toml: the default binary's name. */
  cargoPackage?: string | null;
  csproj?: string | null;
  cmakeLists?: string | null;
  /** Executable target of CMakeLists.txt that builds the file (see `cmakeTarget`). */
  cmakeTarget?: string | null;
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

/**
 * The `add_executable` target of a top-level CMakeLists.txt that builds `fileName`: the one
 * listing the file, else the only one. Null when there's no `project()` (a sub-directory list
 * can't be configured on its own) or no clear choice; the file is then compiled by itself.
 */
export function cmakeTarget(text: string, fileName: string): string | null {
  const code = text.replace(/#.*$/gm, "");
  if (!/\bproject\s*\(/i.test(code)) return null;
  const targets = [...code.matchAll(/\badd_executable\s*\(\s*([^\s()]+)([^)]*)\)/gi)]
    .map((m) => ({ name: m[1], body: m[2] }))
    .filter((t) => !t.name.includes("$"));
  const file = basename(fileName).toLowerCase();
  const listing = targets.filter((t) => t.body.split(/[\s"/\\]+/).some((w) => w.toLowerCase() === file));
  if (listing.length === 1) return listing[0].name;
  return targets.length === 1 ? targets[0].name : null;
}

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

const CC_INSTALL =
  'Install a compiler: on Windows Visual Studio Build Tools ("Desktop development with C++") or MinGW-w64 (e.g. via MSYS2); on macOS run `xcode-select --install`; on Linux install gcc (e.g. `sudo apt install build-essential`).';

const INSTALL: Record<Lang, string> = {
  python: "Install Python from https://www.python.org (tick \"Add to PATH\"), or create a .venv next to your script.",
  javascript: "Install Node.js from https://nodejs.org (or Bun / Deno).",
  typescript: "Install Node.js 22.6+ from https://nodejs.org, or run `npm i -g tsx`, or install Deno / Bun.",
  go: "Install Go from https://go.dev/dl.",
  java: "Install a JDK 11 or newer, e.g. from https://adoptium.net, and set JAVA_HOME.",
  csharp: "Install the .NET SDK from https://dotnet.microsoft.com/download.",
  rust: "Install Rust from https://rustup.rs.",
  c: CC_INSTALL,
  cpp: CC_INSTALL,
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
    // `&&` chains commands (no shell involved): `g++ {file} -o {name} && ./{name}`.
    const parts: string[][] = [[]];
    for (const a of expandTemplate(input.custom, file)) {
      if (a === "&&") parts.push([]);
      else parts[parts.length - 1].push(a);
    }
    if (parts.some((p) => !p.length)) return { error: "The custom run command is empty or has an empty part around &&" };
    return {
      steps: parts.map(([program, ...args], i) => ({ program, args, cwd: dir, kind: i < parts.length - 1 ? "build" : "run" })),
    };
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

    case "c":
    case "cpp":
      return planNative(input, found);
  }
}

/** C and C++: a CMake project's target, or the single file compiled into the run cache. */
function planNative(input: PlanInput, found: [ToolKind, Tool] | null): Plan {
  const { lang, file, project, cacheDir, windows } = input;
  const dir = dirname(file);
  const cpp = lang === "cpp";
  const exeExt = windows ? ".exe" : "";

  if (project.cmakeLists && project.cmakeTarget) {
    if (!found) return { error: `CMake not found (needed for ${basename(project.cmakeLists)}). Install it from https://cmake.org.` };
    const t = found[1];
    const root = dirname(project.cmakeLists);
    // Our own build folder (never the project's), with executables collected in one place so
    // the run step finds them with every generator (multi-config ones would add Debug/).
    const build = join(cacheDir, "cmake", `${safeName(basename(root))}_${hash(root)}`);
    const out = join(build, "bin");
    const target = project.cmakeTarget;
    const configure = [
      "-S",
      root,
      "-B",
      build,
      "-DCMAKE_BUILD_TYPE=Debug",
      `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY=${out}`,
      `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_DEBUG=${out}`,
    ];
    return {
      steps: [
        { ...toArgv(t, ...configure), cwd: root, kind: "build" },
        { ...toArgv(t, "--build", build, "--target", target, "--config", "Debug"), cwd: root, kind: "build" },
        { program: join(out, target + exeExt), args: [], cwd: dir, kind: "run" },
      ],
    };
  }

  if (!found) return { error: `No ${LANG_LABEL[lang]} compiler found. ${CC_INSTALL}` };
  const [kind, t] = found;
  const name = safeName(stem(file));
  const exe = join(cacheDir, lang, name + exeExt);
  // Compilers don't create the output folder; writing a file there does.
  const files: WriteFile[] = [{ rel: `${lang}/obj/.keep`, content: "" }];

  if (kind === "msvc") {
    // `cl` only works after vcvars64.bat has set up its environment: a generated script does both.
    const bat = (s: string) => s.replace(/%/g, "%%");
    const script = [
      "@echo off",
      // vcvars prints harmless noise on stderr; report real failures ourselves. (No ( ) blocks:
      // "Program Files (x86)" would end them.)
      `call "${bat(t.program)}" >nul 2>&1 || goto vcvars_failed`,
      `cl /nologo /utf-8 /EHsc /W4 ${cpp ? "/std:c++20 /Zc:__cplusplus" : "/std:c17"} /Fe"${bat(exe)}" /Fo"${bat(join(cacheDir, lang, "obj"))}\\\\" "${bat(file)}"`,
      "exit /b %errorlevel%",
      ":vcvars_failed",
      `echo Setting up Visual C++ failed: "${bat(t.program)}" 1>&2`,
      "exit /b 1",
      "",
    ].join("\r\n");
    files.push({ rel: `${lang}/build_${name}.bat`, content: script });
    return {
      files,
      steps: [
        { program: join(cacheDir, lang, `build_${name}.bat`), args: [], cwd: dir, kind: "build" },
        { program: exe, args: [], cwd: dir, kind: "run" },
      ],
    };
  }

  const args = [
    cpp ? "-std=c++20" : "-std=c17",
    "-Wall",
    "-Wextra",
    "-g",
    "-fdiagnostics-color=never",
    file,
    "-o",
    exe,
    // libm is separate from libc on Linux.
    ...(cpp || windows ? [] : ["-lm"]),
  ];
  return {
    files,
    steps: [
      { ...toArgv(t, ...args), cwd: dir, kind: "build" },
      { program: exe, args: [], cwd: dir, kind: "run" },
    ],
  };
}

/** Short stable hash of a path (one CMake build folder per project). */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of s.replace(/\\/g, "/").toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}
