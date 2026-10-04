import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Chunk, clearOutput, openLocation, rerun, sendEof, sendInput, stopRun, useRun } from "../store/run";
import { useSettings } from "../store/settings";
import { findLocations } from "../run/links";

function Linked({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let pos = 0;
  for (const loc of findLocations(text)) {
    parts.push(text.slice(pos, loc.index));
    const label = text.slice(loc.index, loc.index + loc.length);
    parts.push(
      <a
        key={loc.index}
        href="#"
        className="out-link"
        title={`Open ${loc.path} at line ${loc.line}`}
        onClick={(e) => {
          e.preventDefault();
          void openLocation(loc.path, loc.line, loc.column);
        }}
      >
        {label}
      </a>,
    );
    pos = loc.index + loc.length;
  }
  parts.push(text.slice(pos));
  return <>{parts}</>;
}

function ChunkView({ c }: { c: Chunk }) {
  const linkable = c.kind === "stderr" || c.kind === "stdout";
  return <span className={`out-${c.kind}`}>{linkable ? <Linked text={c.text} /> : c.text}</span>;
}

export function OutputPanel() {
  const { chunks, running, trimmed, exit, last, startedAt } = useRun();
  const fontFamily = useSettings((s) => s.fontFamily);
  const fontSize = useSettings((s) => s.fontSize);
  const boxRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  const [input, setInput] = useState("");
  const [now, setNow] = useState(Date.now());

  // Follow new output unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chunks]);

  useEffect(() => {
    if (running) inputRef.current?.focus();
  }, [running]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);

  const status = running
    ? `Running ${last?.title ?? ""} · ${(((now - (startedAt ?? now)) / 1000) | 0).toString()}s`
    : exit
      ? exit.killed
        ? "Stopped"
        : `Exit code ${exit.code ?? "?"} · ${(exit.elapsedMs / 1000).toFixed(2)}s`
      : "";

  return (
    <div className="panel-body output-panel">
      <div className="sp-status">
        <span className={exit && !exit.killed && exit.code !== 0 ? "sp-error" : undefined} role="status">
          {status}
        </span>
        <span className="sp-actions">
          {running ? (
            <button onClick={() => void stopRun()} title="Stop (Shift+F5)">
              ■ Stop
            </button>
          ) : (
            <button onClick={() => void rerun()} disabled={!last} title="Run again (Ctrl+F5)">
              ↻ Run again
            </button>
          )}
          <button onClick={clearOutput}>Clear</button>
        </span>
      </div>
      <pre
        className="out-text"
        ref={boxRef}
        style={{ fontFamily, fontSize: Math.max(11, fontSize - 1) }}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {trimmed > 0 && <span className="out-info">[{trimmed.toLocaleString()} earlier characters trimmed]{"\n"}</span>}
        {chunks.map((c, i) => (
          <ChunkView key={i} c={c} />
        ))}
      </pre>
      <form
        className="out-input"
        onSubmit={(e) => {
          e.preventDefault();
          void sendInput(input);
          setInput("");
        }}
      >
        <span className="out-prompt" aria-hidden>
          ›
        </span>
        <input
          ref={inputRef}
          value={input}
          disabled={!running}
          spellCheck={false}
          placeholder={running ? "Input for the program (Enter to send)" : "Program input (while running)"}
          aria-label="Program input"
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="button" className="sp-btn" disabled={!running} onClick={() => void sendEof()} title="Close input (end of file)">
          EOF
        </button>
      </form>
    </div>
  );
}
