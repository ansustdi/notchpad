/** Pure helpers for the hex editor: byte ↔ text, hex strings, offsets and the data inspector. */

export type HexCharset = "ansi" | "ascii";
export type OffsetBase = "hex" | "dec";

/** Byte → display character for the decoded-text column ("." for unprintable). */
const TABLES: Record<HexCharset, string[]> = (() => {
  // Windows-1252 0x80–0x9F ("." = unassigned); the rest matches Latin-1.
  const W1252 = "€.‚ƒ„…†‡ˆ‰Š‹Œ.Ž..‘’“”•–—˜™š›œ.žŸ";
  const ascii: string[] = [];
  const ansi: string[] = [];
  for (let b = 0; b < 256; b++) {
    const printable = b >= 0x20 && b < 0x7f;
    ascii.push(printable ? String.fromCharCode(b) : ".");
    // C0 controls, DEL, NBSP and the soft hyphen show as dots.
    if (printable) ansi.push(String.fromCharCode(b));
    else if (b >= 0x80 && b < 0xa0) ansi.push(W1252[b - 0x80]);
    else ansi.push(b > 0xa0 && b !== 0xad ? String.fromCharCode(b) : ".");
  }
  return { ascii, ansi };
})();

export const byteChar = (b: number, charset: HexCharset) => TABLES[charset][b];

/** Character → byte in `charset`, or null if it can't be represented. */
const REVERSE: Record<HexCharset, Map<string, number>> = (() => {
  const make = (cs: HexCharset) => {
    const m = new Map<string, number>();
    TABLES[cs].forEach((ch, b) => ch !== "." && m.set(ch, b));
    m.set(".", 0x2e);
    return m;
  };
  return { ascii: make("ascii"), ansi: make("ansi") };
})();

export const charByte = (ch: string, charset: HexCharset): number | null => REVERSE[charset].get(ch) ?? null;

/** Text → bytes in `charset`; characters it can't represent become "?". Newlines are kept. */
export function encodeText(text: string, charset: HexCharset): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    if (ch === "\n" || ch === "\r" || ch === "\t") out.push(ch.charCodeAt(0));
    else out.push(charByte(ch, charset) ?? 0x3f);
  }
  return new Uint8Array(out);
}

export const decodeText = (bytes: Uint8Array, charset: HexCharset) =>
  Array.from(bytes, (b) => (b === 0x0a || b === 0x0d || b === 0x09 ? String.fromCharCode(b) : byteChar(b, charset))).join("");

export const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, "0");

export const toHexString = (bytes: Uint8Array) => Array.from(bytes, hex2).join(" ");

/** "DE AD be ef", "0xDE,0xAD", "deadbeef" → bytes; null if it isn't hex (or has an odd digit count). */
export function parseHexString(s: string): Uint8Array | null {
  const clean = s.replace(/0x/gi, "").replace(/[\s,;:-]+/g, "");
  if (!clean || clean.length % 2 || /[^0-9a-f]/i.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function formatOffset(n: number, base: OffsetBase, digits: number): string {
  return base === "hex" ? n.toString(16).toUpperCase().padStart(digits, "0") : n.toString().padStart(digits, " ");
}

/** Digits needed for the largest offset in a document of `len` bytes (at least 8 like HxD). */
export function offsetDigits(len: number, base: OffsetBase): number {
  return Math.max(base === "hex" ? 8 : 10, (Math.max(len, 1)).toString(base === "hex" ? 16 : 10).length);
}

/**
 * Parse a "go to" offset. "0x1A"/"1Ah" are hex and "#26" decimal; bare numbers use `base`.
 * A leading +/- makes it relative to `from`. Returns null when it isn't a number.
 */
export function parseOffset(text: string, base: OffsetBase, from: number): number | null {
  let s = text.trim().replace(/[_\s,]/g, "");
  let sign = 0;
  if (s.startsWith("+") || s.startsWith("-")) {
    sign = s[0] === "+" ? 1 : -1;
    s = s.slice(1);
  }
  let n: number;
  if (/^0x[0-9a-f]+$/i.test(s)) n = parseInt(s.slice(2), 16);
  else if (/^[0-9a-f]+h$/i.test(s)) n = parseInt(s.slice(0, -1), 16);
  else if (/^#\d+$/.test(s)) n = parseInt(s.slice(1), 10);
  else if (base === "hex" && /^[0-9a-f]+$/i.test(s)) n = parseInt(s, 16);
  else if (/^\d+$/.test(s)) n = parseInt(s, 10);
  else return null;
  return sign ? from + sign * n : n;
}

export interface InspectorRow {
  label: string;
  value: string;
}

/** Values of the bytes at the cursor read as common types (HxD's Data Inspector). */
export function inspect(bytes: Uint8Array, littleEndian: boolean, charset: HexCharset): InspectorRow[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.length;
  const row = (label: string, size: number, get: () => string): InspectorRow => ({ label, value: n >= size ? get() : "" });
  const le = littleEndian;
  return [
    row("Binary (8 bit)", 1, () => bytes[0].toString(2).padStart(8, "0")),
    row("Int8", 1, () => String(view.getInt8(0))),
    row("UInt8", 1, () => String(view.getUint8(0))),
    row("Int16", 2, () => String(view.getInt16(0, le))),
    row("UInt16", 2, () => String(view.getUint16(0, le))),
    row("Int24", 3, () => String(int24(bytes, le, true))),
    row("UInt24", 3, () => String(int24(bytes, le, false))),
    row("Int32", 4, () => String(view.getInt32(0, le))),
    row("UInt32", 4, () => String(view.getUint32(0, le))),
    row("Int64", 8, () => view.getBigInt64(0, le).toString()),
    row("UInt64", 8, () => view.getBigUint64(0, le).toString()),
    row("Float32", 4, () => fmtFloat(view.getFloat32(0, le))),
    row("Float64", 8, () => fmtFloat(view.getFloat64(0, le))),
    row(charset === "ansi" ? "ANSI char" : "ASCII char", 1, () => byteChar(bytes[0], charset)),
    row("UTF-8 char", 1, () => utf8Char(bytes)),
    row("UTF-16 char", 2, () => String.fromCharCode(view.getUint16(0, le))),
    row("Unix time (32)", 4, () => unixTime(view.getUint32(0, le))),
  ];
}

function int24(b: Uint8Array, le: boolean, signed: boolean): number {
  const v = le ? b[0] | (b[1] << 8) | (b[2] << 16) : (b[0] << 16) | (b[1] << 8) | b[2];
  return signed && v & 0x800000 ? v - 0x1000000 : v;
}

const fmtFloat = (x: number) => (Number.isInteger(x) && Math.abs(x) < 1e21 ? x.toFixed(1) : String(x));

function utf8Char(b: Uint8Array): string {
  const len = b[0] < 0x80 ? 1 : b[0] >> 5 === 6 ? 2 : b[0] >> 4 === 14 ? 3 : b[0] >> 3 === 30 ? 4 : 0;
  if (!len || b.length < len) return "invalid";
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, len));
    return `${s} (U+${s.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`;
  } catch {
    return "invalid";
  }
}

function unixTime(sec: number): string {
  const d = new Date(sec * 1000);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().replace("T", " ").replace(/\.000Z$/, " UTC");
}
