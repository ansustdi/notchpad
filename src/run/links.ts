/** File locations in program / compiler output, for clickable error links. */

export interface Location {
  /** Offset and length of the matched text in the line. */
  index: number;
  length: number;
  path: string;
  line: number;
  column: number;
}

const EXTS = "py|pyw|go|rs|js|mjs|cjs|jsx|ts|mts|cts|tsx|java|cs";

const PATTERNS: RegExp[] = [
  // Python: File "C:\x\y.py", line 12
  /File "([^"<>]+)", line (\d+)()/g,
  // C# / MSBuild: C:\x\Program.cs(12,5): error CS1002
  new RegExp(String.raw`((?:[A-Za-z]:)?[^\s"'()<>|]+\.(?:cs))\((\d+),(\d+)\)`, "g"),
  // Go, Rust, Node, tsc, Java stacks: path.ext:12[:5] — optional file:/// prefix
  new RegExp(String.raw`(?:file:\/\/\/?)?((?:[A-Za-z]:)?[^\s"'()<>|:]*?[^\s"'()<>|:\/\\]+\.(?:${EXTS})):(\d+)(?::(\d+))?`, "g"),
];

export function findLocations(text: string): Location[] {
  const found: Location[] = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      // First pattern to claim a span wins (Python lines also contain "file.py").
      if (found.some((f) => start < f.index + f.length && end > f.index)) continue;
      const path = decodeURIComponent(m[1]);
      found.push({ index: start, length: m[0].length, path, line: Number(m[2]), column: Number(m[3] || 0) });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}
