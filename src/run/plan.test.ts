import { describe, expect, it } from "vitest";
import { cargoPackageField, cargoPackageName, cmakeTarget, expandTemplate, langOf, Plan, PlanInput, planRun, safeName, splitArgs, Step, Tool } from "./plan";

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

  it("custom command: && chains build steps before the run", () => {
    const s = steps(planRun(base({ lang: "cpp", file: "/w/a.cpp", custom: "g++ {file} -o {dir}/{name} && {dir}/{name}" })));
    expect(s.map((x) => [x.kind, ...argv(x)])).toEqual([
      ["build", "g++", "/w/a.cpp", "-o", "/w/a"],
      ["run", "/w/a"],
    ]);
    expect("error" in planRun(base({ lang: "cpp", file: "/w/a.cpp", custom: "g++ {file} &&" }))).toBe(true);
  });

  it("c++: gcc compiles into the cache, then runs", () => {
    const p = planRun(base({ lang: "cpp", file: "C:\\w\\main.cpp", tools: { "g++": tool("C:\\mingw\\g++.exe") } }));
    const [build, run] = steps(p);
    expect(build.kind).toBe("build");
    expect(argv(build)).toEqual([
      "C:\\mingw\\g++.exe",
      "-std=c++20",
      "-Wall",
      "-Wextra",
      "-g",
      "-fdiagnostics-color=never",
      "C:\\w\\main.cpp",
      "-o",
      "C:\\cache\\run\\cpp\\main.exe",
    ]);
    expect(run).toMatchObject({ program: "C:\\cache\\run\\cpp\\main.exe", args: [], cwd: "C:\\w", kind: "run" });
    // The output folder gets created by writing a file into it.
    expect("files" in p && p.files?.[0].rel).toBe("cpp/obj/.keep");
  });

  it("c: clang on Linux links libm, no .exe", () => {
    const s = steps(planRun(base({ lang: "c", file: "/w/m.c", windows: false, cacheDir: "/c", tools: { gcc: null, clang: tool("/usr/bin/clang") } })));
    expect(argv(s[0])).toEqual(["/usr/bin/clang", "-std=c17", "-Wall", "-Wextra", "-g", "-fdiagnostics-color=never", "/w/m.c", "-o", "/c/c/m", "-lm"]);
    expect(s[1].program).toBe("/c/c/m");
  });

  it("c++: MSVC builds through a generated script that sets up cl", () => {
    const vcvars = "C:\\VS\\VC\\Auxiliary\\Build\\vcvars64.bat";
    const p = planRun(base({ lang: "cpp", file: "C:\\w\\100%.cpp", tools: { "g++": null, "clang++": null, msvc: tool(vcvars) } }));
    if ("error" in p) throw new Error(p.error);
    const script = p.files!.find((f) => f.rel.endsWith(".bat"))!;
    expect(script.rel).toBe("cpp/build_App_100_.bat");
    expect(script.content).toContain(`call "${vcvars}" >nul 2>&1 || goto vcvars_failed`);
    // % doubled for cmd; the folder's trailing backslash doubled so it doesn't escape the quote.
    expect(script.content).toContain('/Fe"C:\\cache\\run\\cpp\\App_100_.exe" /Fo"C:\\cache\\run\\cpp\\obj\\\\" "C:\\w\\100%%.cpp"');
    expect(script.content).toContain("/std:c++20");
    expect(p.steps.map((s) => s.program)).toEqual(["C:\\cache\\run\\cpp\\build_App_100_.bat", "C:\\cache\\run\\cpp\\App_100_.exe"]);
  });

  it("c / c++: CMake project builds its target in our own build folder", () => {
    const project = { cmakeLists: "C:\\w\\CMakeLists.txt", cmakeTarget: "demo" };
    const s = steps(planRun(base({ lang: "cpp", file: "C:\\w\\src\\main.cpp", project, tools: { cmake: tool("cmake") } })));
    expect(s.map((x) => x.kind)).toEqual(["build", "build", "run"]);
    const build = s[0].args[3];
    expect(build).toMatch(/^C:\\cache\\run\\cmake\\w_[0-9a-f]{8}$/);
    expect(s[0].args).toContain(`-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_DEBUG=${build}\\bin`);
    expect(s[1].args).toEqual(["--build", build, "--target", "demo", "--config", "Debug"]);
    expect(s[2]).toMatchObject({ program: `${build}\\bin\\demo.exe`, cwd: "C:\\w\\src" });
  });

  it("c / c++: helpful errors when nothing is installed", () => {
    const p = planRun(base({ lang: "c", file: "/w/a.c", tools: { gcc: null, clang: null, msvc: null } }));
    expect("error" in p && p.error).toMatch(/No C compiler found.*build-essential/);
  });
});

describe("cmakeTarget", () => {
  const list = `cmake_minimum_required(VERSION 3.20)
project(Demo CXX)
# add_executable(old old.cpp)
add_executable(server src/server.cpp src/net.cpp)
add_executable(client "src/client.cpp")
add_executable(\${PROJECT_NAME}_x x.cpp)`;
  it("picks the target listing the file", () => {
    expect(cmakeTarget(list, "C:\\w\\src\\client.cpp")).toBe("client");
    expect(cmakeTarget(list, "/w/src/net.cpp")).toBe("server");
  });
  it("falls back to the only target, else gives up", () => {
    expect(cmakeTarget(list, "/w/other.cpp")).toBeNull();
    expect(cmakeTarget("project(a)\nadd_executable(app main.cpp)", "/w/helper.cpp")).toBe("app");
    // A sub-directory list (no project()) can't be configured by itself.
    expect(cmakeTarget("add_executable(app main.cpp)", "/w/main.cpp")).toBeNull();
  });
});

describe("langOf: C / C++", () => {
  it("sources run, headers don't", () => {
    expect(langOf("cpp", "a.cc")).toBe("cpp");
    expect(langOf("plaintext", "a.C")).toBe("c");
    expect(langOf("c", "new 1")).toBe("c");
    expect(langOf("cpp", "a.hpp")).toBeNull();
    expect(langOf("c", "a.h")).toBeNull();
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
