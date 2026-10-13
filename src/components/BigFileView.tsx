import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { bigfileFind, bigfileLines } from "../ipc";
import { bigReveal, BigView, maxTop, patchBig, scrollBigTo, toggleBigFollow, useBig } from "../store/bigview";
import { useSettings } from "../store/settings";
import { errorMessage, notify } from "../store/ui";

const CHUNK = 256;

interface Chunk {
  lines: string[];
  truncated: Set<number>;
}

function formatBytes(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function LineText({ text, match }: { text: string; match?: { start: number; end: number } }) {
  if (!match) return <>{text || " "}</>;
  return (
    <>
      {text.slice(0, match.start)}
      <mark className="bf-match">{text.slice(match.start, match.end) || " "}</mark>
      {text.slice(match.end)}
    </>
  );
}

/** Lines are fetched in fixed chunks and cached; only visible chunks (plus one ahead) load. */
function useLineCache(view: BigView) {
  const cache = useRef(new Map<number, Chunk>());
  const pending = useRef(new Set<number>());
  const [, setTick] = useState(0);
  const lastLines = useRef(view.status.lines);
  const epochRef = useRef(view.epoch);
  epochRef.current = view.epoch;

  useEffect(() => {
    cache.current.clear();
    pending.current.clear();
    setTick((t) => t + 1);
  }, [view.epoch, view.bigId]);

  // The file grew: drop the (possibly short) chunks at the old end so they reload.
  useEffect(() => {
    const old = lastLines.current;
    lastLines.current = view.status.lines;
    if (view.status.lines <= old) return;
    for (const [k, c] of cache.current) {
      if (k * CHUNK + c.lines.length >= old - 1) cache.current.delete(k);
    }
    setTick((t) => t + 1);
  }, [view.status.lines]);

  const ensure = useCallback(
    (from: number, to: number) => {
      const epoch = view.epoch;
      for (let k = Math.floor(from / CHUNK); k <= Math.floor(to / CHUNK); k++) {
        if (cache.current.has(k) || pending.current.has(k) || k * CHUNK >= view.status.lines) continue;
        pending.current.add(k);
        bigfileLines(view.bigId, k * CHUNK, CHUNK)
          .then((page) => {
            pending.current.delete(k);
            if (epoch !== epochRef.current) return; // file was reset while loading
            cache.current.set(k, { lines: page.lines, truncated: new Set(page.truncated) });
            setTick((t) => t + 1);
          })
          .catch((e) => {
            pending.current.delete(k);
            console.error(e);
          });
      }
    },
    [view.bigId, view.epoch, view.status.lines],
  );

  const get = (line: number): { text: string; truncated: boolean } | undefined => {
    const c = cache.current.get(Math.floor(line / CHUNK));
    const i = line % CHUNK;
    if (!c || i >= c.lines.length) return undefined;
    return { text: c.lines[i], truncated: c.truncated.has(i) };
  };

  return { ensure, get };
}

export function BigFileView({ tabId, title }: { tabId: string; title: string }) {
  const view = useBig((s) => s.views[tabId]);
  const fontSize = useSettings((s) => s.fontSize);
  const fontFamily = useSettings((s) => s.fontFamily);
  const rowH = Math.round(fontSize * 1.5);
  const bodyRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const [bodyH, setBodyH] = useState(400);
  const [query, setQuery] = useState("");
  const [opts, setOpts] = useState({ matchCase: false, wholeWord: false, isRegex: false });
  const [finding, setFinding] = useState(false);

  const rows = Math.max(1, Math.floor(bodyH / rowH));
  const { ensure, get } = useLineCache(view);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBodyH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (view.rows !== rows) patchBig(tabId, { rows });
  }, [rows, view.rows, tabId]);

  useEffect(() => {
    ensure(view.top, view.top + rows + CHUNK / 4);
  }, [ensure, view.top, rows]);

  useEffect(() => {
    bodyRef.current?.focus();
  }, []);

  // Keep keyboard focus here after quick-pick prompts (they try to refocus the hidden Monaco).
  useEffect(() => {
    if (document.activeElement === document.body) bodyRef.current?.focus();
  }, [view.cursor]);

  const total = view.status.lines;
  const scrollBy = (delta: number) => scrollBigTo(tabId, view.top + delta);
  const moveCursor = (line: number) => bigReveal(tabId, line);

  const find = async (backwards: boolean) => {
    if (!query) return;
    setFinding(true);
    try {
      const m = view.match;
      const fromLine = m ? m.line : view.cursor;
      const fromCol = m ? (backwards ? m.start : m.end) : 0;
      const found = await bigfileFind(
        view.bigId,
        { root: "", query, include: "", exclude: "", ...opts },
        fromLine,
        fromCol,
        backwards,
      );
      if (!found) notify(`"${query}" not found`);
      else {
        bigReveal(tabId, found.line, { line: found.line, start: found.start, end: found.end });
        if (found.wrapped) notify(backwards ? "Search wrapped to the end" : "Search wrapped to the top");
      }
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setFinding(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "ArrowDown") moveCursor(view.cursor + 1);
    else if (e.key === "ArrowUp") moveCursor(view.cursor - 1);
    else if (e.key === "PageDown") moveCursor(view.cursor + rows - 1);
    else if (e.key === "PageUp") moveCursor(view.cursor - rows + 1);
    else if (e.key === "End" && mod) moveCursor(total - 1);
    else if (e.key === "Home" && mod) moveCursor(0);
    else if (e.key === "F3") void find(e.shiftKey);
    else if (mod && e.code === "KeyF") {
      findRef.current?.focus();
      findRef.current?.select();
    } else return;
    e.preventDefault();
  };

  // Custom scrollbar: a native one can't cover millions of lines (browsers cap element height).
  const trackH = Math.max(1, bodyH - 4);
  const thumbH = Math.max(28, Math.min(trackH, (trackH * rows) / Math.max(total, 1)));
  const top = maxTop(view);
  const thumbY = top > 0 ? (view.top / top) * (trackH - thumbH) : 0;

  const onThumbDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startTop = view.top;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const frac = (ev.clientY - startY) / Math.max(1, trackH - thumbH);
      scrollBigTo(tabId, startTop + frac * top);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const onTrackDown = (e: React.PointerEvent) => {
    const r = trackRef.current!.getBoundingClientRect();
    scrollBy((e.clientY - r.top < thumbY ? -1 : 1) * (rows - 1));
  };

  const gutterCh = Math.max(4, String(total).length);
  const pct = view.status.size ? Math.floor((view.status.indexedBytes / view.status.size) * 100) : 100;
  const visible = [];
  for (let i = 0; i < rows + 1 && view.top + i < total; i++) {
    const line = view.top + i;
    const data = get(line);
    const m = view.match && view.match.line === line ? view.match : undefined;
    visible.push(
      <div
        key={line}
        className={`bf-row${line === view.cursor ? " cur" : ""}`}
        style={{ height: rowH, lineHeight: `${rowH}px` }}
        onMouseDown={() => moveCursor(line)}
      >
        <span className="bf-num" style={{ width: `${gutterCh + 2}ch` }}>
          {line + 1}
        </span>
        <span className="bf-text">
          {data ? <LineText text={data.text} match={m} /> : <span className="bf-loading">…</span>}
          {data?.truncated && (
            <span className="bf-trunc" title="Line is longer than 16 KB; the rest is not shown">
              {" "}
              ⋯ line truncated
            </span>
          )}
        </span>
      </div>,
    );
  }

  return (
    <div className="bigfile" aria-label={`${title} (read-only)`}>
      <div className="bf-bar">
        <span className="bf-badge">Big file · read-only</span>
        <span className="bf-info">
          {formatBytes(view.status.size)} · {total.toLocaleString()} lines
          {!view.status.complete && ` · indexing ${pct}%`}
        </span>
        <span className="bf-spacer" />
        <input
          ref={findRef}
          className="bf-find"
          placeholder="Find (Enter / Shift+Enter)"
          value={query}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            patchBig(tabId, { match: null });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void find(e.shiftKey);
            else if (e.key === "Escape") bodyRef.current?.focus();
            else if (e.altKey && e.code === "KeyC") setOpts((o) => ({ ...o, matchCase: !o.matchCase }));
            else if (e.altKey && e.code === "KeyW") setOpts((o) => ({ ...o, wholeWord: !o.wholeWord }));
            else if (e.altKey && e.code === "KeyR") setOpts((o) => ({ ...o, isRegex: !o.isRegex }));
            else return;
            e.preventDefault();
          }}
        />
        {(
          [
            ["matchCase", "Aa", "Match case (Alt+C)"],
            ["wholeWord", "ab", "Whole word (Alt+W)"],
            ["isRegex", ".*", "Regular expression (Alt+R)"],
          ] as const
        ).map(([k, label, tip]) => (
          <button
            key={k}
            className={`sp-toggle${opts[k] ? " on" : ""}`}
            aria-pressed={opts[k]}
            title={tip}
            onClick={() => setOpts((o) => ({ ...o, [k]: !o[k] }))}
          >
            {label}
          </button>
        ))}
        <button className="sp-btn" disabled={!query || finding} onClick={() => void find(true)} title="Previous (Shift+F3)">
          ↑
        </button>
        <button className="sp-btn" disabled={!query || finding} onClick={() => void find(false)} title="Next (F3)">
          ↓
        </button>
        <button
          className={`sp-toggle bf-follow${view.follow ? " on" : ""}`}
          aria-pressed={view.follow}
          title="Follow: keep showing the end of the file as it grows (tail -f)"
          onClick={() => void toggleBigFollow(tabId)}
        >
          Follow
        </button>
      </div>
      <div className="bf-main">
        <div
          className="bf-body"
          ref={bodyRef}
          tabIndex={0}
          style={{ fontFamily, fontSize }}
          onKeyDown={onKey}
          onWheel={(e) => {
            if (e.shiftKey) return; // let horizontal scrolling through
            const lines = e.deltaMode === 1 ? e.deltaY : e.deltaY / rowH;
            if (lines) {
              scrollBy(Math.sign(lines) * Math.max(1, Math.round(Math.abs(lines))));
              if (view.follow && lines < 0) patchBig(tabId, { follow: false });
            }
          }}
        >
          <div className="bf-lines">{visible}</div>
        </div>
        <div className="bf-track" ref={trackRef} onPointerDown={onTrackDown}>
          <div className="bf-thumb" style={{ height: thumbH, transform: `translateY(${thumbY}px)` }} onPointerDown={onThumbDown} />
          {view.match && total > 0 && (
            <div className="bf-mark" style={{ top: (view.match.line / total) * trackH }} />
          )}
        </div>
      </div>
    </div>
  );
}
