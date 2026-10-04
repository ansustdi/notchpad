import { create } from "zustand";

export interface QuickPickItem {
  id: string;
  label: string;
  detail?: string;
}

export interface QuickPickRequest {
  placeholder: string;
  items: QuickPickItem[];
  activeId?: string;
  onPick: (item: QuickPickItem) => void;
  /** Free-text mode: Enter submits the typed text when no item is selected. */
  onSubmitText?: (text: string) => void;
  /** Custom matching (e.g. fuzzy file search); replaces the built-in label filter. */
  filter?: (query: string) => QuickPickItem[];
}

export type ConfirmChoice = "save" | "discard" | "cancel";

export interface DialogButton {
  id: string;
  label: string;
  primary?: boolean;
}

interface ConfirmRequest {
  message: string;
  detail: string;
  buttons: DialogButton[];
  /** Escape resolves with "cancel". */
  resolve: (choice: string) => void;
}

interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
}

export interface CursorStatus {
  line: number;
  column: number;
  selected: number;
  cursors: number;
  tabSize: number;
  insertSpaces: boolean;
}

interface UiState {
  quickPick: QuickPickRequest | null;
  confirm: ConfirmRequest | null;
  toasts: Toast[];
  cursor: CursorStatus;
  /** Occurrences of the selection in the active editor (smart highlighting), or null. */
  smartMatches: number | null;
}

export const useUi = create<UiState>(() => ({
  quickPick: null,
  confirm: null,
  toasts: [],
  cursor: { line: 1, column: 1, selected: 0, cursors: 1, tabSize: 4, insertSpaces: true },
  smartMatches: null,
}));

export const isModalOpen = () => {
  const s = useUi.getState();
  return s.quickPick !== null || s.confirm !== null;
};

export function showQuickPick(req: QuickPickRequest) {
  useUi.setState({ quickPick: req });
}

export function askText(placeholder: string, onSubmit: (text: string) => void) {
  showQuickPick({ placeholder, items: [], onPick: () => {}, onSubmitText: onSubmit });
}

export function closeQuickPick() {
  useUi.setState({ quickPick: null });
}

export function ask(message: string, detail: string, buttons: DialogButton[]): Promise<string> {
  return new Promise((resolve) => {
    useUi.setState({
      confirm: {
        message,
        detail,
        buttons,
        resolve: (choice) => {
          useUi.setState({ confirm: null });
          resolve(choice);
        },
      },
    });
  });
}

export function askSave(message: string): Promise<ConfirmChoice> {
  return ask(message, "Your changes will be lost if you don't save them.", [
    { id: "save", label: "Save", primary: true },
    { id: "discard", label: "Don't Save" },
    { id: "cancel", label: "Cancel" },
  ]) as Promise<ConfirmChoice>;
}

let toastSeq = 0;

export function notify(message: string, kind: Toast["kind"] = "info") {
  const id = ++toastSeq;
  useUi.setState((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
  setTimeout(() => useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 8000 : 3500);
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
