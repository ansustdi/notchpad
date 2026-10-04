import { useEffect, useRef, useState } from "react";
import { formatKeys, getCommand, runCommand } from "../commands/registry";

type Entry = string | "-";

const MENUS: { label: string; items: Entry[] }[] = [
  {
    label: "File",
    items: ["file.new", "file.open", "file.openFolder", "file.addFolder", "file.gotoAnything", "file.reopenClosed", "-", "file.save", "file.saveAs", "file.saveAll", "-", "file.close", "file.closeOthers", "file.closeToRight", "file.closeAll", "-", "file.exit"],
  },
  {
    label: "Project",
    items: ["project.open", "project.switch", "project.saveAs", "project.close", "-", "file.addFolder", "project.edit"],
  },
  {
    label: "Edit",
    items: [
      "edit.undo", "edit.redo", "-",
      "edit.toggleComment", "edit.duplicateLine", "edit.selectAllMatches", "-",
      "edit.format", "edit.formatOnSave", "edit.formatConfigure", "edit.sqlFormatOptions",
    ],
  },
  {
    label: "Search",
    items: [
      "edit.find", "edit.replace", "edit.gotoLine", "-",
      "search.findInFiles", "search.replaceInFiles", "search.findInOpen", "search.findInCurrent", "-",
      "search.nextResult", "search.prevResult", "-",
      "bookmark.toggle", "bookmark.next", "bookmark.prev", "bookmark.clear", "-",
      "bookmark.copy", "bookmark.remove", "bookmark.keep",
    ],
  },
  {
    label: "Text",
    items: ["text.upper", "text.lower", "text.title", "-", "text.sortAsc", "text.sortDesc", "text.dedupe", "text.joinLines", "text.trim"],
  },
  {
    label: "Tools",
    items: [
      "tools.jsonFormat", "tools.jsonMinify", "tools.jsonSort", "tools.jsonValidate", "-",
      "tools.xmlFormat", "tools.xmlMinify", "tools.xmlValidate", "-",
      "tools.compareTab", "tools.compareSaved", "tools.compareClipboard", "-",
      "text.base64Encode", "text.base64Decode", "text.urlEncode", "text.urlDecode", "text.sha256",
    ],
  },
  {
    label: "Run",
    items: ["run.file", "run.again", "run.stop", "-", "run.interpreter", "run.configure", "run.redetect", "-", "run.toggleOutput"],
  },
  {
    label: "Macro",
    items: ["macro.record", "macro.play", "macro.playN", "macro.playEof", "-", "macro.save", "macro.runSaved", "macro.deleteSaved"],
  },
  {
    label: "Document",
    items: ["doc.language", "-", "doc.reopenEncoding", "doc.saveEncoding", "-", "doc.eolLf", "doc.eolCrlf"],
  },
  {
    label: "View",
    items: ["view.palette", "view.sidebar", "view.previewTabs", "view.revealInSidebar", "view.refreshFolders", "search.togglePanel", "-", "group.split", "group.moveToOther", "group.cloneToOther", "group.toggleLayout", "group.close", "tab.pin", "-", "view.theme", "view.wordWrap", "view.minimap", "view.whitespace", "-", "view.smartHighlight", "view.smartHighlightCase", "view.smartHighlightWord", "-", "view.zoomIn", "view.zoomOut", "view.zoomReset"],
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
          {open === i && (
            <div className="menu-dropdown" role="menu">
              {menu.items.map((id, j) => {
                if (id === "-") return <div key={j} className="menu-sep" />;
                const cmd = getCommand(id);
                if (!cmd) return null;
                return (
                  <button
                    key={id}
                    role="menuitem"
                    className="menu-item"
                    onClick={() => {
                      setOpen(null);
                      runCommand(id);
                    }}
                  >
                    <span>{cmd.label}</span>
                    <span className="menu-keys">{formatKeys(cmd.keys ?? MONACO_KEYS[id])}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
