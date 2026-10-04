import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  bookmarkResultLines,
  cancelSearch,
  clearResults,
  closeSearch,
  FileResult,
  replaceAll,
  revealResult,
  runSearch,
  SearchScope,
  useSearch,
} from "../store/search";
import { useSettings } from "../store/settings";
import type { LineMatch } from "../ipc";

const ROW_H = 22;

type Row = { kind: "file"; file: number } | { kind: "match"; file: number; match: number };

function Preview({ m }: { m: LineMatch }) {
  const text = m.text;
  const parts: React.ReactNode[] = [];
  let pos = 0;
  m.ranges.forEach(([s, e], i) => {
    const a = Math.max(pos, s - m.previewStart);
    const b = Math.min(text.length, e - m.previewStart);
    if (b <= a) return;
    if (a > pos) parts.push(text.slice(pos, a));
    parts.push(<mark key={i}>{text.slice(a, b)}</mark>);
    pos = b;
  });
  parts.push(text.slice(pos));
  return (
    <span className="sr-text">
      {m.previewStart > 0 && "…"}
      {parts}
    </span>
  );
}

function relativeDir(r: FileResult, root: string | undefined) {
  const dir = r.path.slice(0, Math.max(0, r.path.length - r.title.length - 1));
  if (!root || r.tabId) return dir;
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  return norm(dir).startsWith(norm(root)) ? dir.slice(root.length).replace(/^[\\/]/, "") : dir;
}

function Toggle({ on, label, title, onClick }: { on: boolean; label: string; title: string; onClick: () => void }) {
  return (
    <button className={`sp-toggle${on ? " on" : ""}`} aria-pressed={on} title={title} onClick={onClick}>
      {label}
    </button>
  );
}

function ResultsList() {
  const results = useSearch((s) => s.results);
  const collapsed = useSearch((s) => s.collapsed);
  const selected = useSearch((s) => s.selected);
  const root = useSearch((s) => s.lastParams?.folder);
  const boxRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(200);

  const rows = useMemo(() => {
    const out: Row[] = [];
    results.forEach((r, file) => {
      out.push({ kind: "file", file });
      if (!collapsed[r.path]) r.matches.forEach((_, match) => out.push({ kind: "match", file, match }));
    });
    return out;
  }, [results, collapsed]);

  const selectedRow = selected
    ? rows.findIndex((r) => r.kind === "match" && r.file === selected.file && r.match === selected.match)
    : -1;

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the selected row visible (F4 / arrow keys).
  useEffect(() => {
    const el = boxRef.current;
    if (!el || selectedRow < 0) return;
    const top = selectedRow * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  }, [selectedRow]);

  const toggleFile = (path: string) =>
    useSearch.setState((s) => ({ collapsed: { ...s.collapsed, [path]: !s.collapsed[path] } }));

  const moveSelection = (dir: 1 | -1) => {
    for (let i = selectedRow + dir; i >= 0 && i < rows.length; i += dir) {
      const r = rows[i];
      if (r.kind === "match") return void revealResult(r.file, r.match, false);
    }
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + 5);

  return (
    <div
      className="sp-results"
      ref={boxRef}
      tabIndex={0}
      role="tree"
      aria-label="Search results"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") moveSelection(1);
        else if (e.key === "ArrowUp") moveSelection(-1);
        else if (e.key === "Enter" && selected) void revealResult(selected.file, selected.match, true);
        else if (e.key === "Escape") closeSearch();
        else return;
        e.preventDefault();
      }}
    >
      <div style={{ height: rows.length * ROW_H, position: "relative" }}>
        {rows.slice(first, last).map((row, i) => {
          const top = (first + i) * ROW_H;
          const r = results[row.file];
          if (row.kind === "file") {
            const count = r.matches.reduce((n, m) => n + m.ranges.length, 0);
            return (
              <div
                key={`f${row.file}`}
                className="sr-row sr-file"
                role="treeitem"
                aria-expanded={!collapsed[r.path]}
                style={{ top }}
                title={r.path}
                onClick={() => toggleFile(r.path)}
              >
                <span className={`sr-chevron${collapsed[r.path] ? " closed" : ""}`}>▾</span>
                <span className="sr-name">{r.title}</span>
                <span className="sr-dir">{relativeDir(r, root)}</span>
                <span className="sr-count">{count}</span>
              </div>
            );
          }
          const m = r.matches[row.match];
          const isSel = first + i === selectedRow;
          return (
            <div
              key={`m${row.file}:${row.match}`}
              className={`sr-row sr-match${isSel ? " sel" : ""}`}
              role="treeitem"
              aria-selected={isSel}
              style={{ top }}
              onClick={() => void revealResult(row.file, row.match, false)}
              onDoubleClick={() => void revealResult(row.file, row.match, true)}
            >
              <span className="sr-line">{m.line}</span>
              <Preview m={m} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SearchPanel() {
  const s = useSearch();
  const history = useSettings((st) => st.searchHistory);
  const replaceHistory = useSettings((st) => st.replaceHistory);
  const folderHistory = useSettings((st) => st.folderHistory);
  const queryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    queryRef.current?.focus();
    queryRef.current?.select();
  }, [s.focusTick]);

  const set = (patch: Partial<ReturnType<typeof useSearch.getState>>) => useSearch.setState(patch);

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void runSearch();
    else if (e.key === "Escape") closeSearch();
    else if (e.altKey && e.code === "KeyC") set({ matchCase: !s.matchCase });
    else if (e.altKey && e.code === "KeyW") set({ wholeWord: !s.wholeWord });
    else if (e.altKey && e.code === "KeyR") set({ isRegex: !s.isRegex });
    else return;
    e.preventDefault();
  };

  const browse = async () => {
    const dir = await openDialog({ directory: true, defaultPath: s.folder || undefined });
    if (typeof dir === "string") set({ folder: dir });
  };

  const hasResults = s.results.length > 0;
  const allCollapsed = hasResults && s.results.every((r) => s.collapsed[r.path]);

  return (
    <div className="panel-body" aria-label="Find in files">
      <div className="sp-form">
        <div className="sp-row">
          <select
            value={s.scope}
            onChange={(e) => set({ scope: e.target.value as SearchScope })}
            title="Where to search"
          >
            <option value="folder">Folder</option>
            <option value="open">Open documents</option>
            <option value="current">Current document</option>
          </select>
          <button
            className={`sp-toggle${s.showReplace ? " on" : ""}`}
            title="Toggle replace"
            aria-pressed={s.showReplace}
            onClick={() => set({ showReplace: !s.showReplace })}
          >
            ⇄
          </button>
          <input
            ref={queryRef}
            className="sp-query"
            placeholder="Find"
            value={s.query}
            list="sp-history"
            spellCheck={false}
            onChange={(e) => set({ query: e.target.value })}
            onKeyDown={onInputKey}
          />
          <datalist id="sp-history">
            {history.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
          <Toggle on={s.matchCase} label="Aa" title="Match case (Alt+C)" onClick={() => set({ matchCase: !s.matchCase })} />
          <Toggle on={s.wholeWord} label="ab" title="Whole word (Alt+W)" onClick={() => set({ wholeWord: !s.wholeWord })} />
          <Toggle
            on={s.isRegex}
            label=".*"
            title={`Regular expression (Alt+R) — ${s.scope === "folder" ? "Rust regex syntax" : "JavaScript syntax"}`}
            onClick={() => set({ isRegex: !s.isRegex })}
          />
          {s.running ? (
            <button className="sp-btn" onClick={() => void cancelSearch()}>
              Cancel
            </button>
          ) : (
            <button className="sp-btn primary" onClick={() => void runSearch()} disabled={!s.query}>
              Find All
            </button>
          )}
          <button className="sp-icon" title="Close (Esc)" aria-label="Close search panel" onClick={closeSearch}>
            ×
          </button>
        </div>
        {s.showReplace && (
          <div className="sp-row">
            <span className="sp-label">Replace</span>
            <input
              className="sp-query"
              placeholder={s.isRegex ? "Replace ($1 for groups)" : "Replace"}
              value={s.replace}
              list="sp-rhistory"
              spellCheck={false}
              onChange={(e) => set({ replace: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") void replaceAll();
                else if (e.key === "Escape") closeSearch();
                else return;
                e.preventDefault();
              }}
            />
            <datalist id="sp-rhistory">
              {replaceHistory.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
            <button className="sp-btn" onClick={() => void replaceAll()} disabled={!hasResults || s.running}>
              Replace All
            </button>
          </div>
        )}
        {s.scope === "folder" && (
          <div className="sp-row">
            <span className="sp-label">In</span>
            <input
              className="sp-folder"
              placeholder="Folder"
              value={s.folder}
              list="sp-folders"
              spellCheck={false}
              onChange={(e) => set({ folder: e.target.value })}
              onKeyDown={onInputKey}
            />
            <datalist id="sp-folders">
              {folderHistory.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
            <button className="sp-btn" onClick={() => void browse()} title="Choose folder">
              …
            </button>
            <input
              className="sp-glob"
              placeholder="Include: *.ts, *.md"
              value={s.include}
              spellCheck={false}
              onChange={(e) => set({ include: e.target.value })}
              onKeyDown={onInputKey}
            />
            <input
              className="sp-glob"
              placeholder="Exclude: node_modules, *.min.js"
              value={s.exclude}
              spellCheck={false}
              onChange={(e) => set({ exclude: e.target.value })}
              onKeyDown={onInputKey}
            />
          </div>
        )}
      </div>
      <div className="sp-status">
        <span className={s.error ? "sp-error" : undefined} role="status">
          {s.error ?? (s.running ? `Searching… ${s.results.length} files so far` : s.summary)}
        </span>
        <span className="sp-actions">
          {hasResults && (
            <>
              <button onClick={bookmarkResultLines} title="Bookmark every result line in open documents">
                Bookmark lines
              </button>
              <button
                onClick={() =>
                  useSearch.setState({
                    collapsed: Object.fromEntries(s.results.map((r) => [r.path, !allCollapsed])),
                  })
                }
              >
                {allCollapsed ? "Expand all" : "Collapse all"}
              </button>
              <button onClick={clearResults}>Clear</button>
            </>
          )}
        </span>
      </div>
      <ResultsList />
    </div>
  );
}
