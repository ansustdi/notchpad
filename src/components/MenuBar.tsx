import { useEffect, useRef, useState } from "react";
import { formatKeys, getCommand, runCommand } from "../commands/registry";

/** A command id, a separator, or a submenu. */
type Entry = string | "-" | { label: string; items: Entry[] };

const MENUS: { label: string; items: Entry[] }[] = [
  {
    label: "File",
    items: [
      "file.new", "file.newInstance", "file.open", "file.openFolder", "file.addFolder", "file.reopenClosed", "-",
      { label: "Project", items: ["project.open", "project.switch", "project.saveAs", "project.close", "-", "project.edit"] }, "-",
      "file.save", "file.saveAs", "file.saveAll", "file.reload", "-",
      "file.close", "file.closeOthers", "file.closeToRight", "file.closeAll", "-",
      "file.exit",
    ],
  },
  {
    label: "Edit",
    items: [
      "edit.undo", "edit.redo", "-",
      "edit.toggleComment", "edit.duplicateLine", "edit.selectAllMatches", "-",
      { label: "Convert Text", items: ["text.upper", "text.lower", "text.title", "-", "text.sortAsc", "text.sortDesc", "text.dedupe", "text.joinLines", "text.trim"] },
      { label: "Encoding & Line Endings", items: ["doc.reopenEncoding", "doc.saveEncoding", "-", "doc.eolLf", "doc.eolCrlf"] },
      "doc.language", "-",
      "edit.format", "edit.formatOnSave",
      { label: "Formatter Settings", items: ["edit.formatConfigure", "edit.sqlFormatOptions"] },
    ],
  },
  {
    label: "Search",
    items: [
      "edit.find", "edit.replace", "edit.gotoLine", "file.gotoAnything", "-",
      "search.findInFiles", "search.replaceInFiles", "search.findInOpen", "search.findInCurrent", "-",
      "search.nextResult", "search.prevResult", "-",
      { label: "Bookmarks", items: ["bookmark.toggle", "bookmark.next", "bookmark.prev", "bookmark.clear", "-", "bookmark.copy", "bookmark.remove", "bookmark.keep"] },
    ],
  },
  {
    label: "View",
    items: [
      "view.palette", "view.sidebar", "view.revealInSidebar", "view.refreshFolders", "-",
      "markdown.preview", "markdown.previewSide", "-",
      "terminal.toggle", "run.toggleOutput", "search.togglePanel", "-",
      { label: "Editor Layout", items: ["group.split", "group.moveToOther", "group.cloneToOther", "group.toggleLayout", "group.close", "-", "tab.moveToNewInstance", "tab.openInNewInstance", "-", "tab.pin", "view.previewTabs"] },
      "-",
      "view.monitor", "-",
      "view.theme", "view.wordWrap", "view.minimap", "view.whitespace",
      { label: "Smart Highlight", items: ["view.smartHighlight", "view.smartHighlightCase", "view.smartHighlightWord"] }, "-",
      "view.zoomIn", "view.zoomOut", "view.zoomReset",
    ],
  },
  {
    label: "Run",
    items: [
      "run.file", "run.again", "run.stop", "-",
      "terminal.new", "terminal.kill", "-",
      "run.interpreter", "run.configure", "run.redetect",
    ],
  },
  {
    label: "Tools",
    items: [
      { label: "JSON", items: ["tools.jsonFormat", "tools.jsonMinify", "tools.jsonSort", "tools.jsonValidate"] },
      { label: "XML", items: ["tools.xmlFormat", "tools.xmlMinify", "tools.xmlValidate"] },
      { label: "Compare", items: ["tools.compareTab", "tools.compareSaved", "tools.compareClipboard"] },
      { label: "Encode / Hash", items: ["text.base64Encode", "text.base64Decode", "text.urlEncode", "text.urlDecode", "text.sha256"] },
      "-",
      { label: "Hex Editor", items: ["hex.openFile", "hex.reopen", "hex.new", "-", "hex.asText", "hex.checksums"] },
      { label: "Macro", items: ["macro.record", "macro.play", "macro.playN", "macro.playEof", "-", "macro.save", "macro.runSaved", "macro.deleteSaved"] },
    ],
  },
];

/** Shortcut hints for actions Monaco itself binds (shown in menus only). */
const MONACO_KEYS: Record<string, string> = {
  "edit.undo": "Mod+Z",
  "edit.redo": "Mod+Shift+Z",
  "edit.find": "Mod+F",
  "edit.replace": "Mod+H",
  "edit.toggleComment": "Mod+/",
  "edit.selectAllMatches": "Mod+Shift+L",
  "markdown.previewSide": "Mod+K V",
};

export function MenuBar() {
  const [open, setOpen] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const onDown = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="menubar" ref={barRef}>
      {MENUS.map((menu, i) => (
        <div key={menu.label} className="menu">
          <button
            className={`menu-title${open === i ? " open" : ""}`}
            onClick={() => setOpen(open === i ? null : i)}
            onPointerEnter={() => open !== null && setOpen(i)}
          >
            {menu.label}
          </button>
          {open === i && <MenuList items={menu.items} close={() => setOpen(null)} />}
        </div>
      ))}
    </div>
  );
}

function MenuList({ items, close, sub }: { items: Entry[]; close: () => void; sub?: boolean }) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  return (
    <div className={`menu-dropdown${sub ? " menu-sub" : ""}`} role="menu">
      {items.map((entry, j) => {
        if (entry === "-") return <div key={j} className="menu-sep" />;
        if (typeof entry !== "string") {
          return (
            <div key={entry.label} className="menu-subwrap" onPointerEnter={() => setOpenSub(j)} onPointerLeave={() => setOpenSub(null)}>
              <button role="menuitem" aria-haspopup="menu" className={`menu-item${openSub === j ? " open" : ""}`} onClick={() => setOpenSub(j)}>
                <span>{entry.label}</span>
                <span className="menu-keys">▸</span>
              </button>
              {openSub === j && <MenuList items={entry.items} close={close} sub />}
            </div>
          );
        }
        const cmd = getCommand(entry);
        if (!cmd) return null;
        return (
          <button
            key={entry}
            role="menuitem"
            className="menu-item"
            onPointerEnter={() => setOpenSub(null)}
            onClick={() => {
              close();
              runCommand(entry);
            }}
          >
            <span>{cmd.label}</span>
            <span className="menu-keys">{formatKeys(cmd.keys ?? MONACO_KEYS[entry])}</span>
          </button>
        );
      })}
    </div>
  );
}
