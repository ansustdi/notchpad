import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { bigfileRefresh, IndexStatus } from "../ipc";
import { scheduleSessionSave } from "../session";

export interface BigMatch {
  line: number;
  start: number;
  end: number;
}

export interface BigView {
  bigId: number;
  status: IndexStatus;
  /** First visible line, 0-based. */
  top: number;
  /** Current line, 0-based. */
  cursor: number;
  /** Visible row count, reported by the view. */
  rows: number;
  match: BigMatch | null;
  follow: boolean;
  /** Bumped when cached line pages are stale (file truncated / rotated). */
  epoch: number;
}

interface BigState {
  views: Record<string, BigView>;
}

export const useBig = create<BigState>(() => ({ views: {} }));

export const getBigView = (tabId: string): BigView | undefined => useBig.getState().views[tabId];

export function patchBig(tabId: string, patch: Partial<BigView> | ((v: BigView) => Partial<BigView>)) {
  useBig.setState((s) => {
    const v = s.views[tabId];
    if (!v) return s;
    const p = typeof patch === "function" ? patch(v) : patch;
    return { views: { ...s.views, [tabId]: { ...v, ...p } } };
  });
}

export function registerBig(tabId: string, bigId: number, status: IndexStatus, top = 0) {
  useBig.setState((s) => ({
    views: {
      ...s.views,
      [tabId]: { bigId, status, top, cursor: top, rows: 40, match: null, follow: false, epoch: 0 },
    },
  }));
}

export function unregisterBig(tabId: string) {
  useBig.setState((s) => {
    const { [tabId]: _, ...rest } = s.views;
    return { views: rest };
  });
}

/** Highest valid `top` so the last line sits at the bottom of the viewport. */
export const maxTop = (v: Pick<BigView, "status" | "rows">) => Math.max(0, v.status.lines - v.rows + 1);

export function scrollBigTo(tabId: string, top: number) {
  patchBig(tabId, (v) => ({ top: Math.min(maxTop(v), Math.max(0, Math.round(top))) }));
  scheduleSessionSave();
}

/** Move the cursor to `line` (0-based) and keep it visible, centring when it jumps far. */
export function bigReveal(tabId: string, line: number, match: BigMatch | null = null) {
  patchBig(tabId, (v) => {
    const cursor = Math.min(Math.max(0, line), Math.max(0, v.status.lines - 1));
    let top = v.top;
    if (cursor < top || cursor >= top + v.rows - 1) top = cursor - Math.floor(v.rows / 2);
    return { cursor, match, top: Math.min(maxTop(v), Math.max(0, top)), follow: false };
  });
  scheduleSessionSave();
}

/** Toggle follow (tail -f); turning it on jumps to the end right away. */
export async function toggleBigFollow(tabId: string) {
  const view = useBig.getState().views[tabId];
  if (!view) return;
  const follow = !view.follow;
  patchBig(tabId, { follow });
  if (follow) {
    const [reset, status] = await bigfileRefresh(view.bigId).catch(() => [false, view.status] as const);
    patchBig(tabId, (v) => ({
      status,
      epoch: reset ? v.epoch + 1 : v.epoch,
      top: maxTop({ status, rows: v.rows }),
      cursor: Math.max(0, status.lines - 1),
    }));
  }
}

function onStatus(bigId: number, status: IndexStatus) {
  const entry = Object.entries(useBig.getState().views).find(([, v]) => v.bigId === bigId);
  if (!entry) return;
  const [tabId, v] = entry;
  const next = { ...v, status };
  patchBig(tabId, v.follow ? { status, top: maxTop(next), cursor: Math.max(0, status.lines - 1) } : { status });
}

void listen<IndexStatus & { id: number }>("bigfile-index", (e) => {
  const { id, ...status } = e.payload;
  onStatus(id, status);
});

// Follow mode: poll followed files once a second. Polling (not a file watcher) works the same
// on every OS and survives log rotation, since each read re-opens the path.
setInterval(() => {
  for (const [tabId, v] of Object.entries(useBig.getState().views)) {
    if (!v.follow) continue;
    bigfileRefresh(v.bigId)
      .then(([reset, status]) => {
        if (reset) patchBig(tabId, (cur) => ({ epoch: cur.epoch + 1, match: null }));
        onStatus(v.bigId, status);
      })
      .catch(() => {});
  }
}, 1000);
