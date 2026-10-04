import { describe, expect, it } from "vitest";
import { parseProject, projectId, projectName, relativeTo, resolvePath, serializeProject } from "./project";
import { dropTarget } from "./tree";

describe("project files", () => {
  it("reads Sublime projects: relative paths, comments, trailing commas", () => {
    const text = `{
      // my project
      "folders": [
        { "path": "." },
        { "path": "../shared/lib", "name": "lib" },
        { "path": "D:/other", },
        { "nopath": true },
      ],
      "settings": { "tab_size": 4 } /* trailing */
    }`;
    const p = parseProject(text, "C:\\work\\app\\app.sublime-project");
    expect(p.name).toBe("app");
    expect(p.folders).toEqual([
      { path: "C:\\work\\app", name: undefined },
      { path: "C:\\work\\shared\\lib", name: "lib" },
      { path: "D:/other", name: undefined },
    ]);
  });

  it("writes folders relative to the project file when possible and keeps other keys", () => {
    const existing = '{ "folders": [], "settings": { "tab_size": 2 }, }';
    const json = serializeProject(["C:\\work\\app", "C:\\work\\app\\docs", "D:\\other"], "C:\\work\\app\\app.sublime-project", existing);
    expect(JSON.parse(json)).toEqual({
      folders: [{ path: "." }, { path: "docs" }, { path: "D:/other" }],
      settings: { tab_size: 2 },
    });
  });

  it("path helpers", () => {
    expect(resolvePath("/home/u/p", "./src/../lib")).toBe("/home/u/p/lib");
    expect(resolvePath("C:\\a\\b", "C:\\x")).toBe("C:\\x");
    expect(relativeTo("C:\\a", "c:/A/b/c")).toBe("b/c");
    expect(relativeTo("C:\\a", "C:\\ab")).toBeNull();
    expect(projectName("C:\\p\\My App.sublime-project")).toBe("My App");
  });

  it("project ids are stable, case- and separator-insensitive", () => {
    const id = projectId("C:\\Work\\app.sublime-project");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(projectId("c:/work/APP.sublime-project")).toBe(id);
    expect(projectId("C:\\Work\\other.sublime-project")).not.toBe(id);
  });
});

describe("tree drag and drop", () => {
  it("drops into folders, never into itself or where it already is", () => {
    expect(dropTarget("C:\\p\\a.txt", "C:\\p\\src", true)).toBe("C:\\p\\src");
    // Dropping on a file means "into that file's folder".
    expect(dropTarget("C:\\p\\a.txt", "C:\\p\\src\\b.rs", false)).toBe("C:\\p\\src");
    expect(dropTarget("C:\\p\\a.txt", "C:\\p", true)).toBeNull(); // already there
    expect(dropTarget("C:\\p\\src", "C:\\p\\src\\deep", true)).toBeNull(); // into itself
    expect(dropTarget("C:\\p\\src", "C:\\p\\src", true)).toBeNull();
    expect(dropTarget("C:\\p\\src", "C:\\p\\src2", true)).toBe("C:\\p\\src2");
  });
});
