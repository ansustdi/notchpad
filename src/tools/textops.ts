/** Pure text transforms (no editor / DOM dependencies, so they're unit-testable). */

export function base64Encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64Decode(text: string): string {
  let bin: string;
  try {
    bin = atob(text.replace(/\s+/g, ""));
  } catch {
    throw new Error("Not valid Base64");
  }
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Decoded bytes are not UTF-8 text");
  }
}

export function urlDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    throw new Error("Malformed percent-encoding");
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
