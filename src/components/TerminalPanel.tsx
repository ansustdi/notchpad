import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { attachTerminal, killTerminal, newTerminal, restartTerminal, showTerminal, useTerminal } from "../store/terminal";

/** Integrated terminal: the active shell, plus a list of shells when there is more than one. */
export function TerminalPanel() {
  const sessions = useTerminal((s) => s.sessions);
  const activeId = useTerminal((s) => s.activeId);
  const hostRef = useRef<HTMLDivElement>(null);
  const active = sessions.find((s) => s.id === activeId);

  useEffect(() => {
    if (activeId === null || !hostRef.current) return;
    return attachTerminal(activeId, hostRef.current);
  }, [activeId]);

  return (
    <div className="term-panel">
      <div className="term-host" ref={hostRef} />
      <div className="term-side">
        <div className="term-actions">
          <button title="New Terminal (Ctrl+Shift+`)" aria-label="New terminal" onClick={() => void newTerminal()}>
            +
          </button>
          {active?.exited && (
            <button title="Restart" aria-label="Restart terminal" onClick={() => restartTerminal(active.id)}>
              ↻
            </button>
          )}
          <button title="Kill Terminal" aria-label="Kill terminal" onClick={() => killTerminal()}>
            🗑
          </button>
        </div>
        {sessions.length > 1 && (
          <ul className="term-list" role="listbox" aria-label="Terminals">
            {sessions.map((s, i) => (
              <li
                key={s.id}
                role="option"
                aria-selected={s.id === activeId}
                className={`term-item${s.id === activeId ? " active" : ""}${s.exited ? " exited" : ""}`}
                onClick={() => showTerminal(s.id)}
              >
                <span className="term-item-name">
                  {i + 1}: {s.title}
                </span>
                <button
                  className="term-item-close"
                  title="Kill"
                  aria-label={`Kill ${s.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    killTerminal(s.id);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
