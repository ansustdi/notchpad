import { monaco } from "../monaco";
import { getEditor } from "../editorRef";
import { detectRuntime, findUp, formatPipe, openFile, runCacheDir, runProbe, writeRunFile } from "../ipc";
import { activeTab, getModel, getTab, setBeforeSave } from "./tabs";
import { useSettings } from "./settings";
import { askText, errorMessage, notify, showQuickPick } from "./ui";
import { resolvePython } from "./run";
import { formatJson } from "../tools/json";
import { formatXml } from "../tools/xml";
import { cargoPackageField, dirname, safeName, Tool } from "../run/plan";
import {
  acceptOutput,
  FMT_EXT,
  FMT_INSTALL,
  FMT_LABEL,
  FmtLang,
  fmtLangOf,
  FmtPlan,
  Formatter,
  formattersFor,
  minimalEdit,
  planFormat,
  PY_MODULE,
  TOOL_OF,
} from "../format/plan";

/** Availability per formatter (+ interpreter / folder where it matters). Cleared by re-detect. */
const cache = new Map<string, Promise<Tool | null>>();

function memo(key: string, find: () => Promise<Tool | null>) {
  if (!cache.has(key)) cache.set(key, find().catch(() => null));
  return cache.get(key)!;
}

async function resolveFormatter(f: Formatter, dir: string, python: Tool | null): Promise<Tool | null> {
  if (always(f)) return null;
  const module = PY_MODULE[f];
  if (module) {
    if (!python) return null;
    const py = python;
    return memo(`${f}|${py.program} ${py.args.join(" ")}`, async () =>
      (await runProbe(py.program, [...py.args, "-m", module, "--version"])) ? py : null,
    );
  }
  const kind = TOOL_OF[f]!;
  // prettier can be installed per project (node_modules/.bin).
  const key = kind === "prettier" ? `${kind}|${dir}` : kind;
  const tool = await memo(key, () => detectRuntime(kind, dir));
  // `dotnet format` is built into the .NET 6+ SDK.
  if (f === "dotnet-format" && tool && Number(/^(\d+)/.exec(tool.version)?.[1] ?? 0) < 6) return null;
  return tool;
}

const always = (f: Formatter) => f === "monaco" || f === "json" || f === "xml" || f === "sql";

async function pickFormatter(lang: FmtLang, dir: string, python: Tool | null) {
  for (const f of formattersFor(lang)) {
    if (always(f)) return { formatter: f, tool: null };
    const tool = await resolveFormatter(f, dir, python);
    if (tool) return { formatter: f, tool };
  }
  return null;
}

const indentOf = (model: monaco.editor.ITextModel) => {
  const o = model.getOptions();
  return o.insertSpaces ? " ".repeat(o.indentSize ?? o.tabSize) : "\t";
};

/** Replace the model text with `formatted` as one undoable edit touching only what changed. */
function apply(model: monaco.editor.ITextModel, formatted: string): boolean {
  const eol = model.getEOL();
  const before = model.getValue();
  const after = formatted.replace(/\r?\n/g, eol);
  const edit = minimalEdit(before, after);
  if (!edit) return false;
  const range = monaco.Range.fromPositions(model.getPositionAt(edit.start), model.getPositionAt(edit.end));
  const visible = getEditor();
  const editor = visible?.getModel() === model ? visible : null;
  model.pushStackElement();
  if (editor) editor.executeEdits("format", [{ range, text: edit.text, forceMoveMarkers: true }]);
  else model.pushEditOperations(null, [{ range, text: edit.text }], () => null);
  model.pushStackElement();
  return true;
}

/** Built-in formatters (JSON, XML, SQL) run in the editor itself. SQL loads on first use. */
async function runBuiltin(which: "json" | "xml" | "sql", text: string, model: monaco.editor.ITextModel): Promise<string> {
  if (which === "json") return formatJson(text, indentOf(model));
  if (which === "xml") return formatXml(text, indentOf(model));
  const { formatSql } = await import("../format/sql");
  const s = useSettings.getState();
  return formatSql(text, { dialect: s.sqlDialect, layout: s.sqlLayout, keywordCase: s.sqlKeywordCase, indent: indentOf(model) });
}

async function runPlan(plan: FmtPlan, text: string, file: string, model: monaco.editor.ITextModel): Promise<string> {
  switch (plan.kind) {
    case "builtin":
      return runBuiltin(plan.which, text, model);
    case "pipe": {
      const res = await formatPipe(plan.program, plan.args, plan.cwd, text);
      const verdict = acceptOutput(text, res.code, res.stdout, res.stderr);
      if (!verdict.ok) throw new Error(verdict.error);
      return res.stdout;
    }
    case "dotnet":
      return dotnetFormat(plan.program, plan.targetFramework, text, file);
    case "monaco":
      throw new Error("the built-in formatter runs through the editor");
  }
}

/**
 * `dotnet format` formats projects, so format a copy inside a one-file scratch project. The
 * nearest .editorconfig is copied along so the project's C# style still applies.
 */
async function dotnetFormat(dotnet: string, targetFramework: string, text: string, file: string): Promise<string> {
  const name = safeName(file.split(/[\\/]/).pop()!.replace(/\.[^.]*$/, ""));
  const cacheDir = await runCacheDir();
  const sep = cacheDir.includes("\\") ? "\\" : "/";
  const folder = [cacheDir, "fmt", "cs", name].join(sep);
  const found = /[\\/]/.test(file) ? await findUp(dirname(file), [".editorconfig"]) : null;
  let config = found ? ((await openFile(found).catch(() => null))?.content ?? "") : "";
  // Stop .editorconfig lookup at the scratch folder, whatever lives above the app cache.
  if (!/^\s*root\s*=\s*true/im.test(config)) config = `root = true\n${config}`;
  await writeRunFile(`fmt/cs/${name}/.editorconfig`, config);
  await writeRunFile(
    `fmt/cs/${name}/fmt.csproj`,
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>${targetFramework}</TargetFramework><OutputType>Library</OutputType></PropertyGroup></Project>\n`,
  );
  const copy = await writeRunFile(`fmt/cs/${name}/${name}.cs`, text);
  const res = await formatPipe(dotnet, ["format", "whitespace", "fmt.csproj"], folder, null, 120000);
  if (res.code !== 0) throw new Error(errorLines(res.stderr || res.stdout) || `dotnet format exited with ${res.code}`);
  return (await openFile(copy)).content;
}

const errorLines = (s: string) =>
  s
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 4)
    .join("\n");

async function rustEdition(file: string): Promise<string | null> {
  if (!/[\\/]/.test(file)) return null;
  const toml = await findUp(dirname(file), ["Cargo.toml"]);
  if (!toml) return null;
  return cargoPackageField((await openFile(toml).catch(() => null))?.content ?? "", "edition");
}

let cacheDirPromise: Promise<string> | null = null;

/**
 * Format a document with its language's formatter. `silent` (format on save) only speaks up
 * on errors. Returns true if the text changed.
 */
export async function formatTab(tabId: string, { silent = false } = {}): Promise<boolean> {
  const tab = getTab(tabId);
  const model = getModel(tabId);
  if (!tab || !model) {
    if (!silent) notify("Big-file tabs are read-only");
    return false;
  }
  const lang = fmtLangOf(tab.language, tab.path ?? tab.title);
  if (!lang) {
    if (!silent) notify(`No formatter for ${tab.language === "plaintext" ? "plain text" : tab.language}`);
    return false;
  }
  const saved = !!tab.path;
  const cwd = saved ? dirname(tab.path!) : await (cacheDirPromise ??= runCacheDir());
  // Unsaved buffers get a name with the right extension so formatters know the language.
  const file = tab.path ?? (/\.[^.]+$/.test(tab.title) ? tab.title : `${tab.title}.${FMT_EXT[lang]}`);
  const custom = useSettings.getState().formatCommands[lang];

  let plan: FmtPlan;
  try {
    const python = lang === "python" && !custom ? await resolvePython(cwd, saved) : null;
    const picked = custom ? { formatter: formattersFor(lang)[0], tool: null } : await pickFormatter(lang, cwd, python);
    if (!picked) {
      notify(`No ${FMT_LABEL[lang]} formatter found. ${FMT_INSTALL[lang]}`, "error");
      return false;
    }
    plan = planFormat({
      lang,
      formatter: picked.formatter,
      tool: picked.tool,
      file,
      cwd,
      rustEdition: lang === "rust" ? await rustEdition(file) : null,
      custom,
    });
  } catch (e) {
    notify(`Format: ${errorMessage(e)}`, "error");
    return false;
  }

  if (plan.kind === "monaco") {
    // The editor's own formatter (JS/TS/CSS/HTML) works on the visible editor.
    const editor = getEditor();
    if (editor?.getModel() !== model) return false;
    const before = model.getAlternativeVersionId();
    await editor.getAction("editor.action.formatDocument")?.run();
    const changed = model.getAlternativeVersionId() !== before;
    if (!silent) notify(changed ? "Formatted with the built-in formatter" : "Already formatted");
    return changed;
  }

  // Built-in formatters can format just the selection (handy for one query in a long script).
  const editor = getEditor();
  const selections = editor?.getModel() === model ? (editor.getSelections() ?? []).filter((s) => !s.isEmpty()) : [];
  if (plan.kind === "builtin" && selections.length && !silent && editor) {
    try {
      const eol = model.getEOL();
      const edits = [];
      for (const sel of selections) {
        const original = model.getValueInRange(sel, monaco.editor.EndOfLinePreference.LF);
        let out = await runBuiltin(plan.which, original, model);
        if (!original.endsWith("\n")) out = out.replace(/\n$/, "");
        edits.push({ range: sel, text: out.replace(/\n/g, eol) });
      }
      model.pushStackElement();
      editor.executeEdits("format", edits);
      model.pushStackElement();
      notify(`Formatted ${selections.length > 1 ? `${selections.length} selections` : "selection"} (${FMT_LABEL[lang]})`);
      return true;
    } catch (e) {
      notify(`${FMT_LABEL[lang]} format failed:\n${errorMessage(e)}`, "error");
      return false;
    }
  }

  const version = model.getVersionId();
  const text = model.getValue(monaco.editor.EndOfLinePreference.LF);
  try {
    const formatted = await runPlan(plan, text, file, model);
    // The user kept typing while the formatter ran: don't clobber their edits.
    if (model.isDisposed() || model.getVersionId() !== version) {
      if (!silent) notify("Document changed while formatting; run Format again");
      return false;
    }
    const changed = apply(model, formatted);
    const label = plan.kind === "pipe" || plan.kind === "dotnet" ? plan.label : FMT_LABEL[lang];
    if (!silent) notify(changed ? `Formatted with ${label}` : `Already formatted (${label})`);
    return changed;
  } catch (e) {
    notify(`${FMT_LABEL[lang]} format failed:\n${errorMessage(e)}`, "error");
    return false;
  }
}

export async function formatActive() {
  const tab = activeTab();
  if (tab) await formatTab(tab.id);
}

export function toggleFormatOnSave() {
  const on = !useSettings.getState().formatOnSave;
  useSettings.getState().update({ formatOnSave: on });
  notify(on ? "Format on save: on" : "Format on save: off");
}

/** Per-language formatter override: a command reading stdin and writing stdout. */
export function configureFormatter() {
  const tab = activeTab();
  const lang = tab ? fmtLangOf(tab.language, tab.path ?? tab.title) : null;
  if (!lang) return notify("Open a file of a formattable language first");
  const current = useSettings.getState().formatCommands[lang] ?? "";
  askText(
    `${FMT_LABEL[lang]} formatter (stdin → stdout) — {file} {dir} {name} {ext}; empty = automatic${current ? ` (now: ${current})` : ""}`,
    (text) => {
      const formatCommands = { ...useSettings.getState().formatCommands };
      if (text) formatCommands[lang] = text;
      else delete formatCommands[lang];
      useSettings.getState().update({ formatCommands });
      notify(text ? `${FMT_LABEL[lang]} formats with: ${text}` : `${FMT_LABEL[lang]}: automatic formatter`);
    },
  );
}

/** SQL formatting options: dialect, layout and keyword case (three quick picks in a row). */
export async function sqlFormatOptions() {
  const { SQL_DIALECTS, SQL_LAYOUTS } = await import("../format/sql");
  const s = useSettings.getState();
  showQuickPick({
    placeholder: "SQL dialect",
    items: SQL_DIALECTS.map((d) => ({ id: d.id, label: d.label })),
    activeId: s.sqlDialect,
    onPick: (d) =>
      setTimeout(() =>
        showQuickPick({
          placeholder: "SQL layout",
          items: SQL_LAYOUTS.map((l) => ({ id: l.id, label: l.label, detail: l.detail })),
          activeId: s.sqlLayout,
          onPick: (l) =>
            setTimeout(() =>
              showQuickPick({
                placeholder: "Keyword case",
                items: [
                  { id: "upper", label: "UPPER", detail: "SELECT … FROM" },
                  { id: "lower", label: "lower", detail: "select … from" },
                  { id: "preserve", label: "As written" },
                ],
                activeId: s.sqlKeywordCase,
                onPick: (c) => {
                  useSettings.getState().update({
                    sqlDialect: d.id as typeof s.sqlDialect,
                    sqlLayout: l.id as typeof s.sqlLayout,
                    sqlKeywordCase: c.id as typeof s.sqlKeywordCase,
                  });
                  notify(`SQL: ${d.label}, ${l.label}, ${c.label} keywords`);
                },
              }),
            ),
        }),
      ),
  });
}

export function redetectFormatters() {
  cache.clear();
}

setBeforeSave(async (id) => {
  if (useSettings.getState().formatOnSave) await formatTab(id, { silent: true });
});

