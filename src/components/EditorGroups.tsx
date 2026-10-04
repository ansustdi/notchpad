import { Fragment, useRef } from "react";
import { EditorHost } from "./EditorHost";
import { BigFileView } from "./BigFileView";
import { TabBar } from "./TabBar";
import { Group, setActiveGroup, setGroupSizes, useTabs } from "../store/tabs";

function EditorGroup({ group, single, grow }: { group: Group; single: boolean; grow: number }) {
  const isActive = useTabs((s) => s.activeGroup === group.id);
  const bigTab = useTabs((s) => s.tabs.find((t) => t.id === group.activeId && t.big));
  return (
    <section
      className={`editor-group${isActive && !single ? " active" : ""}`}
      data-group={group.id}
      style={{ flexGrow: grow }}
      onFocusCapture={() => setActiveGroup(group.id)}
      onPointerDownCapture={() => setActiveGroup(group.id)}
      aria-label="Editor group"
    >
      <TabBar groupId={group.id} />
      <div className="editor-area">
        <EditorHost groupId={group.id} hidden={!!bigTab} />
        {bigTab && <BigFileView key={bigTab.id} tabId={bigTab.id} title={bigTab.title} />}
      </div>
    </section>
  );
}

/** Groups laid out in a row (columns) or a column (rows), with draggable splitters between. */
export function EditorGroups() {
  const groups = useTabs((s) => s.groups);
  const orientation = useTabs((s) => s.orientation);
  const boxRef = useRef<HTMLDivElement>(null);
  const horizontal = orientation === "columns";
  // Sizes are relative. Scale them to sum to the group count: flex-grow values summing below 1
  // would leave part of the window empty (e.g. one group left over at size 0.46).
  const total = groups.reduce((n, g) => n + (g.size > 0 ? g.size : 1), 0);
  const growOf = (g: Group) => ((g.size > 0 ? g.size : 1) / total) * groups.length;

  const startResize = (e: React.PointerEvent, i: number) => {
    e.preventDefault();
    const box = boxRef.current!;
    const a = groups[i];
    const b = groups[i + 1];
    const total = groups.reduce((n, g) => n + g.size, 0);
    const extent = horizontal ? box.clientWidth : box.clientHeight;
    const start = horizontal ? e.clientX : e.clientY;
    const pair = a.size + b.size;
    const minSize = (total * 120) / Math.max(extent, 1); // keep each group >= ~120px
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const delta = (((horizontal ? ev.clientX : ev.clientY) - start) / Math.max(extent, 1)) * total;
      const sa = Math.min(pair - minSize, Math.max(minSize, a.size + delta));
      setGroupSizes({ [a.id]: sa, [b.id]: pair - sa });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  return (
    <div className={`editor-groups ${orientation}`} ref={boxRef}>
      {groups.map((g, i) => (
        <Fragment key={g.id}>
          {i > 0 && (
            <div
              className="group-splitter"
              role="separator"
              aria-orientation={horizontal ? "vertical" : "horizontal"}
              onPointerDown={(e) => startResize(e, i - 1)}
              onDoubleClick={() => setGroupSizes(Object.fromEntries(groups.map((x) => [x.id, 1])))}
              title="Drag to resize · double-click to even out"
            />
          )}
          <EditorGroup group={g} single={groups.length === 1} grow={growOf(g)} />
        </Fragment>
      ))}
    </div>
  );
}
