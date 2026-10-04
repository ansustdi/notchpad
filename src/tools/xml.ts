/**
 * XML format / minify / well-formedness check on a token stream, so tags, attributes,
 * comments and CDATA are emitted exactly as written; only whitespace between them changes.
 */

import { lineCol } from "./json";

type TokenKind = "open" | "close" | "selfclose" | "text" | "comment" | "cdata" | "pi" | "doctype";

export interface XmlToken {
  kind: TokenKind;
  raw: string;
  /** Element name for open / close / selfclose. */
  name?: string;
  offset: number;
}

export class XmlError extends Error {
  constructor(
    message: string,
    readonly offset: number,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${message} (line ${line}, column ${column})`);
  }
}

const fail = (text: string, msg: string, at: number): never => {
  const { line, column } = lineCol(text, at);
  throw new XmlError(msg, at, line, column);
};

export function tokenizeXml(text: string): XmlToken[] {
  const out: XmlToken[] = [];
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const until = (end: string, from: number, what: string) => {
    const j = text.indexOf(end, from);
    if (j < 0) fail(text, `Unterminated ${what}`, from);
    return j + end.length;
  };
  while (i < text.length) {
    const start = i;
    if (text[i] !== "<") {
      const j = text.indexOf("<", i);
      i = j < 0 ? text.length : j;
      out.push({ kind: "text", raw: text.slice(start, i), offset: start });
      continue;
    }
    if (text.startsWith("<!--", i)) {
      i = until("-->", i + 4, "comment");
      out.push({ kind: "comment", raw: text.slice(start, i), offset: start });
    } else if (text.startsWith("<![CDATA[", i)) {
      i = until("]]>", i + 9, "CDATA section");
      out.push({ kind: "cdata", raw: text.slice(start, i), offset: start });
    } else if (text.startsWith("<?", i)) {
      i = until("?>", i + 2, "processing instruction");
      out.push({ kind: "pi", raw: text.slice(start, i), offset: start });
    } else if (text.startsWith("<!", i)) {
      // DOCTYPE may carry an internal subset in [...] containing '>'.
      let depth = 0;
      for (i += 2; i < text.length; i++) {
        if (text[i] === "[") depth++;
        else if (text[i] === "]") depth--;
        else if (text[i] === ">" && depth <= 0) break;
      }
      if (i >= text.length) fail(text, "Unterminated declaration", start);
      i++;
      out.push({ kind: "doctype", raw: text.slice(start, i), offset: start });
    } else {
      // A tag: scan to '>' outside quoted attribute values.
      let quote = "";
      for (i++; i < text.length; i++) {
        const c = text[i];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "<") fail(text, "Unexpected '<' inside a tag", i);
        else if (c === ">") break;
      }
      if (i >= text.length) fail(text, "Unterminated tag", start);
      i++;
      const raw = text.slice(start, i);
      const close = raw.startsWith("</");
      const m = /^<\/?\s*([^\s/>]+)/.exec(raw);
      if (!m) fail(text, "Missing element name", start + 1);
      const kind: TokenKind = close ? "close" : raw.endsWith("/>") ? "selfclose" : "open";
      out.push({ kind, raw, name: m![1], offset: start });
    }
  }
  return out;
}

/** Throws XmlError on unbalanced or mismatched tags, or content outside a single root. */
export function checkXml(text: string): XmlToken[] {
  const tokens = tokenizeXml(text);
  const stack: XmlToken[] = [];
  let roots = 0;
  for (const t of tokens) {
    if (t.kind === "open" || t.kind === "selfclose") {
      if (!stack.length && ++roots > 1) fail(text, `Second root element <${t.name}>`, t.offset);
      if (t.kind === "open") stack.push(t);
    } else if (t.kind === "close") {
      const top = stack.pop();
      if (!top) fail(text, `Closing tag </${t.name}> has no matching opening tag`, t.offset);
      if (top!.name !== t.name) fail(text, `Expected </${top!.name}> but found </${t.name}>`, t.offset);
    } else if (t.kind === "text" && !stack.length && t.raw.trim()) {
      fail(text, "Text outside the root element", t.offset + (t.raw.length - t.raw.trimStart().length));
    }
  }
  if (stack.length) {
    const open = stack[stack.length - 1];
    fail(text, `<${open.name}> is never closed`, open.offset);
  }
  if (!roots) fail(text, "No root element", 0);
  return tokens;
}

export function formatXml(text: string, indent = "  "): string {
  const tokens = checkXml(text);
  const lines: string[] = [];
  let level = 0;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const pad = indent.repeat(level);
    if (t.kind === "open") {
      // <a>short text</a> and <a></a> stay on one line.
      const next = tokens[k + 1];
      const after = tokens[k + 2];
      if (next?.kind === "close") {
        lines.push(pad + t.raw + next.raw);
        k += 1;
        continue;
      }
      if (next?.kind === "text" && after?.kind === "close" && !next.raw.includes("\n")) {
        lines.push(pad + t.raw + next.raw.trim() + after.raw);
        k += 2;
        continue;
      }
      lines.push(pad + t.raw);
      level++;
    } else if (t.kind === "close") {
      level = Math.max(0, level - 1);
      lines.push(indent.repeat(level) + t.raw);
    } else if (t.kind === "text") {
      for (const part of t.raw.split("\n")) {
        const trimmed = part.trim();
        if (trimmed) lines.push(pad + trimmed);
      }
    } else {
      lines.push(pad + t.raw);
    }
  }
  return lines.join("\n");
}

export function minifyXml(text: string): string {
  return checkXml(text)
    .filter((t) => t.kind !== "text" || t.raw.trim())
    .map((t) => (t.kind === "text" ? t.raw.trim() : t.raw))
    .join("");
}
