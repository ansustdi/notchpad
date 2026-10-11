import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { hexRead } from "../ipc";
import { copyText } from "../clipboard";
import { byteChar, charByte, formatOffset, hex2, HexCharset, inspect, offsetDigits, OffsetBase, parseOffset } from "../hex/format";
import {
  computeChecksums,
  deleteBytes,
  hexCopy,
  hexFindNext,
  hexPaste,
  HexSearch,
  hexUndo,
  maxTop,
  moveCursor,
  moveCursorQueued,
  patchHex,
  scrollHexTo,
  selectAll,
  selection,
  setHexRows,
  setSelectionQueued,
  totalRows,
  typeBytes,
  typeNibble,
  useHex,
} from "../store/hexview";
import { reopenAsText, useTabs } from "../store/tabs";
import { useSettings } from "../store/settings";
import { askText, notify } from "../store/ui";
import { isMac } from "../platform";

/** The scrollbar's spacer never exceeds this (browsers cap element heights); rows are scaled onto it. */
const MAX_SCROLL_PX = 8_000_000;

/** Ask for an offset and jump there (Ctrl+G). */
export function hexGoto(tabId: string) {
  const v = useHex.getState().views[tabId];
  if (!v) return;
  const base = useSettings.getState().hexOffsetBase;
  askText(`Go to offset (${base === "hex" ? "hex; #123 = decimal" : "decimal; 0x1F = hex"}, +/- = relative)`, (text) => {
    const n = parseOffset(text, base, useHex.getState().views[tabId]?.cursor ?? 0);
    if (n === null) return notify(`Not an offset: ${text}`, "error");
    moveCursor(tabId, n);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.hex-grid[data-tab="${tabId}"]`)?.focus());
  });
}

/** Focus the find box of the active hex view (Ctrl+F). */
export function focusHexSearch() {
  const input = document.querySelector<HTMLInputElement>(".editor-group .hex-view .hex-find input");
  input?.focus();
  input?.select();
}

export function HexView({ tabId }: { tabId: string }) {
  const v = useHex((s) => s.views[tabId]);
  const path = useTabs((s) => s.tabs.find((t) => t.id === tabId)?.path ?? null);
  const s = useSettings();
  const bpr = s.hexBytesPerRow;
  const charset = s.hexCharset;
  const base = s.hexOffsetBase;
  const gridRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<{ start: number; bytes: Uint8Array }>({ start: 0, bytes: new Uint8Array() });
  const [inspected, setInspected] = useState<Uint8Array>(new Uint8Array());
  const [search, setSearch] = useState<HexSearch>({ text: "", mode: "hex", ignoreCase: true });
  /** Byte where the current mouse drag started. */
  const dragOrigin = useRef<number | null>(null);
  /** scrollTop we set ourselves, so its scroll event doesn't map back to a slightly different row. */
  const echo = useRef<number | null>(null);
  /**
   * Smooth wheel scrolling: `pos` (fractional rows) eases toward `target`. The store keeps whole
   * rows (`top`); the remainder shifts the rows up by part of a row.
   */
  const smooth = useRef({ pos: 0, target: 0, top: -1, raf: 0 });
  const [frac, setFrac] = useState(0);
  const rowH = Math.round(s.fontSize * 1.5);

  // Take the keyboard when shown, unless something else (search panel, dialog) has it.
  useEffect(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el.closest(".editor-group")) gridRef.current?.focus();
  }, [tabId]);

  // Report how many rows fit.
  useLayoutEffect(() => {
    const el = rowsRef.current;
    if (!el) return;
    const report = () => setHexRows(tabId, Math.max(1, Math.floor(el.clientHeight / rowH)));
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabId, rowH]);

  // Read the visible bytes (kept on screen until the new ones arrive).
  const top = v?.top ?? 0;
  const rows = v?.rows ?? 0;
  useEffect(() => {
    if (!v) return;
    let live = true;
    const start = top * bpr;
    hexRead(v.hexId, start, (rows + 1) * bpr)
      .then((bytes) => live && setData({ start, bytes }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [v?.hexId, top, rows, bpr, v?.epoch, v?.len]);

  // `top` changed by something else (keys, Go to, scrollbar): stop easing and line up on the row.
  useEffect(() => {
    const sm = smooth.current;
    if (top === sm.top) return;
    cancelAnimationFrame(sm.raf);
    sm.raf = 0;
    sm.pos = sm.target = sm.top = top;
    setFrac(0);
  }, [top]);
  useEffect(() => () => cancelAnimationFrame(smooth.current.raf), []);

  // Data inspector: the bytes under the caret.
  useEffect(() => {
    if (!v) return;
    let live = true;
    hexRead(v.hexId, v.cursor, 8)
      .then((b) => live && setInspected(b))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [v?.hexId, v?.cursor, v?.epoch]);

  // Keep the scrollbar in step with `top`.
  const total = v ? totalRows(v.len) : 1;
  const fullPx = total * rowH;
  const spacerPx = Math.min(fullPx, MAX_SCROLL_PX);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || !v) return;
    const room = bar.scrollHeight - bar.clientHeight;
    const mt = maxTop(v);
    const want = mt > 0 ? Math.round((top / mt) * room) : 0;
    if (Math.abs(bar.scrollTop - want) > 1) {
      bar.scrollTop = want;
      echo.current = bar.scrollTop;
    }
  }, [top, spacerPx, rows, v?.len]);

  // Wide rows: scroll sideways to keep the caret visible.
  useEffect(() => {
    const box = gridRef.current?.querySelector<HTMLElement>(".hex-hscroll");
    const cur = box?.querySelector<HTMLElement>(".cur");
    if (!box || !cur) return;
    const left = cur.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft;
    const margin = cur.offsetWidth * 4;
    if (left - margin < box.scrollLeft) box.scrollLeft = Math.max(0, left - margin);
    else if (left + cur.offsetWidth + margin > box.scrollLeft + box.clientWidth) box.scrollLeft = left + cur.offsetWidth + margin - box.clientWidth;
  }, [v?.cursor, v?.pane]);

  // Keep the selected bytes per row on a single grid after a settings change.
  useEffect(() => {
    if (v) moveCursor(tabId, v.cursor, v.anchor !== null);
  }, [bpr]);

  const sel = v ? selection(v) : null;
  const digits = offsetDigits(v?.len ?? 0, base);

  const rowsView = useMemo(() => {
    if (!v) return null;
    const out = [];
    // One extra row: it peeks in at the bottom while scrolled part of a row.
    for (let r = 0; r <= v.rows; r++) {
      const rowStart = (v.top + r) * bpr;
      if (rowStart > v.len) break;
      const hexCells = [];
      const textCells = [];
      for (let i = 0; i < bpr; i++) {
        const off = rowStart + i;
        const k = off - data.start;
        const has = off < v.len && k >= 0 && k < data.bytes.length;
        const inSel = sel && off >= sel[0] && off < sel[1];
        const isCur = off === v.cursor;
        const cls = `${inSel ? " sel" : ""}${isCur ? (v.pane === "hex" ? " cur" : " cur2") : ""}${i > 0 && i % 8 === 0 ? " gap" : ""}`;
        const tcls = `${inSel ? " sel" : ""}${isCur ? (v.pane === "text" ? " cur" : " cur2") : ""}`;
        if (off > v.len) {
          hexCells.push(<span key={i} className={`hx${cls}`}>{"  "}</span>);
          textCells.push(<span key={i} className="tx"> </span>);
          continue;
        }
        const h = has ? hex2(data.bytes[k]) : off < v.len ? "··" : "  ";
        hexCells.push(
          <span key={i} className={`hx${cls}`} data-off={off} data-pane="hex">
            {isCur && v.pane === "hex" && v.nibble === 1 ? (
              <>
                {h[0]}
                <span className="nib">{h[1]}</span>
              </>
            ) : (
              h
            )}
          </span>,
        );
        textCells.push(
          <span key={i} className={`tx${tcls}`} data-off={off} data-pane="text">
            {has ? byteChar(data.bytes[k], charset) : " "}
          </span>,
        );
      }
      out.push(
        <div key={rowStart} className="hex-row" style={{ height: rowH }}>
          <span className="hex-off">{formatOffset(rowStart, base, digits)}</span>
          <span className="hex-bytes">{hexCells}</span>
          <span className="hex-text">{textCells}</span>
        </div>,
      );
    }
    return out;
  }, [v, data, bpr, charset, base, digits, rowH, sel?.[0], sel?.[1]]);

  if (!v) return <div className="hex-view" />;

  const cellAt = (e: React.PointerEvent): { off: number; pane: "hex" | "text" } | null => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-off]");
    if (!el) return null;
    return { off: Number(el.dataset.off), pane: el.dataset.pane as "hex" | "text" };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const hit = cellAt(e);
    gridRef.current?.focus();
    if (!hit) return;
    e.preventDefault();
    if (e.shiftKey) {
      // Extend to include the clicked byte, whichever side of the anchor it is on.
      const anchor = v.anchor ?? v.cursor;
      void moveCursorQueued(tabId, hit.off >= anchor ? hit.off + 1 : hit.off, true, hit.pane);
      dragOrigin.current = null;
    } else {
      void moveCursorQueued(tabId, hit.off, false, hit.pane);
      dragOrigin.current = hit.off;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const origin = dragOrigin.current;
    if (origin === null || !(e.buttons & 1)) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-off]");
    if (!el) return;
    const off = Number(el.dataset.off);
    // Still on the starting byte: a click with a jitter, not a selection.
    if (off === origin) return;
    // Whole bytes, both ends included, in either direction.
    if (off > origin) void setSelectionQueued(tabId, origin, off + 1);
    else void setSelectionQueued(tabId, origin + 1, off);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey) return; // app-wide zoom
    // Sideways scrolling (Shift+wheel, trackpads) is the browser's.
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    let lines = e.deltaY / rowH;
    if (e.deltaMode === 1) lines = e.deltaY;
    else if (e.deltaMode === 2) lines = e.deltaY * v.rows;
    const sm = smooth.current;
    sm.target = Math.min(maxTop(v), Math.max(0, sm.target + lines));
    if (!sm.raf) sm.raf = requestAnimationFrame(stepScroll);
  };

  /** One animation frame of smooth scrolling. */
  const stepScroll = () => {
    const sm = smooth.current;
    const d = sm.target - sm.pos;
    sm.pos = Math.abs(d) < 0.02 ? sm.target : sm.pos + d * 0.28;
    const row = Math.floor(sm.pos);
    if (row !== sm.top) {
      sm.top = row;
      scrollHexTo(tabId, row);
    }
    setFrac(sm.pos - row);
    sm.raf = sm.pos === sm.target ? 0 : requestAnimationFrame(stepScroll);
  };

  const onBarScroll = () => {
    const bar = barRef.current;
    if (!bar) return;
    const room = bar.scrollHeight - bar.clientHeight;
    if (room <= 0) return;
    if (echo.current !== null && Math.abs(bar.scrollTop - echo.current) <= 1) {
      echo.current = null;
      return;
    }
    echo.current = null;
    const want = Math.round((bar.scrollTop / room) * maxTop(v));
    if (want !== v.top) scrollHexTo(tabId, want);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const k = e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const extend = e.shiftKey;
    /** Moves are queued behind pending edits and computed from the state they leave. */
    const move = (to: (cur: typeof v) => number) => {
      handled();
      void moveCursorQueued(tabId, to, extend);
    };
    const rowStartOf = (c: number) => c - (c % bpr);
    // Ctrl+Up/Down: scroll the view a row at a time, caret stays (as in VS Code).
    if (mod && !e.shiftKey && (k === "ArrowUp" || k === "ArrowDown")) {
      handled();
      const sm = smooth.current;
      sm.target = Math.min(maxTop(v), Math.max(0, Math.round(sm.target) + (k === "ArrowUp" ? -1 : 1)));
      if (!sm.raf) sm.raf = requestAnimationFrame(stepScroll);
      return;
    }
    switch (k) {
      case "ArrowLeft":
        return move((c) => c.cursor - 1);
      case "ArrowRight":
        return move((c) => c.cursor + 1);
      case "ArrowUp":
        return move((c) => (c.cursor >= bpr ? c.cursor - bpr : c.cursor));
      case "ArrowDown":
        return move((c) => (c.cursor + bpr <= c.len ? c.cursor + bpr : c.cursor));
      case "PageUp":
        scrollHexTo(tabId, v.top - v.rows);
        return move((c) => Math.max(0, c.cursor - c.rows * bpr));
      case "PageDown":
        scrollHexTo(tabId, v.top + v.rows);
        return move((c) => Math.min(c.len, c.cursor + c.rows * bpr));
      case "Home":
        return move((c) => (mod ? 0 : rowStartOf(c.cursor)));
      case "End":
        // Selecting to the end of the row includes its last byte; the caret alone sits on it.
        return move((c) => (mod ? c.len : Math.min(c.len, rowStartOf(c.cursor) + bpr - (extend ? 0 : 1))));
      case "Tab":
        handled();
        return patchHex(tabId, { pane: v.pane === "hex" ? "text" : "hex", nibble: 0 });
      case "Insert":
        handled();
        return patchHex(tabId, { insert: !v.insert });
      case "Backspace":
        handled();
        return void deleteBytes(tabId, false);
      case "Delete":
        handled();
        return void deleteBytes(tabId, true);
      case "F3":
        handled();
        return void hexFindNext(tabId, search, e.shiftKey);
      case "Escape":
        if (v.anchor !== null) {
          handled();
          patchHex(tabId, { anchor: null });
        }
        return;
    }
    if (mod && !e.altKey) {
      const shortcuts: Record<string, () => unknown> = {
        z: () => hexUndo(tabId, e.shiftKey),
        y: () => hexUndo(tabId, true),
        c: () => hexCopy(tabId),
        x: () => hexCopy(tabId, true),
        v: () => hexPaste(tabId),
        a: () => selectAll(tabId),
        f: focusHexSearch,
      };
      const run = shortcuts[k.toLowerCase()];
      if (run) {
        handled();
        void run();
      }
      return;
    }
    if (e.altKey || e.metaKey || k.length !== 1) return;
    if (v.pane === "hex") {
      if (/^[0-9a-f]$/i.test(k)) {
        handled();
        void typeNibble(tabId, parseInt(k, 16));
      }
      return;
    }
    const b = charByte(k, charset);
    handled();
    if (b === null) return notify(`"${k}" can't be written in ${charset === "ansi" ? "Windows-1252" : "ASCII"}`, "error");
    void typeBytes(tabId, new Uint8Array([b]));
  };

  const header = [];
  for (let i = 0; i < bpr; i++) {
    header.push(
      <span key={i} className={`hx${i > 0 && i % 8 === 0 ? " gap" : ""}`}>
        {/* Two digits per column like HxD: past FF (99) the labels wrap around. */}
        {base === "hex" ? hex2(i & 0xff) : String(i % 100).padStart(2, "0")}
      </span>,
    );
  }

  const runFind = (backwards = false) => void hexFindNext(tabId, search, backwards).then((ok) => ok && gridRef.current?.focus());

  return (
    <div className="hex-view" style={{ fontSize: s.fontSize }}>
      <div className="hex-toolbar">
        <BytesPerRow value={bpr} onChange={(n) => s.update({ hexBytesPerRow: n })} />
        <select title="Character set of the text column" value={charset} onChange={(e) => s.update({ hexCharset: e.target.value as HexCharset })}>
          <option value="ansi">Windows (ANSI)</option>
          <option value="ascii">ASCII</option>
        </select>
        <select title="Offsets in" value={base} onChange={(e) => s.update({ hexOffsetBase: e.target.value as OffsetBase })}>
          <option value="hex">hex</option>
          <option value="dec">dec</option>
        </select>
        <span className="hex-sep" />
        <div className="hex-find">
          <input
            value={search.text}
            placeholder={search.mode === "hex" ? "Find hex bytes (4D 5A …)" : "Find text"}
            spellCheck={false}
            onChange={(e) => setSearch({ ...search, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                runFind(e.shiftKey);
              } else if (e.key === "Escape") gridRef.current?.focus();
            }}
          />
          <select title="Search for" value={search.mode} onChange={(e) => setSearch({ ...search, mode: e.target.value as "hex" | "text" })}>
            <option value="hex">Hex</option>
            <option value="text">Text</option>
          </select>
          {search.mode === "text" && (
            <button
              className={search.ignoreCase ? "" : "on"}
              title="Match case"
              onClick={() => setSearch({ ...search, ignoreCase: !search.ignoreCase })}
            >
              Aa
            </button>
          )}
          <button title="Previous (Shift+F3)" onClick={() => runFind(true)}>
            ↑
          </button>
          <button title="Next (F3)" onClick={() => runFind()}>
            ↓
          </button>
        </div>
        <span className="hex-sep" />
        <button title="Go to offset (Ctrl+G)" onClick={() => hexGoto(tabId)}>
          Go to…
        </button>
        <button title="Checksums of the selection, or the whole file (CRC-32, MD5, SHA…)" onClick={() => void computeChecksums(tabId)}>
          Checksums
        </button>
        {path && (
          <button title="Open this file in a text tab" onClick={() => void reopenAsText(tabId)}>
            Open as Text
          </button>
        )}
        <span className="hex-grow" />
        <button
          className="hex-mode"
          title="Insert / Overwrite (Insert key)"
          onClick={() => {
            patchHex(tabId, { insert: !v.insert });
            gridRef.current?.focus();
          }}
        >
          {v.insert ? "Insert" : "Overwrite"}
        </button>
      </div>
      <div className="hex-main">
        <div
          className="hex-grid"
          data-tab={tabId}
          ref={gridRef}
          tabIndex={0}
          role="grid"
          aria-label="Hex editor"
          onKeyDown={onKeyDown}
          onWheel={onWheel}
          style={{ fontFamily: s.fontFamily, lineHeight: `${rowH}px` }}
        >
          {/* Wide rows scroll sideways; the vertical scrollbar stays put on the right. */}
          <div className="hex-hscroll">
            <div className="hex-row hex-head" style={{ height: rowH }}>
              <span className="hex-off">{(base === "hex" ? "Offset(h)" : "Offset(d)").padEnd(digits, " ")}</span>
              <span className="hex-bytes">{header}</span>
              <span className="hex-text">Decoded text</span>
            </div>
            <div className="hex-rows" ref={rowsRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => (dragOrigin.current = null)}>
              <div style={frac ? { transform: `translateY(${-frac * rowH}px)` } : undefined}>{rowsView}</div>
            </div>
          </div>
          <div className="hex-scrollbar" ref={barRef} onScroll={onBarScroll}>
            <div style={{ height: spacerPx }} />
          </div>
        </div>
        <aside className="hex-side">
          <div className="hex-side-head">
            <span>Data inspector</span>
            <label title="Byte order">
              <input type="checkbox" checked={s.hexBigEndian} onChange={(e) => s.update({ hexBigEndian: e.target.checked })} /> Big endian
            </label>
          </div>
          <table className="hex-inspector">
            <tbody>
              {inspect(inspected, !s.hexBigEndian, charset).map((r) => (
                <tr key={r.label}>
                  <th>{r.label}</th>
                  <td title={r.value} onDoubleClick={() => r.value && void copyText(r.value).then(() => notify(`Copied ${r.value}`))}>
                    {r.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {v.checksums && (
            <>
              <div className="hex-side-head">
                <span>
                  Checksums ·{" "}
                  {v.checksums.range[0] === 0 && v.checksums.range[1] === v.len
                    ? "whole file"
                    : `${formatOffset(v.checksums.range[0], base, 1)}–${formatOffset(v.checksums.range[1] - 1, base, 1)}`}
                </span>
                <button title="Close" onClick={() => patchHex(tabId, { checksums: null })}>
                  ×
                </button>
              </div>
              <table className="hex-inspector hex-sums">
                <tbody>
                  {v.checksums.list.map((c) => (
                    <tr key={c.name}>
                      <th>{c.name}</th>
                      <td title="Click to copy" onClick={() => void copyText(c.value).then(() => notify(`${c.name} copied`))}>
                        {c.value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

const BPR_PRESETS = [1, 2, 4, 8, 10, 12, 16, 20, 24, 32, 48, 64];
const MAX_BPR = 4096;

/** Bytes per row: pick a preset or type any number (1-4096), applied on Enter or leaving the box. */
function BytesPerRow({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (raw = text) => {
    const n = Math.round(Number(raw));
    if (Number.isFinite(n) && n >= 1) onChange(Math.min(MAX_BPR, n));
    else setText(String(value));
  };
  return (
    <span className="hex-bpr" title="Bytes per row: pick or type a number (1-4096)">
      <input
        value={text}
        inputMode="numeric"
        aria-label="Bytes per row"
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setText(String(value));
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            commit(String(Math.max(1, value + (e.key === "ArrowUp" ? 1 : -1))));
          }
        }}
      />
      <select
        aria-label="Bytes per row presets"
        value=""
        onChange={(e) => e.target.value && commit(e.target.value)}
      >
        <option value="" disabled hidden />
        {BPR_PRESETS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </span>
  );
}
