/**
 * Projects are Sublime Text `.sublime-project` files:
 *   { "folders": [ { "path": "." }, { "path": "C:/other/lib", "name": "lib" } ], "settings": {} }
 * Folder paths may be relative to the project file. Our per-project session (open tabs, layout)
 * lives in app data, like Sublime's `.sublime-workspace`.
 */

import { baseName, parentDir } from "./tree";

export const PROJECT_EXT = "sublime-project";

export interface ProjectFolder {
  path: string;
  name?: string;
}

const isAbsolute = (p: string) => /^([A-Za-z]:[\\/]|[\\/]{1,2})/.test(p);

/** Resolve "./x", "../x" and "x" against `dir`, keeping the platform's separator. */
export function resolvePath(dir: string, rel: string): string {
  if (isAbsolute(rel)) return rel;
  const sep = dir.includes("\\") ? "\\" : "/";
  const parts = dir.split(/[\\/]/);
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 1) parts.pop();
    } else parts.push(seg);
  }
  return parts.join(sep);
}

/** `path` relative to `dir` (forward slashes, like Sublime writes), or null if it's not below it. */
export function relativeTo(dir: string, path: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const d = norm(dir);
  const p = norm(path);
  if (p.toLowerCase() === d.toLowerCase()) return ".";
  if (p.toLowerCase().startsWith(d.toLowerCase() + "/")) return p.slice(d.length + 1);
  return null;
}

/** Sublime project files are JSON with comments and trailing commas allowed. */
function parseLooseJson(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export interface ParsedProject {
  name: string;
  folders: ProjectFolder[];
}

export function parseProject(text: string, projectFile: string): ParsedProject {
  const data = parseLooseJson(text) as { folders?: { path?: unknown; name?: unknown }[] };
  const dir = parentDir(projectFile);
  const folders = (Array.isArray(data?.folders) ? data.folders : [])
    .filter((f) => typeof f?.path === "string")
    .map((f) => ({ path: resolvePath(dir, f.path as string), name: typeof f.name === "string" ? f.name : undefined }));
  return { name: projectName(projectFile), folders };
}

export const projectName = (projectFile: string) => baseName(projectFile).replace(new RegExp(`\\.${PROJECT_EXT}$`, "i"), "");

/** JSON for a project file; folders below the project file are stored relative (portable). */
export function serializeProject(folders: string[], projectFile: string, existing?: string): string {
  let base: Record<string, unknown> = {};
  try {
    if (existing) base = parseLooseJson(existing) as Record<string, unknown>;
  } catch {
    base = {};
  }
  const dir = parentDir(projectFile);
  const out = {
    ...base,
    folders: folders.map((f) => ({ path: relativeTo(dir, f) ?? f.replace(/\\/g, "/") })),
  };
  return JSON.stringify(out, null, "\t") + "\n";
}

/** Stable short id for a project path (FNV-1a 64-bit), used to name its session file. */
export function projectId(projectFile: string): string {
  let h = 0xcbf29ce484222325n;
  for (const ch of projectFile.replace(/\\/g, "/").toLowerCase()) {
    h ^= BigInt(ch.codePointAt(0)!);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}
