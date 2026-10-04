import { useEffect, useMemo, useRef, useState } from "react";
import { closeQuickPick, QuickPickItem, useUi } from "../store/ui";
import { getEditor } from "../editorRef";

/** Rows rendered at most; typing narrows the rest (Goto Anything can list 100k files). */
const MAX_SHOWN = 300;

/** Lower is better; null = no match. Every query word must appear; earlier and word-start hits rank higher. */
function score(label: string, q: string): number | null {
  if (!q) return 0;
  const l = label.toLowerCase();
  let total = 0;
  for (const word of q.split(/\s+/)) {
    const idx = l.indexOf(word);
    if (idx < 0) return null;
    const wordStart = idx === 0 || /[\s:.(\-_/]/.test(l[idx - 1]);
    total += (wordStart ? 0 : 1) + idx / 100;
  }
  return total;
}

function QuickPick() {
  const req = useUi((s) => s.quickPick)!;
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    if (req.filter) return req.filter(query).slice(0, MAX_SHOWN);
    const q = query.trim().toLowerCase();
    return req.items
      .map((it) => ({ it, s: score(it.label, q) }))
      .filter((x): x is { it: QuickPickItem; s: number } => x.s !== null)
      .sort((a, b) => a.s - b.s)
      .slice(0, MAX_SHOWN)
      .map((x) => x.it);
  }, [req, query]);

  useEffect(() => {
    setQuery("");
    const i = req.activeId ? req.items.findIndex((it) => it.id === req.activeId) : 0;
    setSel(Math.max(0, i));
  }, [req]);

  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel, items]);

  const close = () => {
    closeQuickPick();
    getEditor()?.focus();
  };
  const pick = (item?: QuickPickItem) => {
    if (!item) return;
    close();
    req.onPick(item);
  };

  return (
    <div className="overlay" onPointerDown={close}>
      <div className="quickpick" onPointerDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder={req.placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setSel((s) => Math.min(items.length - 1, s + 1));
            else if (e.key === "ArrowUp") setSel((s) => Math.max(0, s - 1));
            else if (e.key === "PageDown") setSel((s) => Math.min(items.length - 1, s + 10));
            else if (e.key === "PageUp") setSel((s) => Math.max(0, s - 10));
            else if (e.key === "Enter") {
              if (req.onSubmitText && !items[sel]) {
                close();
                req.onSubmitText(query.trim());
              } else pick(items[sel]);
            }
            else if (e.key === "Escape") close();
            else return;
            e.preventDefault();
          }}
        />
        <div className="qp-list" ref={listRef} role="listbox">
          {items.map((it, i) => (
            <div
              key={it.id}
              role="option"
              aria-selected={i === sel}
              className={`qp-item${i === sel ? " sel" : ""}${it.id === req.activeId ? " current" : ""}`}
              onPointerEnter={() => setSel(i)}
              onClick={() => pick(it)}
            >
              <span>{it.label}</span>
              {it.detail && <span className="qp-detail">{it.detail}</span>}
            </div>
          ))}
          {items.length === 0 && !req.onSubmitText && <div className="qp-empty">No matches</div>}
        </div>
      </div>
    </div>
  );
}

function Confirm() {
  const req = useUi((s) => s.confirm)!;
  const saveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => saveRef.current?.focus(), []);
  return (
    <div className="overlay center">
      <div
        className="dialog"
        role="dialog"
        onKeyDown={(e) => {
          if (e.key === "Escape") req.resolve("cancel");
        }}
      >
        <p>{req.message}</p>
        <p className="dialog-sub">{req.detail}</p>
        <div className="dialog-buttons">
          {req.buttons.map((b) => (
            <button
              key={b.id}
              ref={b.primary ? saveRef : undefined}
              className={b.primary ? "primary" : undefined}
              onClick={() => req.resolve(b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

export function Overlays() {
  const hasPick = useUi((s) => s.quickPick !== null);
  const hasConfirm = useUi((s) => s.confirm !== null);
  return (
    <>
      {hasPick && <QuickPick />}
      {hasConfirm && <Confirm />}
      <Toasts />
    </>
  );
}
