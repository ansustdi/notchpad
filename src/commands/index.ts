import { copyText } from "../clipboard";
import {
  closeProject,
  editProject,
  openProjectDialog,
  saveProjectAs,
  switchProject,
} from "../store/project";
import {
  addFolderDialog,
  gotoAnything,
  openFolderDialog,
  refresh as refreshFolders,
  revealActive,
  toggleSidebar,
} from "../store/workspace";
import { resetZoom, zoomBy } from "../zoom";
import { configureFormatter, formatActive, redetectFormatters, sqlFormatOptions, toggleFormatOnSave } from "../store/format";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { allCommands, formatKeys, registerCommands, runCommand } from "./registry";
import { runEditorAction } from "../editorRef";
import { clearBookmarks, copyBookmarkedLines, gotoBookmark, removeLines, toggleBookmark } from "../bookmarks";
import { closeSearch, openSearch, stepResult, useSearch } from "../store/search";
import { monaco } from "../monaco";
import { useSettings, ThemeSetting } from "../store/settings";
import { askText, notify, showQuickPick } from "../store/ui";
import { setCommandObserver } from "./registry";
import { checkText, currentText, indentUnit, transformText } from "../tools/apply";
import { formatJson, minifyJson, parseJson } from "../tools/json";
import { checkXml, formatXml, minifyXml } from "../tools/xml";
import { base64Decode, base64Encode, sha256Hex, urlDecode } from "../tools/textops";
import { compareWithClipboard, compareWithSaved, compareWithTab } from "../store/diff";
import {
  closeOutput,
  configureRunCommand,
  openOutput,
  redetectTools,
  rerun,
  runActiveFile,
  selectInterpreter,
  stopRun,
  useRun,
} from "../store/run";
import {
  deleteSavedMacro,
  playMacro,
  playMultiple,
  recordAppCommand,
  runSavedMacro,
  saveMacro,
  toggleRecording,
} from "../macro/macro";
import { bigReveal } from "../store/bigview";
import { killTerminal, newTerminal, toggleTerminal } from "../store/terminal";
import { toggleMdMode } from "../store/markdown";
import {
  activeTab,
  closeOthers,
  closeAll,
  closeToRight,
  closeGroup,
  cloneToGroup,
  focusGroup,
  moveToGroup,
  otherGroup,
  setOrientation,
  splitActive,
  togglePin,
  useTabs,
  closeTab,
  cycleTab,
  newUntitled,
  openWithDialog,
  reopenClosed,
  reopenWithEncoding,
  saveAll,
  saveTab,
  setEol,
  setLanguage,
  setSaveEncoding,
  openHex,
  reopenInHex,
  reopenAsText,
} from "../store/tabs";
import { computeChecksums, hexUndo } from "../store/hexview";
import { focusHexSearch, hexGoto } from "../components/HexView";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

export const ENCODINGS: { id: string; label: string; encoding: string; bom: boolean }[] = [
  { id: "utf8", label: "UTF-8", encoding: "UTF-8", bom: false },
  { id: "utf8bom", label: "UTF-8 with BOM", encoding: "UTF-8", bom: true },
  { id: "utf16le", label: "UTF-16 LE", encoding: "UTF-16LE", bom: true },
  { id: "utf16be", label: "UTF-16 BE", encoding: "UTF-16BE", bom: true },
  { id: "win1252", label: "Western (Windows-1252)", encoding: "windows-1252", bom: false },
  { id: "win1250", label: "Central European (Windows-1250)", encoding: "windows-1250", bom: false },
  { id: "win1251", label: "Cyrillic (Windows-1251)", encoding: "windows-1251", bom: false },
  { id: "koi8r", label: "Cyrillic (KOI8-R)", encoding: "KOI8-R", bom: false },
  { id: "iso88592", label: "Central European (ISO-8859-2)", encoding: "ISO-8859-2", bom: false },
  { id: "iso88595", label: "Cyrillic (ISO-8859-5)", encoding: "ISO-8859-5", bom: false },
  { id: "win1253", label: "Greek (Windows-1253)", encoding: "windows-1253", bom: false },
  { id: "win1254", label: "Turkish (Windows-1254)", encoding: "windows-1254", bom: false },
  { id: "sjis", label: "Japanese (Shift_JIS)", encoding: "Shift_JIS", bom: false },
  { id: "eucjp", label: "Japanese (EUC-JP)", encoding: "EUC-JP", bom: false },
  { id: "euckr", label: "Korean (EUC-KR)", encoding: "EUC-KR", bom: false },
  { id: "gbk", label: "Simplified Chinese (GBK)", encoding: "GBK", bom: false },
  { id: "gb18030", label: "Simplified Chinese (GB18030)", encoding: "gb18030", bom: false },
  { id: "big5", label: "Traditional Chinese (Big5)", encoding: "Big5", bom: false },
];

export function encodingLabel(encoding: string, bom: boolean): string {
  const e = encoding.toLowerCase();
  return ENCODINGS.find((x) => x.encoding.toLowerCase() === e && (x.bom === bom || !e.startsWith("utf-8")))?.label ?? encoding;
}

function withActive(fn: (id: string) => unknown) {
  return () => {
    const tab = activeTab();
    if (tab) return fn(tab.id);
  };
}

function pickEncoding(mode: "save" | "reopen") {
  const tab = activeTab();
  if (!tab) return;
  if (mode === "reopen" && !tab.path) return;
  showQuickPick({
    placeholder: mode === "save" ? "Save with encoding…" : "Reopen with encoding…",
    items: ENCODINGS.map((e) => ({ id: e.id, label: e.label, detail: e.encoding })),
    activeId: ENCODINGS.find((e) => e.label === encodingLabel(tab.encoding, tab.hasBom))?.id,
    onPick: (item) => {
      const enc = ENCODINGS.find((e) => e.id === item.id)!;
      if (mode === "save") setSaveEncoding(tab.id, enc.encoding, enc.bom);
      else void reopenWithEncoding(tab.id, enc.encoding);
    },
  });
}

export function pickEncodingAction() {
  const tab = activeTab();
  showQuickPick({
    placeholder: "Encoding",
    items: [
      { id: "reopen", label: "Reopen with Encoding", detail: tab?.path ? "" : "(file not saved yet)" },
      { id: "save", label: "Save with Encoding" },
    ],
    onPick: (item) => setTimeout(() => pickEncoding(item.id as "save" | "reopen")),
  });
}

export function pickLanguage() {
  const tab = activeTab();
  if (!tab) return;
  const langs = monaco.languages
    .getLanguages()
    .map((l) => ({ id: l.id, label: l.aliases?.[0] ?? l.id, detail: l.extensions?.slice(0, 4).join(" ") }))
    .sort((a, b) => a.label.localeCompare(b.label));
  showQuickPick({
    placeholder: "Select language mode",
    items: langs,
    activeId: tab.language,
    onPick: (item) => setLanguage(tab.id, item.id),
  });
}

export function pickEol() {
  const tab = activeTab();
  if (!tab) return;
  showQuickPick({
    placeholder: "Select end of line sequence",
    items: [
      { id: "LF", label: "LF", detail: "Unix / macOS" },
      { id: "CRLF", label: "CRLF", detail: "Windows" },
    ],
    activeId: tab.eol,
    onPick: (item) => setEol(tab.id, item.id as "LF" | "CRLF"),
  });
}

function pickTheme() {
  const items: { id: ThemeSetting; label: string }[] = [
    { id: "system", label: "Follow system" },
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
  ];
  showQuickPick({
    placeholder: "Color theme",
    items,
    activeId: useSettings.getState().theme,
    onPick: (item) => useSettings.getState().update({ theme: item.id as ThemeSetting }),
  });
}

export function openPalette() {
  const cmds = allCommands()
    .filter((c) => !c.hidden)
    .map((c) => ({
      id: c.id,
      label: c.category ? `${c.category}: ${c.label}` : c.label,
      detail: formatKeys(c.keys),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  showQuickPick({
    placeholder: "Type a command",
    items: cmds,
    onPick: (item) => setTimeout(() => runCommand(item.id)),
  });
}

/** Id of the active tab when it's a hex document. */
const activeHex = () => {
  const tab = activeTab();
  return tab?.hex ? tab.id : null;
};

/** Run `hex` for a hex tab, else `other` (Monaco). */
const hexOr = (hex: (id: string) => unknown, other: () => unknown) => () => {
  const id = activeHex();
  return id ? hex(id) : other();
};

async function openFileInHex() {
  const picked = await openFileDialog({ multiple: true, directory: false, defaultPath: activeTab()?.path ?? undefined });
  if (!picked) return;
  for (const path of Array.isArray(picked) ? picked : [picked]) {
    await openHex(path).catch((e) => notify(String(e), "error"));
  }
}

function gotoLine() {
  const tab = activeTab();
  if (tab?.hex) return hexGoto(tab.id);
  if (!tab?.big) return runEditorAction("editor.action.gotoLine");
  askText("Go to line (big file)", (text) => {
    const n = Number(text.replace(/[,_\s]/g, ""));
    if (Number.isFinite(n) && n >= 1) bigReveal(tab.id, n - 1);
  });
}

const settings = () => useSettings.getState();
const zoom = (delta: number) => (delta === 0 ? resetZoom() : zoomBy(delta));

setCommandObserver(recordAppCommand);

async function copySha256() {
  const text = currentText();
  if (text === null) return;
  const hex = await sha256Hex(text);
  await copyText(hex);
  notify(`SHA-256 copied: ${hex}`);
}

registerCommands([
  // File
  { id: "file.new", category: "File", label: "New", keys: "Mod+N", run: newUntitled },
  { interactive: true, id: "file.open", category: "File", label: "Open…", keys: "Mod+O", run: openWithDialog },
  { interactive: true, id: "file.openFolder", category: "File", label: "Open Folder…", run: openFolderDialog },
  { interactive: true, id: "file.addFolder", category: "File", label: "Add Folder to Sidebar…", run: addFolderDialog },
  { interactive: true, id: "file.gotoAnything", category: "File", label: "Goto Anything (Go to File)…", keys: "Mod+P", run: gotoAnything },
  { id: "view.sidebar", category: "View", label: "Toggle Side Bar", keys: "Mod+B", run: toggleSidebar },
  {
    id: "view.previewTabs",
    category: "View",
    label: "Toggle Preview Tabs (single-click opens temporarily)",
    run: () => settings().update({ previewTabs: !settings().previewTabs }),
  },

  // Projects (Sublime .sublime-project)
  { interactive: true, id: "project.open", category: "Project", label: "Open Project…", run: openProjectDialog },
  { interactive: true, id: "project.switch", category: "Project", label: "Switch Project…", keys: "Mod+Alt+P", run: switchProject },
  { interactive: true, id: "project.saveAs", category: "Project", label: "Save Project As…", run: saveProjectAs },
  { interactive: true, id: "project.close", category: "Project", label: "Close Project", run: closeProject },
  { interactive: true, id: "project.edit", category: "Project", label: "Edit Project", run: editProject },
  { id: "view.revealInSidebar", category: "View", label: "Reveal in Side Bar", run: revealActive },
  { id: "view.refreshFolders", category: "View", label: "Refresh Folders", run: () => refreshFolders() },
  { id: "file.save", category: "File", label: "Save", keys: "Mod+S", run: withActive((id) => saveTab(id)) },
  { interactive: true, id: "file.saveAs", category: "File", label: "Save As…", keys: "Mod+Shift+S", run: withActive((id) => saveTab(id, true)) },
  { id: "file.saveAll", category: "File", label: "Save All", keys: "Mod+Alt+S", run: saveAll },
  { id: "file.close", category: "File", label: "Close Tab", keys: "Mod+W", run: withActive(closeTab) },
  { id: "file.closeOthers", category: "File", label: "Close Other Tabs", run: withActive((id) => closeOthers(id)) },
  { id: "file.closeToRight", category: "File", label: "Close Tabs to the Right", run: withActive((id) => closeToRight(id)) },
  { id: "file.closeAll", category: "File", label: "Close All Tabs", run: () => closeAll() },
  { id: "tab.pin", category: "Tab", label: "Pin / Unpin Tab", run: withActive(togglePin) },

  // Editor groups (split view)
  { id: "group.split", category: "View", label: "Split Editor", keys: "Mod+\\", run: splitActive },
  {
    id: "group.moveToOther",
    category: "View",
    label: "Move Tab to Other Group",
    run: withActive((id) => moveToGroup(id, useTabs.getState().activeGroup, otherGroup(useTabs.getState().activeGroup))),
  },
  {
    id: "group.cloneToOther",
    category: "View",
    label: "Clone Tab to Other Group",
    run: withActive((id) => cloneToGroup(id, useTabs.getState().activeGroup, otherGroup(useTabs.getState().activeGroup))),
  },
  { id: "group.close", category: "View", label: "Close Group", run: () => closeGroup(useTabs.getState().activeGroup) },
  {
    id: "group.toggleLayout",
    category: "View",
    label: "Toggle Split Layout (Columns / Rows)",
    run: () => setOrientation(useTabs.getState().orientation === "columns" ? "rows" : "columns"),
  },
  ...[1, 2, 3, 4].map((n) => ({
    id: `group.focus${n}`,
    category: "View",
    label: `Focus Group ${n}`,
    keys: `Mod+${n}`,
    run: () => focusGroup(n - 1),
  })),
  { id: "file.reopenClosed", category: "File", label: "Reopen Closed Tab", keys: "Mod+Shift+T", run: reopenClosed },
  { interactive: true, id: "file.exit", category: "File", label: "Exit", run: () => getCurrentWindow().close() },

  // Tabs
  { id: "tab.next", label: "Next Tab", keys: "Ctrl+Tab", run: () => cycleTab(1), hidden: true },
  { id: "tab.prev", label: "Previous Tab", keys: "Ctrl+Shift+Tab", run: () => cycleTab(-1), hidden: true },

  // Edit (delegated to Monaco actions)
  { id: "edit.undo", category: "Edit", label: "Undo", run: hexOr((id) => hexUndo(id), () => runEditorAction("undo")), hidden: true },
  { id: "edit.redo", category: "Edit", label: "Redo", run: hexOr((id) => hexUndo(id, true), () => runEditorAction("redo")), hidden: true },
  { interactive: true, id: "edit.find", category: "Edit", label: "Find", run: hexOr(focusHexSearch, () => runEditorAction("actions.find")) },
  { interactive: true, id: "edit.replace", category: "Edit", label: "Replace", run: () => runEditorAction("editor.action.startFindReplaceAction") },
  { interactive: true, id: "edit.gotoLine", category: "Edit", label: "Go to Line…", keys: "Mod+G", run: gotoLine },
  { id: "edit.toggleComment", category: "Edit", label: "Toggle Line Comment", run: () => runEditorAction("editor.action.commentLine") },
  { id: "edit.duplicateLine", category: "Edit", label: "Duplicate Line", run: () => runEditorAction("editor.action.copyLinesDownAction") },
  { id: "edit.selectAllMatches", category: "Edit", label: "Select All Occurrences", run: () => runEditorAction("editor.action.selectHighlights") },
  { id: "edit.format", category: "Edit", label: "Format Document", keys: "Shift+Alt+F", run: formatActive },
  { id: "edit.formatOnSave", category: "Edit", label: "Toggle Format on Save", run: toggleFormatOnSave },
  { interactive: true, id: "edit.formatConfigure", category: "Edit", label: "Set Formatter for This Language…", run: configureFormatter },
  { interactive: true, id: "edit.sqlFormatOptions", category: "Edit", label: "SQL Format Options…", run: sqlFormatOptions },

  // Search
  { interactive: true, id: "search.findInFiles", category: "Search", label: "Find in Files…", keys: "Mod+Shift+F", run: () => openSearch({ scope: "folder" }) },
  { interactive: true, id: "search.replaceInFiles", category: "Search", label: "Replace in Files…", keys: "Mod+Shift+H", run: () => openSearch({ scope: "folder", replace: true }) },
  { interactive: true, id: "search.findInOpen", category: "Search", label: "Find All in Open Documents…", run: () => openSearch({ scope: "open" }) },
  { interactive: true, id: "search.findInCurrent", category: "Search", label: "Find All in Current Document…", run: () => openSearch({ scope: "current" }) },
  { id: "search.nextResult", category: "Search", label: "Next Search Result", keys: "F4", run: () => stepResult(1) },
  { id: "search.prevResult", category: "Search", label: "Previous Search Result", keys: "Shift+F4", run: () => stepResult(-1) },
  {
    interactive: true,
    id: "search.togglePanel",
    category: "View",
    label: "Toggle Search Panel",
    run: () => (useSearch.getState().open ? closeSearch() : openSearch()),
  },

  // Bookmarks (Notepad++ keys)
  { id: "bookmark.toggle", category: "Bookmark", label: "Toggle Bookmark", keys: "Mod+F2", run: () => toggleBookmark() },
  { id: "bookmark.next", category: "Bookmark", label: "Next Bookmark", keys: "F2", run: () => gotoBookmark(1) },
  { id: "bookmark.prev", category: "Bookmark", label: "Previous Bookmark", keys: "Shift+F2", run: () => gotoBookmark(-1) },
  { id: "bookmark.clear", category: "Bookmark", label: "Clear All Bookmarks", run: clearBookmarks },
  { id: "bookmark.copy", category: "Bookmark", label: "Copy Bookmarked Lines", run: copyBookmarkedLines },
  { id: "bookmark.remove", category: "Bookmark", label: "Remove Bookmarked Lines", run: () => removeLines(false) },
  { id: "bookmark.keep", category: "Bookmark", label: "Remove Non-Bookmarked Lines", run: () => removeLines(true) },

  // Text tools
  { id: "text.upper", category: "Text", label: "Transform to Uppercase", run: () => runEditorAction("editor.action.transformToUppercase") },
  { id: "text.lower", category: "Text", label: "Transform to Lowercase", run: () => runEditorAction("editor.action.transformToLowercase") },
  { id: "text.title", category: "Text", label: "Transform to Title Case", run: () => runEditorAction("editor.action.transformToTitlecase") },
  { id: "text.sortAsc", category: "Text", label: "Sort Lines Ascending", run: () => runEditorAction("editor.action.sortLinesAscending") },
  { id: "text.sortDesc", category: "Text", label: "Sort Lines Descending", run: () => runEditorAction("editor.action.sortLinesDescending") },
  { id: "text.dedupe", category: "Text", label: "Remove Duplicate Lines", run: () => runEditorAction("editor.action.removeDuplicateLines") },
  { id: "text.trim", category: "Text", label: "Trim Trailing Whitespace", run: () => runEditorAction("editor.action.trimTrailingWhitespace") },
  { id: "text.joinLines", category: "Text", label: "Join Lines", run: () => runEditorAction("editor.action.joinLines") },

  // Tools: JSON / XML
  { id: "tools.jsonFormat", category: "Tools", label: "JSON: Format", run: () => transformText("Format JSON", (t) => formatJson(t, indentUnit())) },
  { id: "tools.jsonMinify", category: "Tools", label: "JSON: Minify", run: () => transformText("Minify JSON", minifyJson) },
  { id: "tools.jsonSort", category: "Tools", label: "JSON: Sort Keys", run: () => transformText("Sort JSON keys", (t) => formatJson(t, indentUnit(), true)) },
  {
    id: "tools.jsonValidate",
    category: "Tools",
    label: "JSON: Validate",
    run: () => checkText("JSON", (t) => void parseJson(t)) && notify("Valid JSON ✓"),
  },
  { id: "tools.xmlFormat", category: "Tools", label: "XML: Format", run: () => transformText("Format XML", (t) => formatXml(t, indentUnit())) },
  { id: "tools.xmlMinify", category: "Tools", label: "XML: Minify", run: () => transformText("Minify XML", minifyXml) },
  {
    id: "tools.xmlValidate",
    category: "Tools",
    label: "XML: Check Well-Formed",
    run: () => checkText("XML", (t) => void checkXml(t)) && notify("Well-formed XML ✓"),
  },

  // Tools: compare
  { interactive: true, id: "tools.compareTab", category: "Tools", label: "Compare With Open Document…", run: compareWithTab },
  { interactive: true, id: "tools.compareSaved", category: "Tools", label: "Compare With Saved File", run: compareWithSaved },
  { interactive: true, id: "tools.compareClipboard", category: "Tools", label: "Compare With Clipboard", run: compareWithClipboard },

  // Tools: encoding helpers
  { id: "text.base64Encode", category: "Text", label: "Base64 Encode", run: () => transformText("Base64 encode", base64Encode) },
  { id: "text.base64Decode", category: "Text", label: "Base64 Decode", run: () => transformText("Base64 decode", base64Decode) },
  { id: "text.urlEncode", category: "Text", label: "URL Encode", run: () => transformText("URL encode", encodeURIComponent) },
  { id: "text.urlDecode", category: "Text", label: "URL Decode", run: () => transformText("URL decode", urlDecode) },
  { id: "text.sha256", category: "Text", label: "Copy SHA-256 Hash", run: copySha256 },

  // Run
  { interactive: true, id: "run.file", category: "Run", label: "Run File", keys: "F5", run: () => runActiveFile() },
  { interactive: true, id: "run.again", category: "Run", label: "Run Again", keys: "Mod+F5", run: rerun },
  { id: "run.stop", category: "Run", label: "Stop", keys: "Shift+F5", run: stopRun },
  { interactive: true, id: "run.interpreter", category: "Run", label: "Select Python Interpreter…", run: selectInterpreter },
  { interactive: true, id: "run.configure", category: "Run", label: "Set Run Command for This Language…", run: configureRunCommand },
  {
    interactive: true,
    id: "run.redetect",
    category: "Run",
    label: "Re-detect Runtimes and Formatters",
    run: () => {
      redetectFormatters();
      redetectTools();
    },
  },
  {
    interactive: true,
    id: "run.toggleOutput",
    category: "Run",
    label: "Show / Hide Output",
    run: () => (useRun.getState().open ? closeOutput() : openOutput()),
  },

  // Markdown preview (VS Code keys; Ctrl+K V is bound inside Monaco, see EditorHost)
  { id: "markdown.preview", category: "Markdown", label: "Toggle Markdown Preview", keys: "Mod+Shift+V", run: () => toggleMdMode("preview") },
  { id: "markdown.previewSide", category: "Markdown", label: "Open Markdown Preview to the Side", run: () => toggleMdMode("side") },

  // Hex editor (HxD style)
  { interactive: true, id: "hex.openFile", category: "Hex", label: "Open File in Hex Editor…", run: openFileInHex },
  { id: "hex.reopen", category: "Hex", label: "Reopen Active File in Hex Editor", run: () => reopenInHex() },
  { id: "hex.asText", category: "Hex", label: "Reopen Hex Document as Text", run: () => reopenAsText() },
  { id: "hex.new", category: "Hex", label: "New Hex Document", run: () => openHex(null) },
  { id: "hex.checksums", category: "Hex", label: "Checksums (CRC-32, MD5, SHA…)", run: hexOr(computeChecksums, () => notify("Checksums work on hex documents")) },

  // Integrated terminal (VS Code keys; Ctrl even on macOS, like VS Code)
  { id: "terminal.toggle", category: "Terminal", label: "Toggle Terminal", keys: "Ctrl+`", run: toggleTerminal },
  { id: "terminal.new", category: "Terminal", label: "New Terminal", keys: "Ctrl+Shift+`", run: newTerminal },
  { id: "terminal.kill", category: "Terminal", label: "Kill Terminal", run: () => killTerminal() },

  // Macros (Notepad++ style)
  { id: "macro.record", category: "Macro", label: "Start / Stop Recording", keys: "Mod+Shift+R", run: toggleRecording },
  { id: "macro.play", category: "Macro", label: "Play Macro", keys: "Mod+Shift+E", run: () => playMacro(1) },
  { id: "macro.playN", category: "Macro", label: "Run Macro Multiple Times…", run: playMultiple },
  { id: "macro.playEof", category: "Macro", label: "Run Macro Until End of File", run: () => playMacro("eof") },
  { id: "macro.save", category: "Macro", label: "Save Current Macro…", run: saveMacro },
  { id: "macro.runSaved", category: "Macro", label: "Run Saved Macro…", run: runSavedMacro },
  { id: "macro.deleteSaved", category: "Macro", label: "Delete Saved Macro…", run: deleteSavedMacro },

  // Document
  { interactive: true, id: "doc.language", category: "Document", label: "Change Language Mode…", run: pickLanguage },
  { interactive: true, id: "doc.encoding", category: "Document", label: "Change Encoding…", run: pickEncodingAction },
  { interactive: true, id: "doc.reopenEncoding", category: "Document", label: "Reopen with Encoding…", run: () => pickEncoding("reopen") },
  { interactive: true, id: "doc.saveEncoding", category: "Document", label: "Save with Encoding…", run: () => pickEncoding("save") },
  { interactive: true, id: "doc.eol", category: "Document", label: "Change End of Line…", run: pickEol },
  { id: "doc.eolLf", category: "Document", label: "Convert to LF", run: withActive((id) => setEol(id, "LF")) },
  { id: "doc.eolCrlf", category: "Document", label: "Convert to CRLF", run: withActive((id) => setEol(id, "CRLF")) },

  // View
  { interactive: true, id: "view.palette", category: "View", label: "Command Palette", keys: "Mod+Shift+P", run: openPalette },
  { interactive: true, id: "view.theme", category: "View", label: "Color Theme…", run: pickTheme },
  { id: "view.wordWrap", category: "View", label: "Toggle Word Wrap", keys: "Alt+Z", run: () => settings().update({ wordWrap: !settings().wordWrap }) },
  { id: "view.minimap", category: "View", label: "Toggle Minimap", run: () => settings().update({ minimap: !settings().minimap }) },
  {
    id: "view.smartHighlight",
    category: "View",
    label: "Toggle Smart Highlighting",
    run: () => settings().update({ smartHighlight: !settings().smartHighlight }),
  },
  {
    id: "view.smartHighlightCase",
    category: "View",
    label: "Smart Highlighting: Toggle Match Case",
    run: () => settings().update({ smartHighlightMatchCase: !settings().smartHighlightMatchCase }),
  },
  {
    id: "view.smartHighlightWord",
    category: "View",
    label: "Smart Highlighting: Toggle Whole Word",
    run: () => settings().update({ smartHighlightWholeWord: !settings().smartHighlightWholeWord }),
  },
  { id: "view.whitespace", category: "View", label: "Toggle Show Whitespace", run: () => settings().update({ renderWhitespace: !settings().renderWhitespace }) },
  { id: "view.zoomIn", category: "View", label: "Zoom In", keys: "Mod+=", run: () => zoom(1) },
  { id: "view.zoomOut", category: "View", label: "Zoom Out", keys: "Mod+-", run: () => zoom(-1) },
  { id: "view.zoomReset", category: "View", label: "Reset Zoom", keys: "Mod+0", run: () => zoom(0) },
]);
