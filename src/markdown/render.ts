import { Marked, Token, Tokens } from "marked";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** GitHub-style heading anchor: lower case, punctuation dropped, spaces → dashes. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Plain text of inline tokens (for heading slugs). */
function plain(tokens: Token[] | undefined): string {
  return (tokens ?? []).map((t) => ("tokens" in t && t.tokens ? plain(t.tokens) : "text" in t ? t.text : "")).join("");
}

const countLines = (s: string) => {
  let n = 0;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n++;
  return n;
};

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * Markdown → HTML (unsanitized). Each top-level block is wrapped in
 * `<div class="md-block" data-line="N">` (N = 0-based source line) so the preview can follow
 * the editor's scroll position. Code blocks carry `data-lang` for highlighting afterwards.
 */
export function renderMarkdown(src: string): string {
  const slugs = new Map<string, number>();
  const md = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        let slug = slugify(plain(tokens)) || "section";
        const seen = slugs.get(slug) ?? 0;
        slugs.set(slug, seen + 1);
        if (seen) slug = `${slug}-${seen}`;
        return `<h${depth} id="${escapeHtml(slug)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      code({ text, lang }: Tokens.Code) {
        const name = (lang ?? "").trim().split(/\s+/)[0];
        const attr = name ? ` data-lang="${escapeHtml(name)}"` : "";
        return `<pre><code${attr}>${escapeHtml(text)}</code></pre>\n`;
      },
    },
  });

  let out = "";
  let line = 0;
  let body = src;
  const fm = FRONT_MATTER.exec(src);
  if (fm) {
    const inner = fm[0].replace(/^---\r?\n/, "").replace(/\r?\n---\r?\n?$/, "");
    out += `<div class="md-block" data-line="0"><pre class="md-frontmatter"><code data-lang="yaml">${escapeHtml(inner)}</code></pre></div>\n`;
    line = countLines(fm[0]);
    body = src.slice(fm[0].length);
  }

  const tokens = md.lexer(body);
  for (const tok of tokens) {
    if (tok.type !== "space") {
      const one = Object.assign([tok], { links: tokens.links });
      out += `<div class="md-block" data-line="${line}">${md.parser(one)}</div>\n`;
    }
    line += countLines(tok.raw);
  }
  return out;
}

/** Resolve a link/image target against the Markdown file's folder. Null for URLs and anchors. */
export function resolveLocal(target: string, baseDir: string | null): string | null {
  if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) {
    return null;
  }
  let path = target.split(/[?#]/)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep as written
  }
  if (/^([a-z]:)?[\\/]/i.test(path)) return path;
  if (!baseDir) return null;
  const sep = baseDir.includes("\\") ? "\\" : "/";
  const parts = baseDir.split(/[\\/]/);
  for (const p of path.split(/[\\/]/)) {
    if (p === "" || p === ".") continue;
    if (p === "..") parts.length > 1 && parts.pop();
    else parts.push(p);
  }
  return parts.join(sep);
}
