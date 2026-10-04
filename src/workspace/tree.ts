/** Pure helpers for the folder sidebar and Goto Anything (Ctrl+P). */

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
}

export type Children = Entry[] | "loading" | { error: string };

export interface Row {
  path: string;
  name: string;
  depth: number;
  isDir: boolean;
  root: boolean;
  /** Placeholder rows while a folder loads or when it can't be read. */
  note?: "loading" | "error" | "empty";
}

export const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
export const parentDir = (p: string) => p.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "") || p;
export const joinPath = (dir: string, name: string) => {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
};

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
export const samePathish = (a: string, b: string) => norm(a) === norm(b);
/** True if `p` is `dir` or inside it. */
export const isInside = (p: string, dir: string) => {
  const a = norm(p);
  const b = norm(dir);
  return a === b || a.startsWith(b + "/");
};

/** The rows currently visible in the tree, in display order. */
export function flatten(roots: string[], expanded: Record<string, boolean>, children: Record<string, Children>): Row[] {
  const rows: Row[] = [];
  const walk = (dir: string, depth: number) => {
    const kids = children[dir];
    if (kids === undefined || kids === "loading") {
      rows.push({ path: `${dir}\u0000loading`, name: "Loading…", depth, isDir: false, root: false, note: "loading" });
      return;
    }
    if (!Array.isArray(kids)) {
      rows.push({ path: `${dir}\u0000error`, name: kids.error, depth, isDir: false, root: false, note: "error" });
      return;
    }
    if (!kids.length) {
      rows.push({ path: `${dir}\u0000empty`, name: "(empty)", depth, isDir: false, root: false, note: "empty" });
      return;
    }
    for (const k of kids) {
      rows.push({ path: k.path, name: k.name, depth, isDir: k.isDir, root: false });
      if (k.isDir && expanded[k.path]) walk(k.path, depth + 1);
    }
  };
  for (const r of roots) {
    rows.push({ path: r, name: baseName(r), depth: 0, isDir: true, root: true });
    if (expanded[r]) walk(r, 1);
  }
  return rows;
}

/** Folders that must be expanded (root first) to show `path`, or null if it's in no root. */
export function ancestorsToReveal(path: string, roots: string[]): string[] | null {
  const root = roots.find((r) => isInside(path, r));
  if (!root) return null;
  const chain: string[] = [];
  let dir = parentDir(path);
  while (isInside(dir, root) && !samePathish(dir, path)) {
    chain.unshift(dir);
    if (samePathish(dir, root)) break;
    const up = parentDir(dir);
    if (up === dir) break;
    dir = up;
  }
  return chain;
}

/**
 * Folder that `src` would move into when dropped on row `onto` (a folder, or a file meaning its
 * folder), or null when the drop is pointless (same place) or impossible (into itself).
 */
export function dropTarget(src: string, onto: string, ontoIsDir: boolean): string | null {
  const dir = ontoIsDir ? onto : parentDir(onto);
  if (isInside(dir, src)) return null;
  if (samePathish(parentDir(src), dir)) return null;
  return dir;
}

/** Rejects names that can't be (or shouldn't be) file names. Returns an error message or null. */
export function invalidName(name: string): string | null {
  if (!name.trim()) return "Enter a name";
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) return 'Names can\'t contain < > : " | ? * or control characters';
  if (/(^|[\\/])\.\.?([\\/]|$)/.test(name)) return "Names can't be . or ..";
  if (/[. ]$/.test(name)) return "Names can't end with a dot or space (Windows)";
  return null;
}

// ---- Goto Anything fuzzy matching

const isBoundary = (text: string, i: number) => {
  if (i === 0) return true;
  const prev = text[i - 1];
  const cur = text[i];
  return /[\\/_\-. ]/.test(prev) || (prev === prev.toLowerCase() && cur !== cur.toLowerCase());
};

/** Score `query` (characters in order) against `text`; null if it doesn't match. Higher is better. */
/** Can `rest` still be matched (in order) in `lower` starting at `start`? */
function stillMatches(lower: string, rest: string, start: number): boolean {
  let at = start;
  for (const ch of rest) {
    at = lower.indexOf(ch, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

function scoreIn(query: string, text: string): number | null {
  const lower = text.toLowerCase();
  let score = 0;
  let from = 0;
  let prevMatch = -2;
  for (let q = 0; q < query.length; q++) {
    const ch = query[q];
    let i = lower.indexOf(ch, from);
    if (i < 0) return null;
    // Prefer a later occurrence at a word boundary (e.g. "fm" → [F]ile[M]anager), but only
    // if the rest of the query still fits after it.
    const rest = query.slice(q + 1);
    for (let j = i; j >= 0 && j < lower.length; j = lower.indexOf(ch, j + 1)) {
      if ((j === prevMatch + 1 || isBoundary(text, j)) && stillMatches(lower, rest, j + 1)) {
        i = j;
        break;
      }
    }
    score += 1;
    if (i === prevMatch + 1) score += 3;
    if (isBoundary(text, i)) score += 4;
    score -= Math.min(i - from, 10) * 0.05;
    prevMatch = i;
    from = i + 1;
  }
  return score;
}

/**
 * Sublime-style fuzzy match of a query against a file path. Matches inside the file name count
 * more than matches spread over the folders; shorter paths win ties.
 */
export function fuzzyScore(query: string, path: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const name = baseName(path);
  const inName = scoreIn(q, name);
  const inPath = scoreIn(q, path.replace(/\\/g, "/"));
  if (inName === null && inPath === null) return null;
  const exact = name.toLowerCase() === q || name.toLowerCase().startsWith(q + ".");
  return Math.max((inName ?? -Infinity) * 2 + (exact ? 50 : 0), inPath ?? -Infinity) - path.length * 0.01;
}

/** Best `limit` matches, best first. */
export function fuzzyFilter<T>(query: string, items: T[], key: (t: T) => string, limit = 200): T[] {
  if (!query.trim()) return items.slice(0, limit);
  const scored: { t: T; s: number }[] = [];
  for (const t of items) {
    const s = fuzzyScore(query, key(t));
    if (s !== null) scored.push({ t, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.t);
}
