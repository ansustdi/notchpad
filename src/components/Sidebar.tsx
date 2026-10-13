import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  addFolderDialog,
  copyPathOf,
  deletePath,
  loadChildren,
  moveOrCopy,
  newFileIn,
  newFolderIn,
  openFolderDialog,
  refresh,
  removeRoot,
  renamePath,
  revealInExplorer,
  select,
  setSidebarWidth,
  toggleExpand,
  useWorkspace,
} from "../store/workspace";
import { activate, findTabByPath, makePermanent, openPaths, setActiveGroup, useTabs } from "../store/tabs";
import { useSettings } from "../store/settings";
import { openSearch, useSearch } from "../store/search";
import { showQuickPick } from "../store/ui";
import { baseName, dropTarget, flatten, parentDir, Row, samePathish } from "../workspace/tree";

const ROW_H = 22;
const INDENT = 14;

/** Single click: preview tab (if enabled). Double click / Enter: a normal tab. */
async function openFile(path: string, preview: boolean) {
  // A double click arrives while the first click's preview is still loading: wait for it.
  await opening.get(path);
  const tab = findTabByPath(path);
  if (tab) {
    activate(tab.id);
    if (!preview) makePermanent(tab.id);
    return;
  }
  const job = openPaths([path], { preview: preview && useSettings.getState().previewTabs }).finally(() => opening.delete(path));
  opening.set(path, job);
  await job;
}
const opening = new Map<string, Promise<void>>();

interface Drag {
  row: Row;
  startX: number;
  startY: number;
  active: boolean;
  x: number;
  y: number;
  copy: boolean;
  /** Folder it would drop into, or an editor group id (files only: open there). */
  target: { dir: string } | { group: string } | null;
  hoverDir: string | null;
  hoverSince: number;
}

function contextMenu(row: Row) {
  const dir = row.isDir ? row.path : parentDir(row.path);
  const items = [
    ...(row.isDir ? [] : [{ id: "open", label: "Open" }]),
    { id: "newFile", label: "New File…", detail: row.isDir ? "" : "next to this file" },
    { id: "newFolder", label: "New Folder…" },
    ...(row.root ? [] : [{ id: "rename", label: "Rename…", detail: "F2" }, { id: "delete", label: "Delete", detail: "to Recycle Bin" }]),
    ...(row.isDir ? [{ id: "find", label: "Find in Folder…" }] : []),
    { id: "copy", label: "Copy Path" },
    { id: "reveal", label: "Open in File Manager" },
    ...(row.isDir ? [{ id: "refresh", label: "Refresh" }] : []),
    ...(row.root ? [{ id: "remove", label: "Remove Folder from Sidebar" }] : []),
  ];
  showQuickPick({
    placeholder: row.name,
    items,
    onPick: (it) => {
      switch (it.id) {
        case "open":
          return void openFile(row.path, false);
        case "newFile":
          return setTimeout(() => newFileIn(dir));
        case "newFolder":
          return setTimeout(() => newFolderIn(dir));
        case "rename":
          return setTimeout(() => renamePath(row.path));
        case "delete":
          return void deletePath(row.path, row.isDir);
        case "find":
          useSearch.setState({ folder: row.path });
          return openSearch({ scope: "folder" });
        case "copy":
          return void copyPathOf(row.path);
        case "reveal":
          return void revealInExplorer(row.path);
        case "refresh":
          return void refresh(row.path);
        case "remove":
          return removeRoot(row.path);
      }
    },
  });
}

export function Sidebar() {
  const { roots, expanded, children, width, selected, revealTick } = useWorkspace();
  const activePath = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.path ?? null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [dragW, setDragW] = useState<number | null>(null);

  const rows = useMemo(() => flatten(roots, expanded, children), [roots, expanded, children]);
  const selIndex = rows.findIndex((r) => selected && samePathish(r.path, selected));

  // The tree element only exists while folders are open: re-attach when it (re)appears,
  // otherwise the height stays at the default and rows past it never render.
  const hasTree = roots.length > 0;
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    setHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasTree]);

  // Expanded folders restored from the session load when they come into view.
  useEffect(() => {
    for (const r of rows) if (r.note === "loading") void loadChildren(r.path.split("\u0000")[0]);
  }, [rows]);

  const scrollTo = (index: number, center = false) => {
    const el = boxRef.current;
    if (!el || index < 0) return;
    const top = index * ROW_H;
    if (center) el.scrollTop = top - el.clientHeight / 2;
    else if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };

  useEffect(() => {
    if (revealTick) scrollTo(selIndex, true);
    // Only when a reveal was requested.
  }, [revealTick]);

  const activateRow = (r: Row, focusEditor = false) => {
    if (r.note) return;
    select(r.path);
    if (r.isDir) toggleExpand(r.path);
    else {
      // Enter (focusEditor) opens a normal tab; a click opens a preview.
      void openFile(r.path, !focusEditor);
      if (!focusEditor) setTimeout(() => boxRef.current?.focus());
    }
  };

  // ---- Drag and drop (pointer-based: the webview's file-drop handling swallows HTML5 drag)
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const suppressClick = useRef(false);

  const startDrag = (e: React.PointerEvent, r: Row) => {
    if (e.button !== 0 || r.note || r.root) return;
    dragRef.current = { row: r, startX: e.clientX, startY: e.clientY, active: false, x: 0, y: 0, copy: false, target: null, hoverDir: null, hoverSince: 0 };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.active && Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < 6) return;
      d.active = true;
      d.x = ev.clientX;
      d.y = ev.clientY;
      d.copy = ev.ctrlKey || ev.altKey;
      const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const rowEl = under?.closest<HTMLElement>(".sb-row");
      const groupEl = under?.closest<HTMLElement>(".editor-group");
      d.target = null;
      if (rowEl?.dataset.path && !rowEl.dataset.note) {
        const isDir = rowEl.dataset.dir === "1";
        const dir = dropTarget(d.row.path, rowEl.dataset.path, isDir);
        if (dir) d.target = { dir };
        // Hovering a closed folder for a moment opens it.
        if (isDir && rowEl.dataset.path !== d.hoverDir) {
          d.hoverDir = rowEl.dataset.path;
          d.hoverSince = performance.now();
        } else if (isDir && performance.now() - d.hoverSince > 650 && !useWorkspace.getState().expanded[rowEl.dataset.path]) {
          toggleExpand(rowEl.dataset.path, true);
        }
      } else if (groupEl?.dataset.group && !d.row.isDir) {
        d.target = { group: groupEl.dataset.group };
      }
      // Scroll the tree when dragging near its edges.
      const box = boxRef.current?.getBoundingClientRect();
      if (box && boxRef.current && ev.clientX >= box.left && ev.clientX <= box.right) {
        if (ev.clientY < box.top + 28) boxRef.current.scrollTop -= 14;
        else if (ev.clientY > box.bottom - 28) boxRef.current.scrollTop += 14;
      }
      setDrag({ ...d });
    };
    const up = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d?.active) return;
      // The click that ends a drag must not also open/toggle the row.
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      if (d.target && "dir" in d.target) void moveOrCopy(d.row.path, d.target.dir, d.copy);
      else if (d.target && "group" in d.target) {
        setActiveGroup(d.target.group);
        void openFile(d.row.path, false);
      }
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
  };

  const dropDir = drag?.target && "dir" in drag.target ? drag.target.dir : null;

  const onKey = (e: React.KeyboardEvent) => {
    const r = rows[selIndex];
    const move = (i: number) => {
      const target = rows[Math.min(rows.length - 1, Math.max(0, i))];
      if (target) {
        select(target.path);
        scrollTo(rows.indexOf(target));
      }
    };
    switch (e.key) {
      case "ArrowDown":
        move(selIndex + 1);
        break;
      case "ArrowUp":
        move(selIndex - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(rows.length - 1);
        break;
      case "ArrowRight":
        if (r?.isDir && !expanded[r.path]) toggleExpand(r.path, true);
        else move(selIndex + 1);
        break;
      case "ArrowLeft":
        if (r?.isDir && expanded[r.path]) toggleExpand(r.path, false);
        else if (r) {
          const parent = rows.slice(0, selIndex).reverse().find((x) => x.isDir && x.depth < r.depth);
          if (parent) move(rows.indexOf(parent));
        }
        break;
      case "Enter":
        if (r) activateRow(r, true);
        break;
      case "F2":
        if (r && !r.root && !r.note) renamePath(r.path);
        break;
      case "Delete":
        if (r && !r.root && !r.note) void deletePath(r.path, r.isDir);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let w = startW;
    const move = (ev: PointerEvent) => {
      w = Math.min(800, Math.max(140, startW + ev.clientX - startX));
      setDragW(w);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setDragW(null);
      setSidebarWidth(w);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + 5);

  return (
    <aside className="sidebar" style={{ width: dragW ?? width }} aria-label="Folders">
      <div className="sb-header">
        <span>FOLDERS</span>
        <span className="sb-actions">
          <button title="Add folder…" aria-label="Add folder" onClick={() => void addFolderDialog()}>
            ＋
          </button>
          <button title="Refresh" aria-label="Refresh" onClick={() => void refresh()}>
            ⟳
          </button>
          <button
            title="Collapse all"
            aria-label="Collapse all"
            onClick={() => useWorkspace.setState({ expanded: Object.fromEntries(roots.map((r) => [r, true])) })}
          >
            ⊟
          </button>
        </span>
      </div>
      {roots.length === 0 ? (
        <div className="sb-empty">
          <p>No folder open.</p>
          <button className="sp-btn primary" onClick={() => void openFolderDialog()}>
            Open Folder…
          </button>
          <p className="sb-hint">or drag a folder onto the window</p>
        </div>
      ) : (
        <div
          className="sb-tree"
          ref={boxRef}
          tabIndex={0}
          role="tree"
          aria-label="Folder tree"
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          onKeyDown={onKey}
          onFocus={() => {
            // Read the store, not this render's value: focus can arrive before a re-render.
            if (!useWorkspace.getState().selected && rows[0]) select(rows[0].path);
          }}
        >
          <div style={{ height: rows.length * ROW_H, position: "relative" }}>
            {rows.slice(first, last).map((r, i) => {
              const index = first + i;
              const isActive = !r.isDir && activePath !== null && samePathish(r.path, activePath);
              return (
                <div
                  key={r.path}
                  role="treeitem"
                  aria-expanded={r.isDir ? !!expanded[r.path] : undefined}
                  aria-selected={index === selIndex}
                  className={`sb-row${index === selIndex ? " sel" : ""}${isActive ? " active-file" : ""}${r.root ? " root" : ""}${r.note ? ` note ${r.note}` : ""}${dropDir && r.isDir && samePathish(r.path, dropDir) ? " drop-into" : ""}${drag?.active && samePathish(drag.row.path, r.path) ? " dragging" : ""}`}
                  style={{ top: index * ROW_H, paddingLeft: 6 + r.depth * INDENT }}
                  title={r.note ? undefined : r.path}
                  data-path={r.note ? undefined : r.path}
                  data-dir={r.isDir ? "1" : "0"}
                  data-note={r.note}
                  onPointerDown={(e) => startDrag(e, r)}
                  onClick={() => !suppressClick.current && activateRow(r)}
                  onDoubleClick={() => !r.isDir && !r.note && void openFile(r.path, false)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (r.note) return;
                    select(r.path);
                    contextMenu(r);
                  }}
                >
                  <span className={`sb-twisty${r.isDir ? (expanded[r.path] ? " open" : "") : " none"}`} aria-hidden>
                    {r.isDir ? "▸" : ""}
                  </span>
                  <span className={`sb-icon ${r.isDir ? "dir" : "file"}`} aria-hidden />
                  <span className="sb-name">{r.name}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="sb-resize" onPointerDown={startResize} title="Drag to resize" />
      {drag?.active && (
        <div className="drag-ghost" style={{ left: drag.x + 14, top: drag.y + 10 }}>
          {drag.target
            ? "dir" in drag.target
              ? <>
                  <span className="copy">{drag.copy ? "Copy" : "Move"}</span> {drag.row.name} → {baseName(drag.target.dir)}
                </>
              : <>Open {drag.row.name}</>
            : drag.row.name}
        </div>
      )}
    </aside>
  );
}
