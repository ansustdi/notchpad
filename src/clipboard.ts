import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * System clipboard through the Tauri plugin. The browser Clipboard API needs a focused
 * document and, on WebKit (macOS / Linux), a fresh user gesture, so tools that run from
 * menus or macros would fail there.
 */
export const copyText = (text: string) => writeText(text);

export async function pasteText(): Promise<string> {
  return (await readText()) ?? "";
}
