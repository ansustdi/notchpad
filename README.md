# Text Editor

Cross-platform (Windows / macOS / Linux) text editor built with Tauri 2, React and Monaco.

## Features (MVP)

- Tabs: drag to reorder, middle-click close, right-click menu, `Ctrl+Tab` cycling, reopen closed tab
- Session restore: unsaved and untitled tabs survive restarts (no "save?" prompt on exit)
- Encoding detection (UTF-8/16 with or without BOM, legacy code pages) and round-trip on save
- Reopen / save with a specific encoding, LF / CRLF conversion
- Atomic saves (temp file + rename)
- Syntax highlighting for ~80 languages, multi-cursor, minimap, sticky scroll, bracket guides
- Command palette (`Ctrl/Cmd+Shift+P`), text tools (sort, dedupe, case, trim)
- Smart highlighting (Notepad++ style): select or double-click text and every occurrence turns green, with marks in the scrollbar and the match count in the status bar; whole-word for word selections, case-insensitive by default (View menu toggles)
- Light / dark / follow-system theme, zoom, word wrap, show whitespace
- Drag and drop files, open from command line / "Open with" (single instance: new files open as tabs in the running window)
- Folders like Sublime: File → Open Folder / Add Folder to Sidebar (or drop a folder on the window, or pass it on the command line). Side bar tree (`Ctrl/Cmd+B`) with lazy loading and natural sort; `.git` and other VCS folders hidden. Right-click: New File (sub/folders allowed), New Folder, Rename (`F2`), Delete (to Recycle Bin, `Delete`), Find in Folder, Copy Path, Open in File Manager. Open tabs follow renames. View → Reveal in Side Bar. Refreshes when the window regains focus
- Goto Anything (`Ctrl/Cmd+P`): fuzzy file finder across the open folders (respects `.gitignore`); without folders it switches between open tabs
- Preview tabs (Sublime): a single click in the side bar opens a temporary tab (italic title) that the next single click replaces. Double-click the file or the tab, edit, save or pin it to keep it. View → Preview Tabs turns this off
- Drag and drop in the side bar: drag a file or folder onto a folder (or onto a file, meaning its folder) to move it, with a confirmation that can be turned off. Hold `Ctrl` to copy instead. Hovering over a closed folder opens it, and the tree scrolls at its edges. Dropping a file on an editor opens it there. Nothing is ever overwritten, and open tabs follow moved files
- Projects (Project menu): Save Project As… writes a Sublime-compatible `.sublime-project` file (folder paths relative to it). Each project keeps its own session (tabs, unsaved buffers, layout, side bar). Quick Switch Project is `Ctrl/Cmd+Alt+P`; Close Project returns to the default session. Opening a `.sublime-project` file (command line, drag and drop, Open with) opens the project. Adding or removing side bar folders updates the project file

## Search (phase 2)

- Find in Files (`Ctrl/Cmd+Shift+F`) with the ripgrep engine: parallel, respects `.gitignore`, skips binary files, include/exclude globs
- Scopes: folder, all open documents, current document (Notepad++ "Find All")
- Results panel: grouped per file, virtualized (tens of thousands of rows), click to jump, `F4` / `Shift+F4` to step through
- Replace All in files (`Ctrl/Cmd+Shift+H`) keeps each file's encoding, BOM and line endings; files with unsaved edits are skipped; in open documents it is one undo step
- Match case / whole word / regex (`Alt+C` / `Alt+W` / `Alt+R`). Folder search uses Rust regex syntax, open documents use JavaScript syntax
- Search, replace and folder history
- Bookmarks: `Ctrl+F2` toggle, `F2` / `Shift+F2` next/previous, click the gutter, "Bookmark lines" from results, copy / remove bookmarked lines; saved with the session

## Big files (phase 3)

- Files over 50 MB open in a read-only big-file viewer; the viewer appears immediately and indexes in the background
- Release build on a 1.1 GB / 15M-line log: index 0.4 s, page of lines 2 ms, full-file search 0.4 s
- Memory stays flat: only a line checkpoint every 1024 lines is kept, lines are read on demand
- Find next / previous with wrap (`Enter` / `Shift+Enter`, `F3` / `Shift+F3`), match case / word / regex
- `Ctrl/Cmd+G` go to line, `Ctrl+Home` / `Ctrl+End`, custom scrollbar with match marker
- Follow mode (tail -f): picks up appended lines every second; truncation / log rotation re-indexes
- Find in Files searches big files too and jumps into the viewer; big tabs are restored with the session
- Lines longer than 16 KB are cut for display. UTF-16 big files are not supported yet

## Split view (phase 4)

- Up to 4 editor groups, side by side or stacked (View → Toggle Split Layout); drag splitters to resize, double-click to even out
- `Ctrl/Cmd+\` splits the current document into a new group; `Ctrl/Cmd+1..4` focuses a group
- The same document can be open in two groups (clone): one shared buffer, edits and bookmarks appear in both; closing one view never prompts
- Move / clone a tab to the other group from the tab menu or View menu, or drag it onto another group's tab bar (hold Ctrl or Alt to clone)
- Pinned tabs stay on the left and survive Close Others / Close to the Right / Close All
- Dropping files from the OS opens them in the group under the cursor
- Groups, sizes, orientation and pinned tabs are restored with the session

## Tools (phase 5)

- **JSON**: format (uses the document's indent), minify, sort keys, validate. Numbers and strings are kept byte-exact (`12345678901234567890` is not rounded); errors jump to the exact line and column
- **XML**: format, minify, well-formedness check (mismatched / unclosed tags, multiple roots). Attributes, comments, CDATA and DOCTYPE are left untouched
- Tools act on the selection(s), or the whole document when nothing is selected, as one undo step
- **Compare**: with another open document, with the saved file on disk, or with the clipboard. Side by side or inline, `F7` / `Shift+F7` between changes, ignore whitespace, swap; the right side stays editable
- **Macros** (Notepad++ style): `Ctrl/Cmd+Shift+R` start/stop recording, `Ctrl/Cmd+Shift+E` play, run N times, run until end of file, save / run / delete named macros. Typing, navigation, common editing keys, paste and app commands are recorded; mouse clicks are not; undo steps back through a macro edit by edit
- **Text**: Base64 encode/decode (UTF-8), URL encode/decode, copy SHA-256 of the selection

## Format code

`Shift+Alt+F` (Edit → Format Document) formats with the language's standard formatter, using the project's own config (`pyproject.toml`, `.clang-format`, `rustfmt.toml`, `.editorconfig`, `.prettierrc`). Edit → Toggle Format on Save formats before every save.

| Language | Formatter (first one found) |
| --- | --- |
| Python | ruff, black, autopep8 — the project venv's copy first (`python -m …`), then PATH |
| C / C++ | clang-format (also found in `Program Files\LLVM`, Visual Studio's LLVM, Homebrew LLVM, versioned `/usr/bin/clang-format-NN`); LLVM style without a `.clang-format` |
| Java | google-java-format, else clang-format (Google style) |
| C# | `dotnet format` (from the .NET SDK, honours `.editorconfig`), else clang-format; takes a few seconds |
| Go | gofmt |
| Rust | rustfmt, with the edition from Cargo.toml |
| JavaScript / TypeScript / CSS / HTML | prettier (project-local or global), else the built-in formatter |
| JSON / XML | built-in |
| SQL | built-in, Toad style: keywords upper case, `SELECT` / `FROM` / `WHERE` right-aligned, one column per line; PL/SQL blocks (`DECLARE` / `BEGIN` / `CREATE PROCEDURE`…) indented with the SQL inside laid out the same way. Edit → SQL Format Options: dialect (Oracle, SQL Server, PostgreSQL, MySQL…), layout (Toad, standard, tabular), keyword case |

With text selected, JSON / XML / SQL formatting applies to the selection only. The SQL formatter refuses to apply a result whose tokens differ from the original (only spacing and keyword case may change).

- The result is applied as one undoable edit that only touches what changed, so the cursor and scroll stay put
- On a syntax error the formatter's message is shown and the document is left untouched (empty output is never applied)
- Edit → Set Formatter for This Language: any stdin → stdout command, e.g. `goimports` or `prettier --stdin-filepath {file}`

## Run code

`F5` runs the current file, `Ctrl/Cmd+F5` runs it again, `Shift+F5` stops; also the ▶ Run button in the status bar and the Run menu.

| Language | How it runs |
| --- | --- |
| Python | nearest `.venv` / `venv` / `env`, else `py -3` / `python` / `python3` (pick one: Run → Select Python Interpreter) |
| JavaScript | `node file.js` (Bun or Deno if Node is missing) |
| TypeScript | project-local or global `tsx`, else Deno, Bun, or Node 22.6+ type stripping (`.tsx` needs tsx / Deno / Bun) |
| Go | `go run .` inside a module (whole package), else `go run file.go` |
| Java | `java File.java` single-file launch; needs Java 11+ (prefers `JAVA_HOME`, then the JDK owning `javac`, over an old Java on PATH) |
| C# | `dotnet run --project` for a `.csproj`; `dotnet run file.cs` on .NET 10+; on older SDKs a throwaway project is generated |
| Rust | `cargo run -q` in a Cargo project (`--bin` / `--example` from the file's location); a lone file is compiled with `rustc`, then run |

- Run → Set Run Command for This Language overrides the automatic choice, e.g. `node --inspect {file}` (`{file}`, `{dir}`, `{name}`, `{ext}`); Run → Re-detect Runtimes after installing a tool
- Compiler errors and stack traces from every language are clickable (Python, Go, Rust, Node/TypeScript, Java, C# / MSBuild), including relative paths and errors in generated copies
- Modified files are saved first; unsaved buffers run from a temp copy (traceback links still open the buffer)
- Output panel streams stdout / stderr live, with an input box for `input()` and an EOF button; long output is capped at 2M characters
- Stop kills the whole process tree (child processes too); closing the editor stops running programs
- Programs run in the file's folder; Python gets `PYTHONUNBUFFERED=1` and `PYTHONIOENCODING=utf-8` (the Windows Store `python.exe` stub is skipped)

## Development

Prerequisites: Node 22+, Rust stable, and on Linux `libwebkit2gtk-4.1-dev librsvg2-dev`.

```sh
npm install
npm run tauri dev      # run with hot reload
npm run tauri build    # installer for the current OS
npm test                # frontend unit tests (vitest)
cd src-tauri && cargo test
```

Installers are built per OS; `.github/workflows/release.yml` builds all three on a `v*` tag.

## Layout

- `src-tauri/src/file_io.rs` — open/save, encoding + EOL detection
- `src-tauri/src/session.rs` — app-data files (session, settings)
- `src/store/tabs.ts` — tabs and their Monaco models
- `src/session.ts` — session snapshot / restore
- `src-tauri/src/search.rs` — find / replace in files
- `src/store/search.ts`, `src/components/SearchPanel.tsx` — search state and results panel
- `src/bookmarks.ts` — bookmarks
- `src-tauri/src/bigfile.rs`, `src/components/BigFileView.tsx`, `src/store/bigview.ts` — big-file viewer
- `src/components/EditorGroups.tsx` — split layout and splitters
- `src/tools/` — JSON / XML / text tools; `src/components/DiffView.tsx` — compare
- `src/macro/` — macro recorder and player
- `src-tauri/src/runner.rs`, `src/store/run.ts`, `src/components/OutputPanel.tsx` — running scripts
- `src/commands/` — commands, keybindings, pickers

## Roadmap

1. ~~Find in files, results panel, bookmarks~~ (done)
2. ~~Big-file mode, tail/follow~~ (done)
3. ~~Split view and tab groups~~ (done)
4. ~~Tools: JSON/XML format, diff, macros~~ (done)
