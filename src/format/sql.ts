/**
 * SQL formatting in the style of Toad: keywords upper case, clauses right-aligned in a
 * "river" (SELECT / FROM / WHERE line up), one column per line.
 *
 * Plain statements go through `sql-formatter`. It has no support for procedural code, so
 * PL/SQL blocks (DECLARE / BEGIN / CREATE PROCEDURE…) get their own indenter, which hands the
 * SQL statements inside them back to `sql-formatter`.
 *
 * Safety: the result must contain exactly the same tokens as the input (only whitespace and
 * keyword case may change); otherwise nothing is applied.
 */

import { format as sqlFormat, type FormatOptionsWithLanguage } from "sql-formatter";

export type SqlDialect = "plsql" | "sql" | "transactsql" | "postgresql" | "mysql" | "mariadb" | "sqlite" | "db2" | "snowflake" | "bigquery";
export type SqlLayout = "toad" | "standard" | "tabularLeft";
export type SqlCase = "upper" | "lower" | "preserve";

export interface SqlStyle {
  dialect: SqlDialect;
  layout: SqlLayout;
  keywordCase: SqlCase;
  /** Indent unit used inside PL/SQL blocks and the standard layout. */
  indent: string;
}

export const SQL_DIALECTS: { id: SqlDialect; label: string }[] = [
  { id: "plsql", label: "Oracle (PL/SQL)" },
  { id: "transactsql", label: "SQL Server (T-SQL)" },
  { id: "postgresql", label: "PostgreSQL" },
  { id: "mysql", label: "MySQL" },
  { id: "mariadb", label: "MariaDB" },
  { id: "sqlite", label: "SQLite" },
  { id: "db2", label: "IBM Db2" },
  { id: "snowflake", label: "Snowflake" },
  { id: "bigquery", label: "BigQuery" },
  { id: "sql", label: "Standard SQL" },
];

export const SQL_LAYOUTS: { id: SqlLayout; label: string; detail: string }[] = [
  { id: "toad", label: "Toad (river)", detail: "SELECT / FROM / WHERE right-aligned, one column per line" },
  { id: "standard", label: "Standard", detail: "clause keyword on its own line, contents indented" },
  { id: "tabularLeft", label: "Tabular left", detail: "keywords padded to a fixed column" },
];

// ---- Tokenizer (shared by the PL/SQL indenter and the safety check)

export type TokKind = "ws" | "comment" | "string" | "quoted" | "word" | "number" | "bind" | "op";

export interface Tok {
  kind: TokKind;
  text: string;
}

const Q_CLOSE: Record<string, string> = { "[": "]", "{": "}", "(": ")", "<": ">" };
const MULTI_OPS = [":=", "=>", "||", "<=", ">=", "<>", "!=", "^=", "~=", "..", "**", "::"];

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const push = (kind: TokKind, end: number) => {
    out.push({ kind, text: src.slice(i, end) });
    i = end;
  };
  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i, i + 3);
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      push("ws", j);
    } else if (rest.startsWith("--")) {
      const j = src.indexOf("\n", i);
      push("comment", j < 0 ? src.length : j);
    } else if (rest.startsWith("/*")) {
      const j = src.indexOf("*/", i + 2);
      push("comment", j < 0 ? src.length : j + 2);
    } else if (/^[nN]?[qQ]'/.test(rest)) {
      // Oracle alternative quoting: q'[it's]'
      const start = src.indexOf("'", i) + 1;
      const open = src[start];
      const close = (Q_CLOSE[open] ?? open) + "'";
      const j = src.indexOf(close, start + 1);
      push("string", j < 0 ? src.length : j + 2);
    } else if (c === "'" || (/[nNeEbBxX]/.test(c) && src[i + 1] === "'")) {
      let j = src.indexOf("'", i) + 1;
      for (;;) {
        const k = src.indexOf("'", j);
        if (k < 0) {
          j = src.length;
          break;
        }
        if (src[k + 1] === "'") j = k + 2;
        else {
          j = k + 1;
          break;
        }
      }
      push("string", j);
    } else if (c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      const j = src.indexOf(close, i + 1);
      // "[" is only a quoted identifier in T-SQL-style code; otherwise it's an operator.
      if (c === "[" && (j < 0 || /[\s,;()]/.test(src.slice(i + 1, j)))) push("op", i + 1);
      else push("quoted", j < 0 ? src.length : j + 1);
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFdD]?/.exec(src.slice(i))!;
      push("number", i + m[0].length);
    } else if (/[A-Za-z_$#À-￿]/.test(c)) {
      const m = /^[A-Za-z_$#À-￿][A-Za-z0-9_$#À-￿]*/.exec(src.slice(i))!;
      push("word", i + m[0].length);
    } else if ((c === ":" || c === "@") && /[A-Za-z_0-9]/.test(src[i + 1] ?? "")) {
      const m = /^[:@][A-Za-z_0-9$#]+/.exec(src.slice(i))!;
      push("bind", i + m[0].length);
    } else {
      const op = MULTI_OPS.find((o) => src.startsWith(o, i));
      push("op", i + (op?.length ?? 1));
    }
  }
  return out;
}

/** Tokens that carry meaning, normalised for comparison (word case and comment spacing ignored). */
function signature(src: string): string[] {
  return tokenize(src)
    .filter((t) => t.kind !== "ws")
    .map((t) =>
      t.kind === "word" ? t.text.toUpperCase() : t.kind === "comment" ? t.text.replace(/\s+/g, " ").trim() : t.text,
    );
}

/** Index of the first differing token, or -1 if both texts mean the same. */
export function firstDifference(a: string, b: string): number {
  const x = signature(a);
  const y = signature(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return i;
  return -1;
}

// ---- Plain SQL via sql-formatter

function libOptions(style: SqlStyle): FormatOptionsWithLanguage {
  const kc = style.keywordCase;
  return {
    language: style.dialect,
    keywordCase: kc,
    functionCase: kc,
    dataTypeCase: kc,
    identifierCase: "preserve",
    indentStyle: style.layout === "toad" ? "tabularRight" : style.layout === "tabularLeft" ? "tabularLeft" : "standard",
    useTabs: style.indent === "\t",
    tabWidth: style.indent === "\t" ? 4 : style.indent.length,
    linesBetweenQueries: 1,
    paramTypes: { named: [":"], positional: true },
  };
}

/** Shift a statement left so its least-indented line starts at column 0 (Toad style). */
function dedent(block: string): string {
  const lines = block.split("\n");
  const min = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return min > 0 && Number.isFinite(min) ? lines.map((l) => l.slice(Math.min(min, /^ */.exec(l)![0].length))).join("\n") : block;
}

/**
 * Words Oracle lists as (non-reserved) keywords but people mostly use as column names. Toad
 * leaves them as written, so `ORDER BY name` doesn't become `ORDER BY NAME`.
 */
const IDENTIFIER_LIKE = new Set(
  "NAME VALUE TYPE STATUS DATA KEY ROLE CODE TEXT STATE POSITION DESCRIPTION LANGUAGE SOURCE TITLE RESULT OWNER PASSWORD EMAIL MODE ACTION LENGTH ID".split(" "),
);

/** Oracle pseudo-columns and argument-less functions; Toad cases them like keywords. */
const ORACLE_PSEUDO = new Set("SYSDATE SYSTIMESTAMP CURRENT_DATE CURRENT_TIMESTAMP LOCALTIMESTAMP ROWNUM ROWID LEVEL USER UID".split(" "));

/**
 * Second pass over the formatter's words: put back the original spelling of identifier-like
 * words, and case Oracle pseudo-columns like keywords.
 */
function recase(original: string, formatted: string, style: SqlStyle): string {
  const orig = tokenize(original).filter((t) => t.kind !== "ws");
  const out = tokenize(formatted);
  let i = 0;
  let prev: Tok | undefined;
  return out
    .map((t, k) => {
      if (t.kind === "ws") return t.text;
      const src = orig[i++];
      const before = prev;
      prev = t;
      if (t.kind !== "word" || src?.kind !== "word") return t.text;
      const u = t.text.toUpperCase();
      const qualified = before?.text === ".";
      if (style.dialect === "plsql" && ORACLE_PSEUDO.has(u) && !qualified && style.keywordCase !== "preserve") {
        return style.keywordCase === "upper" ? u : t.text.toLowerCase();
      }
      if (!IDENTIFIER_LIKE.has(u)) return t.text;
      const next = out.slice(k + 1).find((x) => x.kind !== "ws");
      // NAME(…) would be a function call: leave the formatter's choice.
      return next?.text === "(" ? t.text : src.text;
    })
    .join("");
}

function formatPlain(sql: string, style: SqlStyle): string {
  const out = recase(sql, sqlFormat(sql, libOptions(style)), style);
  if (style.layout !== "toad") return out;
  // Statements are separated by blank lines; align each one on its own.
  return out
    .split(/\n\s*\n/)
    .map(dedent)
    .join("\n\n");
}

// ---- PL/SQL blocks

const PLSQL_START = /^\s*(DECLARE|BEGIN|CREATE\s+(OR\s+REPLACE\s+)?((NON)?EDITIONABLE\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE\s+BODY))\b/i;

/** Split a script into plain-SQL chunks and PL/SQL units (which end at a "/" line). */
export function splitUnits(src: string): { plsql: boolean; text: string }[] {
  const units: { plsql: boolean; text: string }[] = [];
  const toks = tokenize(src);
  let buf = "";
  let inBlock = false;
  let atStatementStart = true;
  const flush = (plsql: boolean) => {
    if (buf.trim()) units.push({ plsql, text: buf });
    buf = "";
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    // A "/" alone on its line (SQL*Plus / Toad) ends a PL/SQL unit.
    // Only the current line matters (and scanning just it keeps long scripts linear).
    const lineSoFar = buf.slice(buf.lastIndexOf("\n") + 1);
    const aloneOnLine = !lineSoFar.trim() && /^[ \t]*(\n|$)/.test(toks[k + 1]?.text ?? "");
    if (t.kind === "op" && t.text === "/" && aloneOnLine) {
      if (inBlock) {
        flush(true);
        units.push({ plsql: true, text: "/" });
        inBlock = false;
      } else {
        flush(false);
        units.push({ plsql: false, text: "/" });
      }
      atStatementStart = true;
      continue;
    }
    if (!inBlock && atStatementStart && t.kind === "word") {
      const ahead = toks
        .slice(k, k + 12)
        .map((x) => x.text)
        .join("");
      if (PLSQL_START.test(ahead)) {
        flush(false);
        inBlock = true;
      }
    }
    buf += t.text;
    if (t.kind !== "ws" && t.kind !== "comment") atStatementStart = t.kind === "op" && t.text === ";";
  }
  flush(inBlock);
  return units;
}

const KEYWORDS = new Set(
  (
    "ALL AND ANY AS ASC AUTHID AUTONOMOUS_TRANSACTION BEGIN BETWEEN BINARY_INTEGER BLOB BODY BOOLEAN BULK BY CASE CHAR CLOB CLOSE " +
    "COLLECT COMMIT CONSTANT CONTINUE CREATE CURRENT_USER CURSOR DATE DECLARE DEFAULT DEFINER DELETE DESC DETERMINISTIC DISTINCT EACH " +
    "EDITIONABLE ELSE ELSIF END EXCEPTION EXCEPTION_INIT EXECUTE EXISTS EXIT FALSE FETCH FOR FORALL FROM FUNCTION GOTO IF IMMEDIATE IN " +
    "INDEX INSERT INSTEAD INTEGER INTO IS LIKE LIMIT LOOP MERGE NOCOPY NOT NULL NUMBER OF ON OPEN OR OTHERS OUT PACKAGE PIPELINED " +
    "PLS_INTEGER PRAGMA PROCEDURE RAISE RAISE_APPLICATION_ERROR RECORD REF REPLACE RESULT_CACHE RETURN RETURNING REVERSE ROLLBACK ROW " +
    "ROWTYPE SAVEPOINT SELECT SET SQL SQLCODE SQLERRM SYS_REFCURSOR TABLE THEN TRIGGER TRUE TYPE UPDATE USING VALUES VARCHAR2 VARRAY " +
    "WHEN WHERE WHILE WITH AFTER BEFORE OR NONEDITIONABLE"
  ).split(/\s+/),
);

const DML = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "WITH"]);
/** Keywords after which "(" is preceded by a space (everything else is a call: f(x)). */
const SPACE_BEFORE_PAREN = new Set(["IN", "AND", "OR", "NOT", "IS", "AS", "VALUES", "RETURN", "WHEN", "THEN", "ELSE", "EXISTS", "INTO", "USING", "OF", "ON", "FROM"]);

type Frame = { kind: "decl" | "block" | "if" | "loop" | "case" | "exc"; level: number };

function caseWord(w: string, kc: SqlCase): string {
  if (!KEYWORDS.has(w.toUpperCase())) return w;
  return kc === "upper" ? w.toUpperCase() : kc === "lower" ? w.toLowerCase() : w;
}

/** Join tokens on one line with conventional spacing (no space before , ; ) . — none after ( .). */
function joinTokens(toks: Tok[], kc: SqlCase): string {
  let s = "";
  let prev: Tok | null = null;
  /** Token before `prev` (null = start of line), to tell unary from binary minus. */
  let prevPrev: Tok | null | undefined = undefined;
  for (const t of toks) {
    if (t.kind === "ws") continue;
    const text = t.kind === "word" ? caseWord(t.text, kc) : t.text;
    if (prev) {
      const p = prev.text;
      const noSpace =
        [",", ";", ")", ".", "%", "@"].includes(t.text) ||
        p === "(" ||
        p === "." ||
        p === "%" ||
        (t.text === "(" && prev.kind === "word" && !SPACE_BEFORE_PAREN.has(p.toUpperCase())) ||
        (t.text === "(" && (prev.kind === "quoted" || p === ")"));
      // Unary sign: -1 after an operator, "(", "," or a keyword.
      const unary = prevPrev !== undefined && (p === "-" || p === "+") && isOperandStart(prevPrev);
      // A line comment swallows the rest of its line: break after it.
      s += prev.kind === "comment" && p.startsWith("--") ? "\n" : noSpace || unary ? "" : " ";
    }
    s += text;
    prevPrev = prev;
    prev = t;
  }
  return s;
}

/** After this token, a "-" or "+" is a sign, not a subtraction. */
function isOperandStart(t: Tok | null): boolean {
  if (!t) return true;
  if (t.kind === "op") return t.text !== ")";
  return t.kind === "word" && KEYWORDS.has(t.text.toUpperCase());
}

const upper = (t: Tok | undefined) => (t?.kind === "word" ? t.text.toUpperCase() : "");

export function formatPlsql(src: string, style: SqlStyle): string {
  const toks = tokenize(src).filter((t) => t.kind !== "ws");
  const lines: string[] = [];
  const stack: Frame[] = [];
  let level = 0;
  let cur: Tok[] = [];
  /** Inside a CREATE/PROCEDURE/FUNCTION header, waiting for IS/AS. */
  let header = false;
  let paren = 0;
  const pad = (n: number) => style.indent.repeat(Math.max(0, n));
  const emit = (text: string, at = level) => {
    for (const l of text.split("\n")) lines.push(l.trim() ? pad(at) + l : "");
  };
  const flushStatement = () => {
    if (!cur.length) return;
    const first = upper(cur.find((t) => t.kind !== "comment"));
    const split = cur.findIndex((t, i) => i > 0 && DML.has(upper(t)) && ["IS", "AS", "FOR"].includes(upper(cur[i - 1])));
    if (!DML.has(first) && split > 0) {
      emit(joinTokens(cur.slice(0, split), style.keywordCase));
      emit(formatPlain(cur.slice(split).map((t) => t.text).join(" "), style), level + 1);
      cur = [];
      return;
    }
    if (DML.has(first)) {
      const raw = cur.map((t) => t.text).join(" ");
      emit(formatPlain(raw, style));
    } else emit(joinTokens(cur, style.keywordCase));
    cur = [];
  };
  const open = (kind: Frame["kind"]) => {
    stack.push({ kind, level });
    level++;
  };
  const top = () => stack[stack.length - 1];
  const kw = (w: string) => caseWord(w, style.keywordCase);

  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const w = upper(t);
    if (t.kind === "op" && t.text === "(") paren++;
    if (t.kind === "op" && t.text === ")") paren--;
    const startOfStatement = cur.length === 0;

    // Comments on their own between statements stay on their own line.
    if (t.kind === "comment" && startOfStatement) {
      emit(t.text);
      continue;
    }
    if (paren > 0 || (t.kind === "op" && t.text === ")")) {
      cur.push(t);
      continue;
    }

    if (startOfStatement && /^(CREATE|PROCEDURE|FUNCTION|PACKAGE|TRIGGER)$/.test(w) && !(w === "FUNCTION" && top()?.kind === "block")) {
      header = true;
      cur.push(t);
      continue;
    }
    if (header && (w === "IS" || w === "AS")) {
      cur.push(t);
      emit(joinTokens(cur, style.keywordCase));
      cur = [];
      header = false;
      open("decl");
      continue;
    }
    if (header && t.kind === "op" && t.text === ";") {
      // Forward declaration / package spec member: `FUNCTION f RETURN NUMBER;`
      cur.push(t);
      header = false;
      flushStatement();
      continue;
    }
    if (header) {
      cur.push(t);
      continue;
    }

    if (startOfStatement && w === "DECLARE") {
      emit(kw(t.text));
      open("decl");
      continue;
    }
    if (startOfStatement && w === "BEGIN") {
      // BEGIN after a declaration section replaces it at the same level.
      if (top()?.kind === "decl") level = stack.pop()!.level;
      emit(kw(t.text));
      open("block");
      continue;
    }
    if (startOfStatement && w === "EXCEPTION" && top()?.kind === "block") {
      const f = stack.pop()!;
      level = f.level;
      emit(kw(t.text));
      open("exc");
      continue;
    }
    if (startOfStatement && w === "END") {
      // END [IF|LOOP|CASE|name] ;
      let j = k;
      const parts: Tok[] = [];
      while (j < toks.length && !(toks[j].kind === "op" && toks[j].text === ";")) parts.push(toks[j++]);
      if (j < toks.length) parts.push(toks[j]);
      const f = stack.pop();
      level = f ? f.level : 0;
      emit(joinTokens(parts, style.keywordCase));
      k = j;
      continue;
    }
    if (startOfStatement && (w === "IF" || w === "ELSIF" || w === "WHEN" || w === "WHILE" || w === "FOR" || w === "LOOP" || w === "ELSE" || w === "CASE")) {
      if (w === "ELSIF" || w === "ELSE") {
        const f = top();
        if (f && (f.kind === "if" || f.kind === "case")) level = f.kind === "case" ? f.level + 1 : f.level;
      }
      if (w === "WHEN") {
        const f = top();
        if (f && (f.kind === "case" || f.kind === "exc")) level = f.level + 1;
      }
      if (w === "ELSE" || w === "LOOP") {
        emit(kw(t.text));
        if (w === "LOOP") open("loop");
        else level++;
        continue;
      }
      // Collect the condition / iteration up to THEN or LOOP (CASE: up to the first WHEN).
      const stop = w === "FOR" || w === "WHILE" ? "LOOP" : w === "CASE" ? "WHEN" : "THEN";
      let j = k;
      const parts: Tok[] = [];
      let depth = 0;
      while (j < toks.length) {
        const x = toks[j];
        if (x.text === "(") depth++;
        if (x.text === ")") depth--;
        if (depth === 0 && upper(x) === stop && j > k) break;
        parts.push(x);
        j++;
      }
      if (stop !== "WHEN" && j < toks.length) parts.push(toks[j]);
      emit(joinTokens(parts, style.keywordCase));
      k = stop === "WHEN" ? j - 1 : j;
      if (w === "IF") open("if");
      else if (w === "FOR" || w === "WHILE") open("loop");
      else if (w === "CASE") open("case");
      else level++; // ELSIF / WHEN bodies
      continue;
    }

    cur.push(t);
    if (t.kind === "op" && t.text === ";") flushStatement();
  }
  flushStatement();
  return lines.join("\n");
}

/** Format a SQL script (plain statements and PL/SQL units). Throws if the result would change the code. */
export function formatSql(src: string, style: SqlStyle): string {
  const units = style.dialect === "plsql" ? splitUnits(src) : [{ plsql: false, text: src }];
  const parts = units.map((u) => (u.text === "/" ? "/" : u.plsql ? formatPlsql(u.text, style) : formatPlain(u.text, style)));
  // PL/SQL units and their "/" terminator stay together; other units get a blank line between.
  let out = "";
  for (const [i, p] of parts.entries()) {
    if (i > 0) out += p === "/" ? "\n" : units[i - 1].text === "/" || !units[i - 1].plsql ? "\n\n" : "\n";
    out += p.trimEnd();
  }
  // Only drop leading blank lines: the first line's spaces are part of the river alignment.
  out = out.replace(/^\s*\n/, "").trimEnd() + "\n";
  const diff = firstDifference(src, out);
  if (diff >= 0) {
    const near = signature(src).slice(Math.max(0, diff - 2), diff + 3).join(" ");
    throw new Error(`the SQL formatter would change the code near "${near}", so nothing was changed`);
  }
  return out;
}
