export const isMac = /mac/i.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent);

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Paths compare case-insensitively on Windows and macOS default filesystems. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/");
  return /linux/i.test(navigator.userAgent) ? norm(a) === norm(b) : norm(a).toLowerCase() === norm(b).toLowerCase();
}
