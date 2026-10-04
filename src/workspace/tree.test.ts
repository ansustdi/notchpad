import { describe, expect, it } from "vitest";
import { ancestorsToReveal, flatten, fuzzyFilter, invalidName, isInside, parentDir } from "./tree";

describe("flatten", () => {
  it("shows expanded folders' children, with placeholders", () => {
    const rows = flatten(
      ["C:\\p"],
      { "C:\\p": true, "C:\\p\\src": true, "C:\\p\\empty": true, "C:\\p\\loading": true },
      {
        "C:\\p": [
          { name: "empty", path: "C:\\p\\empty", isDir: true },
          { name: "loading", path: "C:\\p\\loading", isDir: true },
          { name: "src", path: "C:\\p\\src", isDir: true },
          { name: "a.txt", path: "C:\\p\\a.txt", isDir: false },
        ],
        "C:\\p\\empty": [],
        "C:\\p\\loading": "loading",
        "C:\\p\\src": [{ name: "main.rs", path: "C:\\p\\src\\main.rs", isDir: false }],
      },
    );
    expect(rows.map((r) => `${"  ".repeat(r.depth)}${r.name}${r.isDir ? "/" : ""}`)).toEqual([
      "p/",
      "  empty/",
      "    (empty)",
      "  loading/",
      "    Loading…",
      "  src/",
      "    main.rs",
      "  a.txt",
    ]);
  });

  it("collapsed roots show just the root", () => {
    expect(flatten(["/a", "/b"], {}, {}).map((r) => r.name)).toEqual(["a", "b"]);
  });
});

describe("paths", () => {
  it("finds the folders to expand to reveal a file", () => {
    expect(ancestorsToReveal("C:\\p\\src\\deep\\x.rs", ["D:\\other", "C:\\p"])).toEqual(["C:\\p", "C:\\p\\src", "C:\\p\\src\\deep"]);
    expect(ancestorsToReveal("/p/a.txt", ["/p"])).toEqual(["/p"]);
    expect(ancestorsToReveal("/elsewhere/a.txt", ["/p"])).toBeNull();
  });

  it("containment is case-insensitive and separator-agnostic, but not prefix-fooled", () => {
    expect(isInside("C:/Proj/src/a.ts", "c:\\proj")).toBe(true);
    expect(isInside("C:\\project2\\a.ts", "C:\\proj")).toBe(false);
    expect(parentDir("C:\\p\\src\\")).toBe("C:\\p");
  });

  it("validates new names", () => {
    expect(invalidName("main.rs")).toBeNull();
    expect(invalidName("sub/dir/file.txt")).toBeNull();
    expect(invalidName("")).toMatch(/Enter/);
    expect(invalidName("a:b")).toMatch(/can't contain/);
    expect(invalidName("../x")).toMatch(/\. or \.\./);
    expect(invalidName("name.")).toMatch(/end with/);
  });
});

describe("fuzzyFilter", () => {
  const files = [
    "C:/p/src/components/EditorHost.tsx",
    "C:/p/src/components/SearchPanel.tsx",
    "C:/p/src/store/settings.ts",
    "C:/p/src-tauri/src/search.rs",
    "C:/p/README.md",
    "C:/p/docs/old/search-notes-archive.md",
  ];
  const top = (q: string, n = 1) => fuzzyFilter(q, files, (f) => f).slice(0, n);

  it("ranks file-name matches and word boundaries first", () => {
    expect(top("search.rs")).toEqual(["C:/p/src-tauri/src/search.rs"]);
    expect(top("sp")).toEqual(["C:/p/src/components/SearchPanel.tsx"]);
    expect(top("edhost")).toEqual(["C:/p/src/components/EditorHost.tsx"]);
    expect(top("readme")).toEqual(["C:/p/README.md"]);
  });

  it("matches across folders and ignores spaces", () => {
    expect(top("store set")).toEqual(["C:/p/src/store/settings.ts"]);
    expect(fuzzyFilter("zzz", files, (f) => f)).toEqual([]);
    expect(fuzzyFilter("", files, (f) => f, 2)).toHaveLength(2);
  });
});
