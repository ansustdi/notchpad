import { describe, expect, it } from "vitest";
import { findLocations } from "./links";

const one = (text: string) => {
  const l = findLocations(text);
  expect(l).toHaveLength(1);
  return { path: l[0].path, line: l[0].line, column: l[0].column, text: text.slice(l[0].index, l[0].index + l[0].length) };
};

describe("findLocations", () => {
  it("python tracebacks", () => {
    expect(one('  File "C:\\w\\a b\\main.py", line 12, in boom')).toMatchObject({ path: "C:\\w\\a b\\main.py", line: 12, column: 0 });
  });

  it("go and rust compiler errors", () => {
    expect(one("./main.go:7:2: undefined: fmt.Printn")).toMatchObject({ path: "./main.go", line: 7, column: 2 });
    expect(one("  --> src/main.rs:3:5")).toMatchObject({ path: "src/main.rs", line: 3, column: 5 });
    expect(one("C:\\w\\hello.rs:2:13")).toMatchObject({ path: "C:\\w\\hello.rs", line: 2, column: 13 });
  });

  it("node stacks, including file:// URLs", () => {
    expect(one("    at boom (C:\\w\\app.js:4:9)")).toMatchObject({ path: "C:\\w\\app.js", line: 4, column: 9 });
    expect(one("    at file:///C:/w/my%20app.mjs:10:3")).toMatchObject({ path: "C:/w/my app.mjs", line: 10, column: 3 });
    expect(one("/home/u/x.ts:8")).toMatchObject({ path: "/home/u/x.ts", line: 8 });
  });

  it("java stacks", () => {
    expect(one("\tat Hello.main(Hello.java:5)")).toMatchObject({ path: "Hello.java", line: 5 });
  });

  it("C# / MSBuild errors", () => {
    expect(one("C:\\w\\Program.cs(3,18): error CS1002: ; expected [C:\\w\\App.csproj]")).toMatchObject({
      path: "C:\\w\\Program.cs",
      line: 3,
      column: 18,
    });
  });

  it("C / C++ errors: gcc, clang and MSVC", () => {
    expect(one("C:\\w\\main.cpp:5:3: error: 'x' was not declared")).toMatchObject({ path: "C:\\w\\main.cpp", line: 5, column: 3 });
    expect(one("/home/u/a.c:12:1: warning: unused")).toMatchObject({ path: "/home/u/a.c", line: 12, column: 1 });
    expect(one("C:\\w\\main.cpp(7): error C2065: 'y': undeclared identifier")).toMatchObject({ path: "C:\\w\\main.cpp", line: 7, column: 0 });
    expect(one("In file included from util.hpp:3,")).toMatchObject({ path: "util.hpp", line: 3 });
  });

  it("absolute paths with spaces at the start of a line", () => {
    expect(one("C:\\My Code\\main.cpp:2:10: error: 'y' was not declared")).toMatchObject({ path: "C:\\My Code\\main.cpp", line: 2, column: 10 });
    expect(one("C:\\My Code\\main.cpp(2): error C2065: 'y'")).toMatchObject({ path: "C:\\My Code\\main.cpp", line: 2 });
    expect(one("/home/u/my app/main.go:7:2: undefined: x")).toMatchObject({ path: "/home/u/my app/main.go", line: 7, column: 2 });
    // Mid-line, a space still ends the path.
    expect(one("see the file x.go:3 here").path).toBe("x.go");
  });

  it("finds several and ignores unrelated text", () => {
    const l = findLocations("a.go:1 and b.rs:2:3 but not version 1.2:3 or http://x.com:80");
    expect(l.map((x) => `${x.path}:${x.line}`)).toEqual(["a.go:1", "b.rs:2"]);
  });
});
