/**
 * JSON tools built on a small parser that keeps every literal's source text.
 * Re-serializing through JSON.parse would silently round big numbers
 * (12345678901234567890 → 12345678901234567000) and rewrite string escapes.
 */

export type JsonNode =
  | { kind: "object"; entries: { key: string; name: string; value: JsonNode }[] }
  | { kind: "array"; items: JsonNode[] }
  | { kind: "literal"; raw: string };

export class JsonError extends Error {
  constructor(
    message: string,
    /** UTF-16 offset into the parsed text. */
    readonly offset: number,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${message} (line ${line}, column ${column})`);
  }
}

/** 1-based line/column for an offset. */
export function lineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, column: offset - last };
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

export function parseJson(text: string): JsonNode {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const fail = (msg: string, at = i): never => {
    const { line, column } = lineCol(text, at);
    throw new JsonError(msg, at, line, column);
  };
  const ws = () => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else return;
    }
  };
  const describe = () => (i >= text.length ? "end of input" : `'${text[i]}'`);

  const string = (): string => {
    const start = i++;
    for (;;) {
      if (i >= text.length) fail("Unterminated string", start);
      const c = text.charCodeAt(i);
      if (c === 34) {
        i++;
        return text.slice(start, i);
      }
      if (c < 0x20) fail("Control character in string (use an escape like \\n)");
      if (c === 92) {
        const e = text[i + 1];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail("Invalid \\u escape");
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else fail(`Invalid escape '\\${e ?? ""}'`);
      } else i++;
    }
  };

  const value = (depth: number): JsonNode => {
    if (depth > 2000) fail("Nesting is too deep");
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const entries: { key: string; name: string; value: JsonNode }[] = [];
      ws();
      if (text[i] === "}") {
        i++;
        return { kind: "object", entries };
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail(`Expected a property name in double quotes, found ${describe()}`);
        const key = string();
        ws();
        if (text[i] !== ":") fail(`Expected ':' after property name, found ${describe()}`);
        i++;
        entries.push({ key, name: JSON.parse(key) as string, value: value(depth + 1) });
        ws();
        if (text[i] === ",") {
          i++;
          ws();
          if (text[i] === "}") fail("Trailing comma before '}'");
          continue;
        }
        if (text[i] === "}") {
          i++;
          return { kind: "object", entries };
        }
        fail(`Expected ',' or '}', found ${describe()}`);
      }
    }
    if (c === "[") {
      i++;
      const items: JsonNode[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return { kind: "array", items };
      }
      for (;;) {
        items.push(value(depth + 1));
        ws();
        if (text[i] === ",") {
          i++;
          ws();
          if (text[i] === "]") fail("Trailing comma before ']'");
          continue;
        }
        if (text[i] === "]") {
          i++;
          return { kind: "array", items };
        }
        fail(`Expected ',' or ']', found ${describe()}`);
      }
    }
    if (c === '"') return { kind: "literal", raw: string() };
    for (const word of ["true", "false", "null"]) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return { kind: "literal", raw: word };
      }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (m) {
      i += m[0].length;
      return { kind: "literal", raw: m[0] };
    }
    return fail(`Unexpected ${describe()}`);
  };

  const root = value(0);
  ws();
  if (i < text.length) fail(`Unexpected ${describe()} after the end of the JSON value`);
  return root;
}

function print(node: JsonNode, indent: string | null, sortKeys: boolean, level: number): string {
  if (node.kind === "literal") return node.raw;
  const nl = indent === null ? "" : "\n";
  const pad = (n: number) => (indent === null ? "" : indent.repeat(n));
  const colon = indent === null ? ":" : ": ";
  if (node.kind === "array") {
    if (!node.items.length) return "[]";
    const items = node.items.map((v) => pad(level + 1) + print(v, indent, sortKeys, level + 1));
    return `[${nl}${items.join(`,${nl}`)}${nl}${pad(level)}]`;
  }
  if (!node.entries.length) return "{}";
  const entries = sortKeys
    ? [...node.entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    : node.entries;
  const parts = entries.map((e) => pad(level + 1) + e.key + colon + print(e.value, indent, sortKeys, level + 1));
  return `{${nl}${parts.join(`,${nl}`)}${nl}${pad(level)}}`;
}

export const formatJson = (text: string, indent = "  ", sortKeys = false) => print(parseJson(text), indent, sortKeys, 0);

export const minifyJson = (text: string) => print(parseJson(text), null, false, 0);
