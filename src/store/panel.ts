import { create } from "zustand";

/** Which tab of the bottom panel is in front. Each tab's own store says whether it's open. */
export type PanelTab = "search" | "output" | "terminal";

export const usePanel = create<{ active: PanelTab }>(() => ({ active: "search" }));

export const showPanelTab = (active: PanelTab) => usePanel.setState({ active });
