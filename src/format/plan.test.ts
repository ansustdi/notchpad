import { describe, expect, it } from "vitest";
import { acceptOutput, fmtLangOf, FmtPlan, formattersFor, minimalEdit, planFormat } from "./plan";
import type { Tool } from "../run/plan";

const tool = (program: string, version = "x 1.0", args: string[] = []): Tool => ({ program, args, version, source: "PATH" });

const pipeArgs = (p: FmtPlan) => {
  if (p.kind !== "pipe") throw new Error(`expected pipe, got ${p.kind}`);
  return [p.program, ...p.args];
};

describe("fmtLangOf", () => {
  it("maps extensions and editor languages", () => {
    expect(fmtLangOf("plaintext", "main.cpp")).toBe("cpp");
    expect(fmtLangOf("plaintext", "util.h")).toBe("c");
    expect(fmtLangOf("plaintext", "App.CS")).toBe("csharp");
    expect(fmtLangOf("python", "new 1")).toBe("python");
    expect(fmtLangOf("plaintext", "notes.txt")).toBeNull();
  });

  it("orders python formatters: project interpreter first", () => {
    expect(formattersFor("python").slice(0, 3)).toEqual(["py-ruff", "py-black", "ruff"]);
    expect(formattersFor("typescript")).toEqual(["prettier", "monaco"]);
  });
});

describe("planFormat", () => {
  const base = { file: "C:\\w\\src\\a.py", cwd: "C:\\w\\src" };

  it("python formatters pass the file name so project config applies", () => {
    expect(pipeArgs(planFormat({ ...base, lang: "python", formatter: "black", tool: tool("black") }))).toEqual([
      "black",
      "-q",
      "--stdin-filename",
      "C:\\w\\src\\a.py",
      "-",
    ]);
    const venv = tool("C:\\w\\.venv\\Scripts\\python.exe", "Python 3.12");
    expect(pipeArgs(planFormat({ ...base, lang: "python", formatter: "py-ruff", tool: venv }))).toEqual([
      "C:\\w\\.venv\\Scripts\\python.exe",
      "-m",
      "ruff",
      "format",
      "--stdin-filename",
      "C:\\w\\src\\a.py",
      "-",
    ]);
    const py = tool("py", "Python 3.12", ["-3"]);
    expect(pipeArgs(planFormat({ ...base, lang: "python", formatter: "py-autopep8", tool: py }))).toEqual(["py", "-3", "-m", "autopep8", "-"]);
  });

  it("clang-format uses the language's community style as fallback", () => {
    const cf = tool("C:\\LLVM\\bin\\clang-format.exe", "clang-format version 22.1.6 (https://…)");
    const p = planFormat({ lang: "java", formatter: "clang-format", tool: cf, file: "/w/A.java", cwd: "/w" });
    expect(pipeArgs(p)).toEqual(["C:\\LLVM\\bin\\clang-format.exe", "--assume-filename=/w/A.java", "--fallback-style=Google"]);
    expect(p.kind === "pipe" && p.label).toBe("clang-format 22.1.6");
    expect(pipeArgs(planFormat({ lang: "cpp", formatter: "clang-format", tool: cf, file: "/w/a.cpp", cwd: "/w" }))[2]).toBe("--fallback-style=LLVM");
    expect(pipeArgs(planFormat({ lang: "csharp", formatter: "clang-format", tool: cf, file: "/w/a.cs", cwd: "/w" }))[2]).toBe("--fallback-style=Microsoft");
  });

  it("rustfmt gets the crate's edition", () => {
    const rf = tool("rustfmt");
    expect(pipeArgs(planFormat({ lang: "rust", formatter: "rustfmt", tool: rf, file: "/w/a.rs", cwd: "/w", rustEdition: "2024" }))).toEqual([
      "rustfmt",
      "--edition",
      "2024",
    ]);
    expect(pipeArgs(planFormat({ lang: "rust", formatter: "rustfmt", tool: rf, file: "/w/a.rs", cwd: "/w" }))).toEqual(["rustfmt", "--edition", "2021"]);
  });

  it("other formatters and fallbacks", () => {
    expect(pipeArgs(planFormat({ lang: "go", formatter: "gofmt", tool: tool("gofmt"), file: "/w/a.go", cwd: "/w" }))).toEqual(["gofmt"]);
    expect(pipeArgs(planFormat({ lang: "typescript", formatter: "prettier", tool: tool("prettier"), file: "/w/a.ts", cwd: "/w" }))).toEqual([
      "prettier",
      "--stdin-filepath",
      "/w/a.ts",
    ]);
    expect(planFormat({ lang: "typescript", formatter: "monaco", tool: null, file: "/w/a.ts", cwd: "/w" })).toEqual({ kind: "monaco" });
    expect(planFormat({ lang: "csharp", formatter: "dotnet-format", tool: tool("dotnet", "9.0.200"), file: "/w/a.cs", cwd: "/w" })).toEqual({
      kind: "dotnet",
      program: "dotnet",
      label: "dotnet format",
      targetFramework: "net9.0",
    });
    expect(() => planFormat({ lang: "go", formatter: "gofmt", tool: null, file: "/w/a.go", cwd: "/w" })).toThrow(/not available/);
  });

  it("custom command wins", () => {
    const p = planFormat({ lang: "go", formatter: "gofmt", tool: null, file: "/w/a b.go", cwd: "/w", custom: "goimports -srcdir {dir}" });
    expect(pipeArgs(p)).toEqual(["goimports", "-srcdir", "/w"]);
  });
});

describe("acceptOutput", () => {
  it("rejects failures and suspicious empty output", () => {
    expect(acceptOutput("x", 0, "x\n", "")).toEqual({ ok: true });
    expect(acceptOutput("", 0, "", "")).toEqual({ ok: true });
    const bad = acceptOutput("fn main( {", 1, "", "error: this file contains an unclosed delimiter\n --> <stdin>:1:12\n");
    expect(bad).toEqual({ ok: false, error: "error: this file contains an unclosed delimiter\n --> <stdin>:1:12" });
    // Exit 0 but nothing printed: never wipe the document.
    expect(acceptOutput("code", 0, "", "").ok).toBe(false);
  });
});

describe("minimalEdit", () => {
  it("replaces only the changed middle", () => {
    expect(minimalEdit("same", "same")).toBeNull();
    const apply = (before: string, after: string) => {
      const e = minimalEdit(before, after)!;
      return before.slice(0, e.start) + e.text + before.slice(e.end);
    };
    for (const [b, a] of [
      ["a  = 1\nb=2\n", "a = 1\nb = 2\n"],
      ["fn main(){}", "fn main() {}\n"],
      ["x\r\ny", "x\ny"],
      ["", "new"],
    ]) {
      expect(apply(b, a)).toBe(a);
    }
    // Unchanged head and tail stay untouched.
    expect(minimalEdit("head MID tail", "head mid tail")).toEqual({ start: 5, end: 8, text: "mid" });
    expect(minimalEdit("abc", "abcd")).toEqual({ start: 3, end: 3, text: "d" });
    expect(minimalEdit("xabc", "abc")).toEqual({ start: 0, end: 1, text: "" });
  });
});
