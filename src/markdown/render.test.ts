import { describe, expect, it } from "vitest";
import { renderMarkdown, resolveLocal, slugify } from "./render";

describe("renderMarkdown", () => {
  it("tags each block with its source line", () => {
    const html = renderMarkdown("# Title\n\nPara one\nstill one\n\n- a\n- b\n");
    const lines = [...html.matchAll(/data-line="(\d+)"/g)].map((m) => Number(m[1]));
    expect(lines).toEqual([0, 2, 5]);
    expect(html).toContain('<h1 id="title">Title</h1>');
    expect(html).toContain("<li>a</li>");
  });

  it("gives duplicate headings unique GitHub-style ids", () => {
    const html = renderMarkdown("## Hello, World!\n\n## Hello, World!\n");
    expect(html).toContain('id="hello-world"');
    expect(html).toContain('id="hello-world-1"');
  });

  it("marks code blocks with their language and escapes them", () => {
    const html = renderMarkdown("```ts title\nconst a = 1 < 2;\n```\n");
    expect(html).toContain('<code data-lang="ts">const a = 1 &lt; 2;</code>');
  });

  it("renders GFM tables and task lists", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n");
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
  });

  it("shows front matter separately and keeps line numbers right", () => {
    const html = renderMarkdown("---\ntitle: x\n---\n# H\n");
    expect(html).toContain("md-frontmatter");
    expect(html).toContain('data-line="3"><h1');
  });

  it("resolves reference links across blocks", () => {
    expect(renderMarkdown("See [docs][d].\n\n[d]: https://example.com\n")).toContain('href="https://example.com"');
  });
});

describe("slugify", () => {
  it("keeps letters, digits, dashes and underscores", () => {
    expect(slugify("Run (F5) — C/C++ files")).toBe("run-f5--cc-files");
    expect(slugify("Монгол хэл")).toBe("монгол-хэл");
  });
});

describe("resolveLocal", () => {
  it("resolves relative paths against the file's folder", () => {
    expect(resolveLocal("img/a.png", "C:\\docs\\proj")).toBe("C:\\docs\\proj\\img\\a.png");
    expect(resolveLocal("../b.md#intro", "/home/u/docs")).toBe("/home/u/b.md");
    expect(resolveLocal("./my%20file.md", "/d")).toBe("/d/my file.md");
  });

  it("leaves URLs and anchors alone but accepts absolute paths", () => {
    expect(resolveLocal("https://x.org/a.png", "/d")).toBeNull();
    expect(resolveLocal("mailto:a@b.c", "/d")).toBeNull();
    expect(resolveLocal("#top", "/d")).toBeNull();
    expect(resolveLocal("C:\\pics\\a.png", null)).toBe("C:\\pics\\a.png");
  });
});
