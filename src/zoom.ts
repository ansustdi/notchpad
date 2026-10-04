/**
 * One zoom for the whole app: the `fontSize` setting. Ctrl+wheel, Ctrl+=/-/0 and the View menu
 * all change it, and every editor, diff, big-file view and output panel follows it.
 *
 * Monaco's own Ctrl+wheel zoom (`mouseWheelZoom`) is a separate, hidden multiplier on top of
 * the font size; mixing both made "Reset Zoom" leave text huge. It is turned off and cleared.
 */

import { monaco } from "./monaco";
import { DEFAULT_SETTINGS, useSettings } from "./store/settings";
import { isMac } from "./platform";

export const MIN_FONT = 6;
export const MAX_FONT = 48;
/** Wheel distance per font-size step: one mouse notch (120) = 1px; trackpads send many small deltas. */
const WHEEL_STEP = 120;

const clamp = (n: number) => Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(n)));

export function zoomBy(steps: number) {
  const s = useSettings.getState();
  const next = clamp(s.fontSize + steps);
  if (next !== s.fontSize) s.update({ fontSize: next });
}

export function resetZoom() {
  monaco.editor.EditorZoom.setZoomLevel(0);
  useSettings.getState().update({ fontSize: DEFAULT_SETTINGS.fontSize });
}

/** Zoom as a percentage of the default font size (100 = default). */
export const zoomPercent = (fontSize: number) => Math.round((fontSize / DEFAULT_SETTINGS.fontSize) * 100);

let installed = false;

/** Ctrl/Cmd + wheel (and trackpad pinch, which arrives as Ctrl+wheel) anywhere in the app. */
export function installWheelZoom() {
  if (installed) return;
  installed = true;
  // A multiplier left over from Monaco's own wheel zoom would hide under any font size.
  monaco.editor.EditorZoom.setZoomLevel(0);
  let acc = 0;
  window.addEventListener(
    "wheel",
    (e) => {
      if (!(isMac ? e.metaKey : e.ctrlKey)) return;
      // Never let the webview zoom the whole page, or Monaco scroll.
      e.preventDefault();
      e.stopPropagation();
      const px = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      acc += px;
      const steps = Math.trunc(acc / WHEEL_STEP);
      if (steps !== 0) {
        acc -= steps * WHEEL_STEP;
        zoomBy(-steps); // wheel up (negative delta) = bigger
      }
    },
    { capture: true, passive: false },
  );
  // Settings may still hold a size from the old zoom; keep it within sane bounds.
  const s = useSettings.getState();
  if (s.fontSize !== clamp(s.fontSize)) s.update({ fontSize: clamp(s.fontSize) });
}
