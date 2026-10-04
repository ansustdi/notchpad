import { describe, expect, it } from "vitest";
import { cargoPackageField, cargoPackageName, expandTemplate, langOf, Plan, PlanInput, planRun, safeName, splitArgs, Step, Tool } from "./plan";

const tool = (program: string, version = "1.0", extra: Partial<Tool> = {}): Tool => ({
  program,
  args: [],
  version,
  source: "PATH",
  ...extra,
});

const base = (over: Partial<PlanInput>): PlanInput => ({
  lang: "python",
  file: "C:\\work\\app\\main.py",
  source: "",
  tools: {},
  project: {},
  cacheDir: "C:\\cache\\run",
  windows: true,
  ...over,
});

function steps(p: Plan): Step[] {
  if ("error" in p) throw new Error(p.error);
  return p.steps;
}

const argv = (s: Step) => [s.program, ...s.args];

describe("langOf", () => {
  it("prefers the extension, then the editor language", () => {
    expect(langOf("plaintext", "x.go")).toBe("go");
    expect(langOf("plaintext", "App.CS")).toBe("csharp");
    expect(langOf("typescript", "new 3")).toBe("typescript");
    expect(langOf("markdown", "README.md")).toBeNull();
  });
});

describe("planRun", () => {
  it("python: interpreter args, -u, env", () => {
    const p = planRun(base({ tools: { python: tool("py", "Python 3.12", { args: ["-3"] }) } }));
    expect(argv(steps(p)[0])).toEqual(["py", "-3", "-u", "C:\\work\\app\\main.py"]);
    expect(steps(p)[0].cwd).toBe("C:\\work\\app");
    expect("env" in p && p.env).toContainEqual(["PYTHONIOENCODING", "utf-8"]);
  });

  it("javascript: node, else deno with permissions", () => {
    const f = "/w/a.js";
    expect(argv(steps(planRun(base({ lang: "javascript", file: f, tools: { node: tool("node") } })))[0])).toEqual(["node", f]);
    expect(argv(steps(planRun(base({ lang: "javascript", file: f, tools: { deno: tool("deno") } })))[0])).toEqual([
      "deno",
      "run",
      "-A",
      f,
    ]);
  });

  it("typescript: tsx first, node type stripping only on 22.6+ and not for .tsx", () => {
    const f = "/w/a.ts";
    const both = { tsx: tool("/w/node_modules/.bin/tsx"), node: tool("node", "v22.16.0") };
    expect(steps(planRun(base({ lang: "typescript", file: f, tools: both })))[0].program).toBe("/w/node_modules/.bin/tsx");
    expect(argv(steps(planRun(base({ lang: "typescript", file: f, tools: { node: tool("node", "v22.16.0") } })))[0])).toEqual([
      "node",
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      f,
    ]);
    const old = planRun(base({ lang: "typescript", file: f, tools: { node: tool("node", "v20.11.0") } }));
    expect("error" in old && old.error).toMatch(/needs 22\.6/);
    const tsx = planRun(base({ lang: "typescript", file: "/w/a.tsx", tools: { node: tool("node", "v24.0.0") } }));
    expect("error" in tsx && tsx.error).toMatch(/\.tsx/);
  });

  it("go: package run inside a module, file run otherwise", () => {
    const f = "/w/cmd/tool/main.go";
    expect(argv(steps(planRun(base({ lang: "go", file: f, tools: { go: tool("go") }, project: { goMod: "/w/go.mod" } })))[0])).toEqual([
      "go",
      "run",
      ".",
    ]);
    const s = steps(planRun(base({ lang: "go", file: f, tools: { go: tool("go") } })))[0];
    expect(argv(s)).toEqual(["go", "run", f]);
    expect(s.cwd).toBe("/w/cmd/tool");
  });

  it("java: single-file launch; explains a too-old Java", () => {
    const f = "C:\\w\\Hello.java";
    expect(argv(steps(planRun(base({ lang: "java", file: f, tools: { java: tool("C:\\jdk\\bin\\java.exe", "openjdk 21") } })))[0])).toEqual([
      "C:\\jdk\\bin\\java.exe",
      f,
    ]);
    const old = planRun(base({ lang: "java", file: f, tools: { java: tool("", "Java 8 (too old…)", { source: "too-old" }) } }));
    expect("error" in old && old.error).toMatch(/Java 8.*JDK 11/);
  });

  it("csharp: project run, .NET 10 file run, generated project on older SDKs", () => {
    const f = "C:\\w\\src\\Hello.cs";
    const dotnet = (v: string) => ({ dotnet: tool("dotnet", v) });
    expect(argv(steps(planRun(base({ lang: "csharp", file: f, tools: dotnet("9.0.200"), project: { csproj: "C:\\w\\App.csproj" } })))[0])).toEqual([
      "dotnet",
      "run",
      "--project",
      "C:\\w\\App.csproj",
    ]);
    expect(argv(steps(planRun(base({ lang: "csharp", file: f, tools: dotnet("10.0.100") })))[0])).toEqual(["dotnet", "run", f]);

    const p = planRun(base({ lang: "csharp", file: f, source: 'Console.WriteLine("hi");', tools: dotnet("9.0.200") }));
    if ("error" in p) throw new Error(p.error);
    expect(p.files?.map((x) => x.rel)).toEqual(["cs/Hello/Hello.csproj", "cs/Hello/Program.cs"]);
    expect(p.files?.[0].content).toContain("<TargetFramework>net9.0</TargetFramework>");
    expect(p.files?.[1].content).toBe('Console.WriteLine("hi");');
    expect(argv(p.steps[0])).toEqual(["dotnet", "run", "--project", "C:\\cache\\run\\cs\\Hello\\Hello.csproj"]);
    expect(p.steps[0].cwd).toBe("C:\\w\\src");
  });

  it("rust: cargo targets, else compile then run", () => {
    const cargo = { cargo: tool("cargo") };
    const proj = { cargoToml: "/w/Cargo.toml" };
    const run = (file: string) => argv(steps(planRun(base({ lang: "rust", file, tools: cargo, project: proj })))[0]);
    expect(run("/w/src/main.rs")).toEqual(["cargo", "run", "-q"]);
    const named = { ...proj, cargoPackage: "tool" };
    const runNamed = (file: string) => argv(steps(planRun(base({ lang: "rust", file, tools: cargo, project: named })))[0]);
    expect(runNamed("/w/src/main.rs")).toEqual(["cargo", "run", "-q", "--bin", "tool"]);
    expect(runNamed("/w/src/util/mod.rs")).toEqual(["cargo", "run", "-q", "--bin", "tool"]);
    expect(runNamed("/w/src/bin/fetch.rs")).toEqual(["cargo", "run", "-q", "--bin", "fetch"]);
    expect(run("/w/src/bin/fetch.rs")).toEqual(["cargo", "run", "-q", "--bin", "fetch"]);
    expect(run("/w/src/bin/sync/main.rs")).toEqual(["cargo", "run", "-q", "--bin", "sync"]);
    expect(run("/w/examples/demo.rs")).toEqual(["cargo", "run", "-q", "--example", "demo"]);

    const s = steps(planRun(base({ lang: "rust", file: "C:\\w\\hello world.rs", tools: { rustc: tool("rustc") } })));
    expect(s.map((x) => x.kind)).toEqual(["build", "run"]);
    expect(argv(s[0])).toEqual(["rustc", "--edition", "2021", "-o", "C:\\cache\\run\\rs\\hello_world.exe", "C:\\w\\hello world.rs"]);
    expect(s[1].program).toBe("C:\\cache\\run\\rs\\hello_world.exe");
  });

  it("reports missing tools with an install hint", () => {
    const p = planRun(base({ lang: "go", file: "/w/a.go" }));
    expect("error" in p && p.error).toMatch(/Go not found.*go\.dev/);
  });

  it("custom command overrides the defaults", () => {
    const p = planRun(base({ lang: "javascript", file: "/w/my app.js", custom: 'node --inspect "{file}" --name={name}' }));
    expect(argv(steps(p)[0])).toEqual(["node", "--inspect", "/w/my app.js", "--name=my app"]);
  });
});

describe("helpers", () => {
  it("reads the package name from Cargo.toml", () => {
    const toml = '[workspace]\nname = "no"\n\n[package]\n# comment\nname = "my-tool" # trailing\nversion = "0.1.0"\n[dependencies]\nname = "no"\n';
    expect(cargoPackageName(toml)).toBe("my-tool");
    expect(cargoPackageName("[dependencies]\nserde = '1'")).toBeNull();
    expect(cargoPackageField('[package]\nname = "x"\nedition = "2024"\n', "edition")).toBe("2024");
  });

  it("splits quoted args and expands templates", () => {
    expect(splitArgs(`a "b c" 'd e' ""`)).toEqual(["a", "b c", "d e", ""]);
    expect(expandTemplate("x {dir}/{name}.{ext}", "/a/b/c.rs")).toEqual(["x", "/a/b/c.rs"]);
    expect(safeName("1st-try")).toBe("App_1st_try");
  });
});
