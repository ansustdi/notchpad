import { useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { monaco } from "../monaco";
import { getEditor } from "../editorRef";
import { readImageDataUrl } from "../ipc";
import { renderMarkdown, resolveLocal } from "../markdown/render";
import { getModel, getTab, openPaths } from "../store/tabs";
import { errorMessage, notify } from "../store/ui";

const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, "") || p;

/** Fence name (`ts`, `c++`, `yml`) → Monaco language id, or null if Monaco doesn't know it. */
function monacoLanguage(name: string): string | null {
  const n = name.toLowerCase();
  for (const l of monaco.languages.getLanguages()) {
    if (l.id === n || l.aliases?.some((a) => a.toLowerCase() === n) || l.extensions?.includes(`.${n}`)) return l.id;
  }
  const extra: Record<string, string> = { sh: "shell", bash: "shell", zsh: "shell", "c++": "cpp", "c#": "csharp", ps1: "powershell" };
  return extra[n] ?? null;
}

/** Find the block the editor's top line falls in and scroll the preview to the same spot. */
function syncScroll(root: HTMLElement, topLine: number) {
  const blocks = root.querySelectorAll<HTMLElement>(".md-block");
  let prev: HTMLElement | null = null;
  let next: HTMLElement | null = null;
  for (const b of blocks) {
    if (Number(b.dataset.line) <= topLine) prev = b;
    else {
      next = b;
      break;
    }
  }
  if (!prev) return void (root.scrollTop = 0);
  const from = Number(prev.dataset.line);
  const to = next ? Number(next.dataset.line) : from + 1;
  const frac = Math.min(1, (topLine - from) / Math.max(1, to - from));
  const top = prev.offsetTop;
  const bottom = next ? next.offsetTop : prev.offsetTop + prev.offsetHeight;
  root.scrollTop = top + (bottom - top) * frac - 8;
}

/** Rendered view of a Markdown tab, updated as the document changes. */
export function MarkdownPreview({ tabId, groupId, side }: { tabId: string; groupId: string; side: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Render, then fix up what HTML alone can't do: highlighting and local images.
  useEffect(() => {
    const model = getModel(tabId);
    const body = bodyRef.current;
    if (!model || !body) return;
    let gen = 0;
    const render = () => {
      const g = ++gen;
      const path = getTab(tabId)?.path ?? null;
      const base = path ? dirname(path) : null;
      body.innerHTML = DOMPurify.sanitize(renderMarkdown(model.getValue()));
      for (const code of body.querySelectorAll<HTMLElement>("code[data-lang]")) {
        const lang = monacoLanguage(code.dataset.lang!);
        if (!lang) continue;
        void monaco.editor.colorize(code.textContent ?? "", lang, { tabSize: 4 }).then((html) => {
          if (g === gen) code.innerHTML = DOMPurify.sanitize(html);
        });
      }
      for (const img of body.querySelectorAll<HTMLImageElement>("img")) {
        const local = resolveLocal(img.getAttribute("src") ?? "", base);
        if (!local) continue;
        img.removeAttribute("src");
        readImageDataUrl(local)
          .then((url) => g === gen && (img.src = url))
          .catch(() => img.classList.add("md-broken"));
      }
    };
    render();
    let timer: number | undefined;
    const sub = model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = window.setTimeout(render, 150);
    });
    return () => {
      clearTimeout(timer);
      sub.dispose();
      gen++;
    };
  }, [tabId]);

  // Side by side: follow the editor's scroll position.
  useEffect(() => {
    const editor = getEditor(groupId);
    const root = rootRef.current;
    if (!side || !editor || !root) return;
    const follow = () => {
      if (editor.getModel() !== getModel(tabId)) return;
      syncScroll(root, lineAt(editor, editor.getScrollTop()));
    };
    const sub = editor.onDidScrollChange(follow);
    const sub2 = editor.onDidChangeModelContent(() => setTimeout(follow, 200));
    requestAnimationFrame(follow);
    return () => {
      sub.dispose();
      sub2.dispose();
    };
  }, [side, groupId, tabId]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      bodyRef.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start" });
      return;
    }
    if (/^(https?|mailto):/i.test(href)) {
      openUrl(href).catch((err) => notify(errorMessage(err), "error"));
      return;
    }
    const path = getTab(tabId)?.path ?? null;
    const local = resolveLocal(href, path ? dirname(path) : null);
    if (local) void openPaths([local]);
  };

  return (
    <div className={`md-preview${side ? " side" : ""}`} ref={rootRef} onClick={onClick}>
      <article className="md-body" ref={bodyRef} />
    </div>
  );
}

/** 0-based source line at vertical offset `top`, accounting for wrapped lines. */
function lineAt(editor: monaco.editor.IStandaloneCodeEditor, top: number): number {
  const ranges = editor.getVisibleRanges();
  if (!ranges.length) return 0;
  const first = ranges[0].startLineNumber;
  const lineTop = editor.getTopForLineNumber(first);
  const nextTop = editor.getTopForLineNumber(first + 1);
  const frac = nextTop > lineTop ? Math.max(0, (top - lineTop) / (nextTop - lineTop)) : 0;
  return first - 1 + frac;
}
