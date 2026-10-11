import { useTabs } from "../store/tabs";
import { useUi } from "../store/ui";
import { runCommand } from "../commands/registry";
import { encodingLabel, pickEncodingAction, pickEol, pickLanguage } from "../commands";
import { languageLabel } from "../monaco";
import { useBig } from "../store/bigview";
import { patchHex, selection, useHex } from "../store/hexview";
import { formatOffset } from "../hex/format";
import { useMacro } from "../macro/macro";
import { runLangOf, useRun } from "../store/run";
import { useSettings } from "../store/settings";
import { resetZoom, zoomPercent } from "../zoom";

export function StatusBar() {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === s.activeId));
  const c = useUi((s) => s.cursor);
  const matches = useUi((s) => s.smartMatches);
  const big = useBig((s) => (tab ? s.views[tab.id] : undefined));
  const hex = useHex((s) => (tab ? s.views[tab.id] : undefined));
  const offsetBase = useSettings((s) => s.hexOffsetBase);
  const recording = useMacro((s) => s.recording);
  const playing = useMacro((s) => s.playing);
  const running = useRun((s) => s.running);
  const python = useSettings((s) => s.python);
  const zoom = zoomPercent(useSettings((s) => s.fontSize));
  const zoomBadge =
    zoom !== 100 ? (
      <button onClick={resetZoom} title="Zoom (Ctrl+wheel, Ctrl+= / Ctrl+-). Click to reset (Ctrl+0)">
        {zoom}%
      </button>
    ) : null;
  if (!tab) return <div className="statusbar" />;
  if (hex) {
    const sel = selection(hex);
    const fmt = (n: number) => formatOffset(n, offsetBase, 1) + (offsetBase === "hex" ? "h" : "");
    return (
      <div className="statusbar">
        <div className="status-left">
          <button onClick={() => runCommand("edit.gotoLine")} title="Go to offset (Ctrl+G)">
            Offset: {fmt(hex.cursor)}
            {sel && ` · Block: ${fmt(sel[0])}–${fmt(sel[1] - 1)} · Length: ${fmt(sel[1] - sel[0])}`}
          </button>
          {tab.path && (
            <span className="status-path" title={tab.path}>
              {tab.path}
            </span>
          )}
        </div>
        <div className="status-right">
          {zoomBadge}
          <button onClick={() => patchHex(tab.id, { insert: !hex.insert })} title="Insert / Overwrite (Insert key)">
            {hex.insert ? "Insert" : "Overwrite"}
          </button>
          <span>{hex.len.toLocaleString()} bytes</span>
          <span>Hex</span>
        </div>
      </div>
    );
  }
  if (big) {
    return (
      <div className="statusbar">
        <div className="status-left">
          <button onClick={() => runCommand("edit.gotoLine")} title="Go to line">
            Ln {(big.cursor + 1).toLocaleString()} of {big.status.lines.toLocaleString()}
            {!big.status.complete && " (indexing…)"}
          </button>
          <span className="status-path" title={tab.path ?? ""}>
            {tab.path}
          </span>
        </div>
        <div className="status-right">
          {big.follow && <span>Following</span>}
          {zoomBadge}
          <span>Read-only</span>
          <span>{encodingLabel(tab.encoding, tab.hasBom)}</span>
          <span>Big file</span>
        </div>
      </div>
    );
  }
  return (
    <div className="statusbar">
      <div className="status-left">
        <button onClick={() => runCommand("edit.gotoLine")} title="Go to line">
          Ln {c.line}, Col {c.column}
          {c.selected > 0 && ` (${c.selected} selected)`}
          {c.selected > 0 && matches !== null && ` · ${matches.toLocaleString()}${matches >= 10000 ? "+" : ""} match${matches === 1 ? "" : "es"}`}
          {c.cursors > 1 && ` · ${c.cursors} cursors`}
        </button>
        {tab.path && (
          <span className="status-path" title={tab.path}>
            {tab.path}
          </span>
        )}
      </div>
      <div className="status-right">
        {recording && (
          <button className="status-rec" onClick={() => runCommand("macro.record")} title="Stop recording (Ctrl+Shift+R)">
            ● REC
          </button>
        )}
        {playing && <span>Playing macro…</span>}
        {runLangOf(tab) && (
          <>
            {runLangOf(tab) === "python" && (
              <button onClick={() => runCommand("run.interpreter")} title="Select Python interpreter">
                {python ? python.version : "Python (auto)"}
              </button>
            )}
            <button
              className="status-run"
              onClick={() => runCommand(running ? "run.stop" : "run.file")}
              title={running ? "Stop (Shift+F5)" : "Run file (F5)"}
            >
              {running ? "■ Stop" : "▶ Run"}
            </button>
          </>
        )}
        {zoomBadge}
        <span>{c.insertSpaces ? `Spaces: ${c.tabSize}` : `Tab Size: ${c.tabSize}`}</span>
        <button onClick={pickEncodingAction} title="Change encoding">
          {encodingLabel(tab.encoding, tab.hasBom)}
        </button>
        <button onClick={pickEol} title="Change end of line">
          {tab.eol}
        </button>
        <button onClick={pickLanguage} title="Change language mode">
          {languageLabel(tab.language)}
        </button>
      </div>
    </div>
  );
}
