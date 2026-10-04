import { copyText } from "../clipboard";
import { useEffect, useRef, useState } from "react";
import {
  activate,
  cloneToGroup,
  closeAll,
  closeOthers,
  closeTab,
  closeToRight,
  moveTab,
  moveToGroup,
  newUntitled,
  otherGroup,
  setActiveGroup,
  Tab,
  togglePin,
  makePermanent,
  useTabs,
} from "../store/tabs";
import { notify, showQuickPick } from "../store/ui";

function tabMenu(tab: Tab, groupId: string) {
  const items = [
    { id: "close", label: "Close" },
    { id: "others", label: "Close Others" },
    { id: "right", label: "Close to the Right" },
    { id: "all", label: "Close All" },
    { id: "pin", label: tab.pinned ? "Unpin" : "Pin" },
    { id: "move", label: "Move to Other Group" },
    ...(tab.big ? [] : [{ id: "clone", label: "Clone to Other Group" }]),
    ...(tab.path ? [{ id: "copyPath", label: "Copy Full Path", detail: tab.path }] : []),
    { id: "copyName", label: "Copy File Name" },
  ];
  showQuickPick({
    placeholder: tab.title,
    items,
    onPick: (item) => {
      switch (item.id) {
        case "close":
          return void closeTab(tab.id, groupId);
        case "others":
          return void closeOthers(tab.id, groupId);
        case "right":
          return void closeToRight(tab.id, groupId);
        case "all":
          return void closeAll(groupId);
        case "pin":
          return togglePin(tab.id);
        case "move":
          return moveToGroup(tab.id, groupId, otherGroup(groupId));
        case "clone":
          return cloneToGroup(tab.id, groupId, otherGroup(groupId));
        default: {
          const text = item.id === "copyPath" ? tab.path! : tab.title;
          void copyText(text).then(() => notify(`Copied: ${text}`));
        }
      }
    },
  });
}

interface Drag {
  id: string;
  startX: number;
  startY: number;
  moved: boolean;
  /** Another group's tab bar under the pointer, and the index to drop at. */
  target: { group: string; index: number } | null;
}

/** Index in a tab bar where a drop at clientX would land. */
function dropIndex(bar: Element, clientX: number): number {
  const els = [...bar.querySelectorAll<HTMLElement>(".tab")];
  const i = els.findIndex((el) => {
    const r = el.getBoundingClientRect();
    return clientX < r.left + r.width / 2;
  });
  return i < 0 ? els.length : i;
}

export function TabBar({ groupId }: { groupId: string }) {
  const group = useTabs((s) => s.groups.find((g) => g.id === groupId));
  const allTabs = useTabs((s) => s.tabs);
  const isActiveGroup = useTabs((s) => s.activeGroup === groupId);
  const barRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dropHint, setDropHint] = useState<{ group: string; index: number } | null>(null);

  const tabs = (group?.tabIds ?? []).map((id) => allTabs.find((t) => t.id === id)).filter((t): t is Tab => !!t);
  const activeId = group?.activeId;

  useEffect(() => {
    barRef.current?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  // Other bars show a drop marker while a tab from this bar is dragged over them.
  useEffect(() => {
    document.querySelectorAll(".tabbar.drop-target").forEach((el) => el.classList.remove("drop-target"));
    if (dropHint) document.querySelector(`.tabbar[data-group="${dropHint.group}"]`)?.classList.add("drop-target");
  }, [dropHint]);

  // Pointer-based dragging: native HTML5 drag is swallowed by the webview's file-drop handler.
  // Listeners go on window, not pointer capture: reordering moves the tab's DOM node, which
  // silently drops capture and would strand the drag.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const handleMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return;
    d.moved = true;
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".tabbar, .editor-group");
    const underGroup = under?.dataset.group;
    if (underGroup && underGroup !== groupId) {
      const bar = document.querySelector(`.tabbar[data-group="${underGroup}"]`);
      d.target = { group: underGroup, index: bar ? dropIndex(bar, e.clientX) : 0 };
      setDropHint(d.target);
      return;
    }
    d.target = null;
    setDropHint(null);
    const els = [...(barRef.current?.querySelectorAll<HTMLElement>(".tab") ?? [])];
    const target = els.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX < r.right;
    });
    if (target >= 0 && tabsRef.current[target]?.id !== d.id) moveTab(d.id, target, groupId);
  };

  const handleUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setDropHint(null);
    if (!d?.target) return;
    // Ctrl/Alt while dropping clones instead of moving (text documents only).
    if ((e.ctrlKey || e.altKey) && !tabsRef.current.find((t) => t.id === d.id)?.big) {
      cloneToGroup(d.id, groupId, d.target.group);
    } else moveToGroup(d.id, groupId, d.target.group, d.target.index);
  };

  const onPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    activate(id, groupId);
    drag.current = { id, startX: e.clientX, startY: e.clientY, moved: false, target: null };
    const move = (ev: PointerEvent) => handleMove(ev);
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      handleUp(ev);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
  };

  return (
    <div
      className={`tabbar${isActiveGroup ? " group-active" : ""}`}
      ref={barRef}
      data-group={groupId}
      role="tablist"
      onPointerDown={() => setActiveGroup(groupId)}
      onDoubleClick={(e) => e.target === barRef.current && newUntitled(groupId)}
      onWheel={(e) => {
        if (barRef.current) barRef.current.scrollLeft += e.deltaY;
      }}
    >
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === activeId}
          className={`tab${t.id === activeId ? " active" : ""}${t.dirty ? " dirty" : ""}${t.pinned ? " pinned" : ""}${t.preview ? " preview" : ""}`}
          onDoubleClick={() => makePermanent(t.id)}
          title={t.path ?? t.title}
          onPointerDown={(e) => onPointerDown(e, t.id)}
          onAuxClick={(e) => e.button === 1 && void closeTab(t.id, groupId)}
          onContextMenu={(e) => {
            e.preventDefault();
            tabMenu(t, groupId);
          }}
        >
          {t.pinned && (
            <span className="tab-pin" aria-label="Pinned">
              📌
            </span>
          )}
          <span className="tab-title">{t.title}</span>
          <button
            className="tab-close"
            aria-label={t.pinned ? `Unpin ${t.title}` : `Close ${t.title}`}
            title={t.pinned ? "Unpin" : "Close"}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => (t.pinned ? togglePin(t.id) : void closeTab(t.id, groupId))}
          >
            <span className="dot">●</span>
            <span className="x">{t.pinned ? "⊘" : "×"}</span>
          </button>
        </div>
      ))}
    </div>
  );
}
