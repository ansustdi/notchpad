import { create } from "zustand";
import { activeTab, getTab } from "./tabs";
import { notify } from "./ui";

/** "side" = editor and preview next to each other, "preview" = preview only. */
export type MdMode = "side" | "preview";

/** Preview mode per tab id; tabs not listed show just the editor. */
export const useMdPreview = create<{ modes: Record<string, MdMode> }>(() => ({ modes: {} }));

export const isMarkdownTab = (id: string | null | undefined) => !!id && getTab(id)?.language === "markdown";

export function setMdMode(tabId: string, mode: MdMode | null) {
  useMdPreview.setState((s) => {
    const modes = { ...s.modes };
    if (mode) modes[tabId] = mode;
    else delete modes[tabId];
    return { modes };
  });
}

/** Switch the active Markdown tab to `mode`, or back to the editor if it's already there. */
export function toggleMdMode(mode: MdMode) {
  const tab = activeTab();
  if (!tab || tab.language !== "markdown") {
    notify("Markdown preview works on Markdown files (.md)");
    return;
  }
  setMdMode(tab.id, useMdPreview.getState().modes[tab.id] === mode ? null : mode);
}
