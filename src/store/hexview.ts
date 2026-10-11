import { create } from "zustand";
import { hexChecksums, HexChecksum, hexFind, hexRead, hexReplace, hexSave } from "../ipc";
import { copyText, pasteText } from "../clipboard";
import { decodeText, encodeText, parseHexString, toHexString } from "../hex/format";
import { useSettings } from "./settings";
import { ask, errorMessage, notify } from "./ui";
import { getTab, makePermanent, setTabDirty } from "./tabs";
import { scheduleSessionSave } from "../session";

/** One undoable edit: `removed` was replaced by `inserted` at `offset`. */
interface Op {
  offset: number;
  removed: Uint8Array;
  inserted: Uint8Array;
  cursorBefore: number;
  cursorAfter: number;
  /** Unique, so "saved at op N" survives undo / redo. */
  seq: number;
}

export type HexPane = "hex" | "text";

export interface HexView {
  hexId: number;
  len: number;
  /** Caret offset, 0..len (len = after the last byte). */
  cursor: number;
  /** Other end of the selection; null = no selection. Selection is [min, max) of the two. */
  anchor: number | null;
  /** Second hex digit of the byte is being typed. */
  nibble: 0 | 1;
  pane: HexPane;
  insert: boolean;
  /** First visible row. */
  top: number;
  /** Visible row count, reported by the view. */
  rows: number;
  /** Bumped on every change to the bytes so the view re-reads. */
  epoch: number;
  undo: Op[];
  redo: Op[];
  /** `seq` of the newest applied op when last saved (0 = original, -1 = unreachable by undo). */
  savedSeq: number;
  checksums: { range: [number, number]; list: HexChecksum[] } | null;
}

export const useHex = create<{ views: Record<string, HexView> }>(() => ({ views: {} }));

export const getHexView = (tabId: string): HexView | undefined => useHex.getState().views[tabId];

export function patchHex(tabId: string, patch: Partial<HexView> | ((v: HexView) => Partial<HexView>)) {
  useHex.setState((s) => {
    const v = s.views[tabId];
    if (!v) return s;
    const p = typeof patch === "function" ? patch(v) : patch;
    return { views: { ...s.views, [tabId]: { ...v, ...p } } };
  });
}

export function registerHex(tabId: string, hexId: number, len: number, top = 0, cursor = 0) {
  const c = Math.min(cursor, len);
  useHex.setState((s) => ({
    views: {
      ...s.views,
      [tabId]: {
        hexId, len, cursor: c, anchor: null, nibble: 0, pane: "hex", insert: false, top, rows: 32,
        epoch: 0, undo: [], redo: [], savedSeq: 0, checksums: null,
      },
    },
  }));
}

export function unregisterHex(tabId: string) {
  useHex.setState((s) => {
    const { [tabId]: _, ...rest } = s.views;
    return { views: rest };
  });
}

/** Write the document to `path` once queued edits have landed; marks exactly what was written as saved. */
export function saveHexDoc(tabId: string, path: string) {
  return serial(async () => {
    const v = getHexView(tabId);
    if (!v) throw new Error("document is no longer open");
    const seq = v.undo.at(-1)?.seq ?? 0;
    await hexSave(v.hexId, path);
    patchHex(tabId, (cur) => ({ savedSeq: seq, epoch: cur.epoch + 1 }));
    refreshDirty(tabId);
  });
}

function refreshDirty(tabId: string) {
  const v = getHexView(tabId);
  if (v) setTabDirty(tabId, (v.undo.at(-1)?.seq ?? 0) !== v.savedSeq);
}

export const bytesPerRow = () => useSettings.getState().hexBytesPerRow;

export function selection(v: HexView): [number, number] | null {
  if (v.anchor === null || v.anchor === v.cursor) return null;
  return [Math.min(v.anchor, v.cursor), Math.max(v.anchor, v.cursor)];
}

/** Rows in the document (one more when the end falls on a row boundary, for the caret). */
export const totalRows = (len: number) => Math.floor(len / bytesPerRow()) + 1;

export const maxTop = (v: Pick<HexView, "len" | "rows">) => Math.max(0, totalRows(v.len) - v.rows);

/** The view reports how many rows fit; keeps `top` in range (window grew, file shrank). */
export function setHexRows(tabId: string, rows: number) {
  patchHex(tabId, (v) => ({ rows, top: Math.min(v.top, maxTop({ len: v.len, rows })) }));
}

export function scrollHexTo(tabId: string, top: number) {
  patchHex(tabId, (v) => ({ top: Math.min(maxTop(v), Math.max(0, Math.round(top))) }));
  scheduleSessionSave();
}

/** Move the caret (extending the selection with `extend`) and keep it on screen. */
export function moveCursor(tabId: string, to: number, extend = false, pane?: HexPane) {
  patchHex(tabId, (v) => {
    const cursor = Math.min(Math.max(0, Math.round(to)), v.len);
    const anchor = extend ? (v.anchor ?? v.cursor) : null;
    const row = Math.floor(cursor / bytesPerRow());
    let top = v.top;
    if (row < top) top = row;
    else if (row >= top + v.rows) top = row - v.rows + 1;
    return { cursor, anchor, nibble: 0, top: Math.min(maxTop(v), Math.max(0, top)), pane: pane ?? v.pane };
  });
}

/** `moveCursor` after any queued edits, so a click or arrow key never races a keystroke. */
export const moveCursorQueued = (tabId: string, to: number | ((v: HexView) => number), extend = false, pane?: HexPane) =>
  withView(tabId, (v) => moveCursor(tabId, typeof to === "function" ? to(v) : to, extend, pane));

/** Set caret and anchor directly (mouse drag), after queued edits. */
export const setSelectionQueued = (tabId: string, anchor: number, cursor: number) =>
  withView(tabId, () => {
    moveCursor(tabId, cursor);
    patchHex(tabId, { anchor });
  });

/** Select [start, end) and show it. */
export function selectRange(tabId: string, start: number, end: number) {
  moveCursor(tabId, start);
  moveCursor(tabId, end, true);
  patchHex(tabId, (v) => {
    const row = Math.floor(start / bytesPerRow());
    // Centre a far jump instead of leaving the match on the last row.
    return row < v.top || row >= v.top + v.rows - 1 ? { top: Math.min(maxTop(v), Math.max(0, row - Math.floor(v.rows / 3))) } : {};
  });
}

let opSeq = 0;
let busy = Promise.resolve();

/** Edits run one at a time, in order (each depends on the previous length and offsets). */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = busy.then(fn, fn);
  busy = next.then(
    () => {},
    () => {},
  );
  return next;
}

/** Edits removing more than this can't be undone (the bytes would have to cross IPC as JSON). */
const UNDO_LIMIT = 16 << 20;
const MAX_UNDO = 5000;

/** Replace `del` bytes at `offset` with `bytes`, recording undo. `merge` folds it into the last op. */
async function editNow(tabId: string, offset: number, del: number, bytes: Uint8Array, cursorAfter: number, opts: { merge?: boolean; nibble?: 0 | 1 } = {}) {
  const v = getHexView(tabId);
  if (!v) return;
  if (del > UNDO_LIMIT) {
    const mb = (del / 1024 / 1024).toFixed(0);
    const ok = await ask(`Remove ${mb} MB?`, "An edit this large can't be undone.", [
      { id: "ok", label: "Remove", primary: true },
      { id: "cancel", label: "Cancel" },
    ]);
    if (ok !== "ok") return;
  }
  const cursorBefore = v.cursor;
  try {
    const res = await hexReplace(v.hexId, offset, del, bytes, UNDO_LIMIT);
    patchHex(tabId, (cur) => {
      const base = { len: res.len, redo: [], epoch: cur.epoch + 1, checksums: null };
      // Not undoable: earlier history no longer applies, and it stays dirty until saved.
      if (!res.removed) return { ...base, undo: [], savedSeq: -1 };
      const removed = new Uint8Array(res.removed);
      const last = cur.undo.at(-1);
      let undo: Op[];
      if (opts.merge && last && last.offset === offset && last.inserted.length === del) {
        undo = [...cur.undo.slice(0, -1), { ...last, inserted: bytes, cursorAfter, seq: ++opSeq }];
      } else {
        undo = [...cur.undo, { offset, removed, inserted: bytes, cursorBefore, cursorAfter, seq: ++opSeq }];
      }
      let savedSeq = cur.savedSeq;
      if (undo.length > MAX_UNDO) {
        undo = undo.slice(-MAX_UNDO);
        // The saved state fell off the history: undoing everything no longer gets back to it.
        if (savedSeq !== -1 && !undo.some((o) => o.seq === savedSeq)) savedSeq = -1;
      }
      return { ...base, undo, savedSeq };
    });
    moveCursor(tabId, cursorAfter);
    if (opts.nibble) patchHex(tabId, { nibble: opts.nibble });
    makePermanent(tabId);
    refreshDirty(tabId);
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

/** Run `fn` with the view's state as it is once every earlier edit has landed. */
const withView = (tabId: string, fn: (v: HexView) => Promise<unknown> | void) =>
  serial(async () => {
    const v = getHexView(tabId);
    if (v) await fn(v);
  });

export function hexUndo(tabId: string, redo = false) {
  return serial(async () => {
    const v = getHexView(tabId);
    const op = v && (redo ? v.redo.at(-1) : v.undo.at(-1));
    if (!v || !op) return;
    try {
      const res = redo
        ? await hexReplace(v.hexId, op.offset, op.removed.length, op.inserted, 0)
        : await hexReplace(v.hexId, op.offset, op.inserted.length, op.removed, 0);
      patchHex(tabId, (cur) =>
        redo
          ? { len: res.len, undo: [...cur.undo, op], redo: cur.redo.slice(0, -1), epoch: cur.epoch + 1, checksums: null }
          : { len: res.len, undo: cur.undo.slice(0, -1), redo: [...cur.redo, op], epoch: cur.epoch + 1, checksums: null },
      );
      moveCursor(tabId, redo ? op.cursorAfter : op.cursorBefore);
      refreshDirty(tabId);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  });
}

/** Type a hex digit (hex pane) at the caret. */
export function typeNibble(tabId: string, digit: number) {
  return withView(tabId, async (v) => {
    const sel = selection(v);
    // Typing over a selection replaces it with the new byte.
    if (sel) return editNow(tabId, sel[0], sel[1] - sel[0], new Uint8Array([digit << 4]), sel[0], { nibble: 1 });
    if (v.nibble === 1) {
      const cur = v.undo.at(-1)?.inserted[0] ?? 0;
      return editNow(tabId, v.cursor, 1, new Uint8Array([(cur & 0xf0) | digit]), v.cursor + 1, { merge: true });
    }
    if (v.insert || v.cursor >= v.len) return editNow(tabId, v.cursor, 0, new Uint8Array([digit << 4]), v.cursor, { nibble: 1 });
    const [cur = 0] = await hexRead(v.hexId, v.cursor, 1);
    return editNow(tabId, v.cursor, 1, new Uint8Array([(digit << 4) | (cur & 0x0f)]), v.cursor, { nibble: 1 });
  });
}

/** Type bytes (text pane, paste) at the caret: insert, or overwrite in overwrite mode. */
export function typeBytes(tabId: string, bytes: Uint8Array) {
  return withView(tabId, (v) => {
    if (!bytes.length) return;
    const sel = selection(v);
    if (sel) return editNow(tabId, sel[0], sel[1] - sel[0], bytes, sel[0] + bytes.length);
    const del = v.insert ? 0 : Math.min(bytes.length, v.len - v.cursor);
    return editNow(tabId, v.cursor, del, bytes, v.cursor + bytes.length);
  });
}

/** Delete the selection, or the byte after (`forward`) / before the caret. */
export function deleteBytes(tabId: string, forward: boolean) {
  return withView(tabId, (v) => {
    const sel = selection(v);
    if (sel) return editNow(tabId, sel[0], sel[1] - sel[0], new Uint8Array(), sel[0]);
    if (forward ? v.cursor >= v.len : v.cursor <= 0) return;
    const at = forward ? v.cursor : v.cursor - 1;
    return editNow(tabId, at, 1, new Uint8Array(), at);
  });
}

const MAX_CLIPBOARD = 16 << 20;

export function hexCopy(tabId: string, cut = false) {
  return withView(tabId, async (v) => {
    const selected = selection(v);
    const sel = selected ?? (v.cursor < v.len ? [v.cursor, v.cursor + 1] : null);
    if (!sel) return;
    if (sel[1] - sel[0] > MAX_CLIPBOARD) return notify("Selection is too large to copy (16 MB max)", "error");
    const bytes = await hexRead(v.hexId, sel[0], sel[1] - sel[0]);
    await copyText(v.pane === "hex" ? toHexString(bytes) : decodeText(bytes, useSettings.getState().hexCharset));
    // Still inside the queue: delete exactly the range that was copied.
    if (cut && selected) await editNow(tabId, sel[0], sel[1] - sel[0], new Uint8Array(), sel[0]);
  });
}

export async function hexPaste(tabId: string) {
  const v = getHexView(tabId);
  if (!v) return;
  const text = await pasteText();
  if (!text) return;
  const bytes = (v.pane === "hex" && parseHexString(text)) || encodeText(text, useSettings.getState().hexCharset);
  await typeBytes(tabId, bytes);
}

export function selectAll(tabId: string) {
  const v = getHexView(tabId);
  if (v) patchHex(tabId, { anchor: 0, cursor: v.len, nibble: 0 });
}

export interface HexSearch {
  text: string;
  /** "hex" = the query is hex bytes, "text" = characters in the current charset. */
  mode: "hex" | "text";
  ignoreCase: boolean;
}

/** Find the next (or previous) match from the caret and select it. */
export function hexFindNext(tabId: string, q: HexSearch, backwards = false): Promise<boolean> {
  return serial(() => findNow(tabId, q, backwards));
}

async function findNow(tabId: string, q: HexSearch, backwards: boolean): Promise<boolean> {
  const v = getHexView(tabId);
  if (!v || !q.text) return false;
  const pattern = q.mode === "hex" ? parseHexString(q.text) : encodeText(q.text, useSettings.getState().hexCharset);
  if (!pattern) {
    notify("Not a hex byte sequence (e.g. 4D 5A 90 00)", "error");
    return false;
  }
  const sel = selection(v);
  const from = backwards ? (sel ? sel[0] : v.cursor) : sel ? sel[0] + 1 : v.cursor;
  try {
    let at = await hexFind(v.hexId, pattern, from, backwards, q.mode === "text" && q.ignoreCase);
    // Wrap around once.
    if (at === null) at = await hexFind(v.hexId, pattern, backwards ? v.len : 0, backwards, q.mode === "text" && q.ignoreCase);
    if (at === null) {
      notify(`"${q.text}" not found`);
      return false;
    }
    selectRange(tabId, at, at + pattern.length);
    return true;
  } catch (e) {
    notify(errorMessage(e), "error");
    return false;
  }
}

/** Checksums of the selection, or of the whole document when nothing is selected. */
export function computeChecksums(tabId: string) {
  return withView(tabId, (v) => checksumsNow(tabId, v));
}

async function checksumsNow(tabId: string, v: HexView) {
  const range: [number, number] = selection(v) ?? [0, v.len];
  try {
    const list = await hexChecksums(v.hexId, range[0], range[1] - range[0]);
    patchHex(tabId, { checksums: { range, list } });
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

export const isHexTab = (id: string | null | undefined) => !!id && !!getTab(id)?.hex;
