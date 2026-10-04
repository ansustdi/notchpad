import { useState } from "react";
import { SearchPanel } from "./SearchPanel";
import { OutputPanel } from "./OutputPanel";
import { closeSearch, useSearch } from "../store/search";
import { closeOutput, useRun } from "../store/run";
import { PanelTab, showPanelTab, usePanel } from "../store/panel";
import { useSettings } from "../store/settings";

/** Bottom panel with a tab per tool (Search results, Run output); shown while any is open. */
export function BottomPanel() {
  const searchOpen = useSearch((s) => s.open);
  const outputOpen = useRun((s) => s.open);
  const running = useRun((s) => s.running);
  const active = usePanel((s) => s.active);
  const height = useSettings((s) => s.searchPanelHeight);
  const [dragH, setDragH] = useState<number | null>(null);

  const tabs: { id: PanelTab; label: string; open: boolean; close: () => void }[] = [
    { id: "search", label: "Search", open: searchOpen, close: closeSearch },
    { id: "output", label: "Output", open: outputOpen, close: closeOutput },
  ];
  const visible = tabs.filter((t) => t.open);
  if (!visible.length) return null;
  const current = visible.find((t) => t.id === active) ?? visible[0];

  const startResize = (e: React.PointerEvent) => {
    const startY = e.clientY;
    const startH = height;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let h = startH;
    const move = (ev: PointerEvent) => {
      h = Math.min(window.innerHeight - 160, Math.max(120, startH + startY - ev.clientY));
      setDragH(h);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setDragH(null);
      useSettings.getState().update({ searchPanelHeight: Math.round(h) });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  return (
    <section className="bottom-panel" style={{ height: dragH ?? height }} aria-label="Panel">
      <div className="sp-resize" onPointerDown={startResize} />
      <div className="panel-tabs" role="tablist">
        {visible.map((t) => (
          <div key={t.id} className={`panel-tab${t.id === current.id ? " active" : ""}`} role="tab" aria-selected={t.id === current.id}>
            <button className="panel-tab-label" onClick={() => showPanelTab(t.id)}>
              {t.label}
              {t.id === "output" && running && <span className="panel-running" aria-label="running" />}
            </button>
            <button className="panel-tab-close" aria-label={`Close ${t.label}`} title="Close" onClick={t.close}>
              ×
            </button>
          </div>
        ))}
      </div>
      {current.id === "search" ? <SearchPanel /> : <OutputPanel />}
    </section>
  );
}
