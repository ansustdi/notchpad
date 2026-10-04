import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_id, label) {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

export { monaco };

export const PLAINTEXT = "plaintext";

let byExt: Map<string, string> | null = null;
let byName: Map<string, string> | null = null;

function buildLanguageIndex() {
  byExt = new Map();
  byName = new Map();
  for (const lang of monaco.languages.getLanguages()) {
    for (const ext of lang.extensions ?? []) {
      if (!byExt.has(ext.toLowerCase())) byExt.set(ext.toLowerCase(), lang.id);
    }
    for (const name of lang.filenames ?? []) byName.set(name.toLowerCase(), lang.id);
  }
}

export function languageForPath(path: string | null): string {
  if (!path) return PLAINTEXT;
  if (!byExt || !byName) buildLanguageIndex();
  const name = path.split(/[\\/]/).pop()!.toLowerCase();
  const exact = byName!.get(name);
  if (exact) return exact;
  // Try longest extension first so ".d.ts" style names resolve before ".ts".
  for (let i = name.indexOf("."); i !== -1; i = name.indexOf(".", i + 1)) {
    const lang = byExt!.get(name.slice(i));
    if (lang) return lang;
  }
  return PLAINTEXT;
}

export function languageLabel(id: string): string {
  const lang = monaco.languages.getLanguages().find((l) => l.id === id);
  return lang?.aliases?.[0] ?? id;
}
