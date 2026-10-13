mod bigfile;
mod file_io;
mod fsops;
mod hexdoc;
mod runner;
mod search;
mod session;
mod terminal;

use file_io::{OpenedFile, SaveRequest};
use search::{ReplaceSummary, SearchRequest};
use bigfile::BigFile;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// Id of the search allowed to keep running; any other value cancels it.
static ACTIVE_SEARCH: AtomicU64 = AtomicU64::new(0);

/// Starts a background search. Results stream as `search-result` events, then one `search-done`.
/// The caller picks `id` so it can match events that arrive before this call returns.
#[tauri::command]
fn search_start(app: AppHandle, req: SearchRequest, id: u64) -> Result<(), String> {
    let matcher = search::build_matcher(&req)?;
    ACTIVE_SEARCH.store(id, Ordering::SeqCst);
    std::thread::spawn(move || {
        let cancelled = || ACTIVE_SEARCH.load(Ordering::Relaxed) != id;
        let emit = |batch: search::FileMatches| {
            let _ = app.emit("search-result", batch);
        };
        match search::run(&req, &matcher, id, &cancelled, &emit) {
            Ok(done) => {
                let _ = app.emit("search-done", done);
            }
            Err(e) => {
                let _ = app.emit("search-error", (id, e));
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn search_cancel() {
    ACTIVE_SEARCH.store(0, Ordering::SeqCst);
}

#[tauri::command]
async fn replace_in_files(req: SearchRequest, replacement: String, paths: Vec<String>) -> Result<ReplaceSummary, String> {
    tauri::async_runtime::spawn_blocking(move || search::replace_in_files(&req, &replacement, &paths))
        .await
        .map_err(|e| e.to_string())?
}

// ---- Running scripts

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunOutput {
    id: u64,
    stream: runner::Stream,
    text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunExit {
    id: u64,
    #[serde(flatten)]
    exit: runner::Exit,
}

#[tauri::command]
async fn run_detect_interpreters(dir: Option<String>) -> Result<Vec<runner::Interpreter>, String> {
    tauri::async_runtime::spawn_blocking(move || runner::detect_interpreters(dir.as_deref().map(Path::new)))
        .await
        .map_err(|e| e.to_string())
}

/// Start `program args` in `cwd`. Output streams as `run-output`, then one `run-exit`.
#[tauri::command]
fn run_start(
    app: AppHandle,
    runs: State<'_, runner::Runs>,
    id: u64,
    program: String,
    args: Vec<String>,
    cwd: String,
    env: Vec<(String, String)>,
) -> Result<u32, String> {
    let out_app = app.clone();
    let exit_app = app.clone();
    runs.start(
        id,
        &runner::Spec { program: &program, args: &args, cwd: Path::new(&cwd), env: &env },
        move |stream, text| {
            let _ = out_app.emit("run-output", RunOutput { id, stream, text });
        },
        move |exit| {
            exit_app.state::<runner::Runs>().finished(id);
            let _ = exit_app.emit("run-exit", RunExit { id, exit });
        },
    )
}

#[tauri::command]
fn run_stdin(runs: State<'_, runner::Runs>, id: u64, data: String) -> Result<(), String> {
    runs.write_stdin(id, &data)
}

#[tauri::command]
fn run_eof(runs: State<'_, runner::Runs>, id: u64) {
    runs.close_stdin(id);
}

#[tauri::command]
fn run_kill(runs: State<'_, runner::Runs>, id: u64) -> Result<(), String> {
    runs.kill(id)
}

fn run_cache(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("run");
    // Compilers write straight into these (rustc -o rs/x.exe), so they must exist up front.
    for sub in ["scripts", "rs", "cs"] {
        std::fs::create_dir_all(dir.join(sub)).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

/// Scratch directory for temp scripts, generated projects and compiled binaries.
#[tauri::command]
fn run_cache_dir(app: AppHandle) -> Result<String, String> {
    Ok(run_cache(&app)?.to_string_lossy().into_owned())
}

/// Write `content` to `rel` (a relative path like `cs/Hello/Program.cs`) under the run cache.
#[tauri::command]
fn write_run_file(app: AppHandle, rel: String, content: String) -> Result<String, String> {
    let clean = |part: &str| -> String {
        part.chars().map(|c| if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' }).collect()
    };
    let parts: Vec<String> = rel.split(['/', '\\']).filter(|p| !p.is_empty() && *p != "." && *p != "..").map(clean).collect();
    if parts.is_empty() {
        return Err("empty file name".into());
    }
    let mut path = run_cache(&app)?;
    for p in &parts {
        path.push(p);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Locate a runtime / build tool (node, deno, bun, tsx, go, java, dotnet, cargo, rustc).
#[tauri::command]
async fn run_detect_runtime(kind: String, dir: Option<String>) -> Result<Option<runner::Interpreter>, String> {
    tauri::async_runtime::spawn_blocking(move || runner::detect_runtime(&kind, dir.as_deref().map(Path::new)))
        .await
        .map_err(|e| e.to_string())
}

/// Pipe `input` through `program args` (formatters); returns exit code, stdout and stderr.
#[tauri::command]
async fn format_pipe(
    program: String,
    args: Vec<String>,
    cwd: String,
    input: Option<String>,
    timeout_ms: u64,
) -> Result<runner::Piped, String> {
    tauri::async_runtime::spawn_blocking(move || {
        runner::pipe(&program, &args, Path::new(&cwd), input.as_deref(), std::time::Duration::from_millis(timeout_ms))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// First line of `program args` output if it succeeds (e.g. `python -m black --version`).
#[tauri::command]
async fn run_probe(program: String, args: Vec<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        runner::probe_line(&program, &args)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Nearest project file (e.g. `go.mod`, `Cargo.toml`, `*.csproj`) at or above `dir`.
#[tauri::command]
fn run_find_up(dir: String, names: Vec<String>) -> Option<String> {
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    runner::find_up(Path::new(&dir), &names).map(|p| p.to_string_lossy().into_owned())
}

// ---- Integrated terminal

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TermOutput {
    id: u64,
    data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TermExit {
    id: u64,
    code: u32,
}

/// Start a shell (`shell`, or the user's default) in a PTY. Output streams as `term-output`,
/// then one `term-exit`. Returns the shell's path.
#[tauri::command]
fn term_spawn(
    app: AppHandle,
    terms: State<'_, terminal::Terminals>,
    id: u64,
    shell: Option<String>,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let shell = shell.filter(|s| !s.trim().is_empty()).unwrap_or_else(terminal::default_shell);
    let out_app = app.clone();
    terms.spawn(
        id,
        &shell,
        Path::new(&cwd),
        cols,
        rows,
        move |data| {
            let _ = out_app.emit("term-output", TermOutput { id, data });
        },
        move |code| {
            app.state::<terminal::Terminals>().forget(id);
            let _ = app.emit("term-exit", TermExit { id, code });
        },
    )?;
    Ok(shell)
}

#[tauri::command]
fn term_write(terms: State<'_, terminal::Terminals>, id: u64, data: String) -> Result<(), String> {
    terms.write(id, &data)
}

#[tauri::command]
fn term_resize(terms: State<'_, terminal::Terminals>, id: u64, cols: u16, rows: u16) -> Result<(), String> {
    terms.resize(id, cols, rows)
}

#[tauri::command]
fn term_kill(terms: State<'_, terminal::Terminals>, id: u64) {
    terms.kill(id);
}

/// A local image as a `data:` URL, for the Markdown preview (the webview can't load file paths).
#[tauri::command]
async fn read_image_data_url(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || file_io::image_data_url(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

// ---- Hex editor

#[derive(Default)]
struct HexDocs {
    next: AtomicU64,
    open: Mutex<HashMap<u64, Arc<Mutex<hexdoc::HexDoc>>>>,
}

impl HexDocs {
    fn get(&self, id: u64) -> Result<Arc<Mutex<hexdoc::HexDoc>>, String> {
        self.open.lock().unwrap().get(&id).cloned().ok_or_else(|| "document is no longer open".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HexOpened {
    id: u64,
    len: u64,
}

/// Open `path` (or a new empty document) for hex editing.
#[tauri::command]
async fn hex_open(state: State<'_, HexDocs>, path: Option<String>) -> Result<HexOpened, String> {
    let doc = tauri::async_runtime::spawn_blocking(move || hexdoc::HexDoc::open(path.as_deref().map(Path::new)))
        .await
        .map_err(|e| e.to_string())??;
    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    let len = doc.len();
    state.open.lock().unwrap().insert(id, Arc::new(Mutex::new(doc)));
    Ok(HexOpened { id, len })
}

/// Raw bytes (an ArrayBuffer on the JS side).
#[tauri::command]
async fn hex_read(state: State<'_, HexDocs>, id: u64, offset: u64, len: u64) -> Result<tauri::ipc::Response, String> {
    let doc = state.get(id)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || doc.lock().unwrap().read(offset, len.min(16 << 20)))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HexReplaced {
    /// None when more than `keep_limit` bytes went (too big to send back for undo).
    removed: Option<Vec<u8>>,
    len: u64,
}

/// Replace `del` bytes at `offset` with `bytes`; returns what was removed and the new length.
#[tauri::command]
async fn hex_replace(
    state: State<'_, HexDocs>,
    id: u64,
    offset: u64,
    del: u64,
    bytes: Vec<u8>,
    keep_limit: u64,
) -> Result<HexReplaced, String> {
    let doc = state.get(id)?;
    // Off the main thread: a running find / checksum holds the lock for a while.
    tauri::async_runtime::spawn_blocking(move || {
        let mut doc = doc.lock().unwrap();
        let removed = doc.replace(offset, del, &bytes, keep_limit)?;
        Ok(HexReplaced { removed, len: doc.len() })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn hex_save(state: State<'_, HexDocs>, id: u64, path: String) -> Result<(), String> {
    let doc = state.get(id)?;
    tauri::async_runtime::spawn_blocking(move || doc.lock().unwrap().save(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn hex_find(
    state: State<'_, HexDocs>,
    id: u64,
    pattern: Vec<u8>,
    from: u64,
    backwards: bool,
    ignore_case: bool,
) -> Result<Option<u64>, String> {
    let doc = state.get(id)?;
    tauri::async_runtime::spawn_blocking(move || doc.lock().unwrap().find(&pattern, from, backwards, ignore_case))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn hex_checksums(state: State<'_, HexDocs>, id: u64, offset: u64, len: u64) -> Result<Vec<hexdoc::Checksum>, String> {
    let doc = state.get(id)?;
    tauri::async_runtime::spawn_blocking(move || doc.lock().unwrap().checksums(offset, len))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn hex_close(state: State<'_, HexDocs>, id: u64) {
    state.open.lock().unwrap().remove(&id);
}

// ---- Folders (sidebar, Goto Anything)

#[tauri::command]
async fn fs_list_dir(path: String) -> Result<Vec<fsops::Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || fsops::list_dir(Path::new(&path))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fs_list_files(roots: Vec<String>, limit: usize) -> Result<fsops::FileList, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let roots: Vec<std::path::PathBuf> = roots.iter().map(std::path::PathBuf::from).collect();
        fsops::list_files(&roots, limit)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Some(true) for a folder, Some(false) for a file, None if missing.
#[tauri::command]
fn fs_stat(path: String) -> Option<bool> {
    std::fs::metadata(&path).ok().map(|m| m.is_dir())
}

/// (size, modified ms since epoch) of a file, None if missing. Monitoring (tail -f) polls this.
#[tauri::command]
fn file_sig(path: String) -> Option<(u64, u64)> {
    let m = std::fs::metadata(&path).ok()?;
    let modified = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Some((m.len(), modified))
}

#[tauri::command]
fn fs_create_file(path: String) -> Result<(), String> {
    fsops::create_file(Path::new(&path))
}

#[tauri::command]
fn fs_create_dir(path: String) -> Result<(), String> {
    fsops::create_dir(Path::new(&path))
}

#[tauri::command]
fn fs_rename(from: String, to: String) -> Result<(), String> {
    fsops::rename(Path::new(&from), Path::new(&to))
}

#[tauri::command]
async fn fs_copy(from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || fsops::copy(Path::new(&from), Path::new(&to))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fs_trash(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || fsops::trash(Path::new(&path))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn fs_reveal(path: String) -> Result<(), String> {
    fsops::reveal(Path::new(&path))
}

// ---- Big files

#[derive(Default)]
struct BigFiles {
    next: AtomicU64,
    open: Mutex<HashMap<u64, Arc<BigFile>>>,
}

impl BigFiles {
    fn get(&self, id: u64) -> Result<Arc<BigFile>, String> {
        self.open.lock().unwrap().get(&id).cloned().ok_or_else(|| "file is no longer open".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BigOpened {
    id: u64,
    path: String,
    name: String,
    encoding: String,
    has_bom: bool,
    status: bigfile::IndexStatus,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct IndexEvent {
    id: u64,
    #[serde(flatten)]
    status: bigfile::IndexStatus,
}

fn spawn_indexer(app: AppHandle, id: u64, bf: Arc<BigFile>) {
    std::thread::spawn(move || {
        let emit = |status| {
            let _ = app.emit("bigfile-index", IndexEvent { id, status });
        };
        if let Err(e) = bf.index_to_end(&emit) {
            let _ = app.emit("bigfile-error", (id, e));
        }
    });
}

/// Size in bytes, whether the file must use big-file mode, and whether it looks binary.
#[tauri::command]
fn probe_file(path: String) -> Result<(u64, bool, bool), String> {
    let len = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?.len();
    Ok((len, len > file_io::MAX_EDITOR_FILE_SIZE, file_io::file_looks_binary(Path::new(&path))))
}

#[tauri::command]
async fn bigfile_open(app: AppHandle, state: State<'_, BigFiles>, path: String) -> Result<BigOpened, String> {
    let p = path.clone();
    let bf = Arc::new(tauri::async_runtime::spawn_blocking(move || BigFile::open(Path::new(&p))).await.map_err(|e| e.to_string())??);
    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    state.open.lock().unwrap().insert(id, bf.clone());
    let opened = BigOpened {
        id,
        name: Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone()),
        path,
        encoding: bf.encoding.name().to_owned(),
        has_bom: bf.bom_len > 0,
        status: bf.status(),
    };
    spawn_indexer(app, id, bf);
    Ok(opened)
}

#[tauri::command]
async fn bigfile_lines(state: State<'_, BigFiles>, id: u64, start: u64, count: u64) -> Result<bigfile::LinePage, String> {
    let bf = state.get(id)?;
    tauri::async_runtime::spawn_blocking(move || bf.lines(start, count.min(5000)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn bigfile_find(
    state: State<'_, BigFiles>,
    id: u64,
    req: SearchRequest,
    from_line: u64,
    from_col: u32,
    backwards: bool,
) -> Result<Option<bigfile::Found>, String> {
    let bf = state.get(id)?;
    tauri::async_runtime::spawn_blocking(move || bf.find(&req, from_line, from_col, backwards))
        .await
        .map_err(|e| e.to_string())?
}

/// Pick up growth (follow mode) or truncation; returns (was_reset, status).
#[tauri::command]
fn bigfile_refresh(app: AppHandle, state: State<'_, BigFiles>, id: u64) -> Result<(bool, bigfile::IndexStatus), String> {
    let bf = state.get(id)?;
    let reset = bf.refresh()?;
    let status = bf.status();
    if !status.complete {
        spawn_indexer(app, id, bf);
    }
    Ok((reset, status))
}

#[tauri::command]
fn bigfile_close(state: State<'_, BigFiles>, id: u64) {
    if let Some(bf) = state.open.lock().unwrap().remove(&id) {
        bf.closed.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
async fn open_file(path: String, encoding: Option<String>) -> Result<OpenedFile, String> {
    tauri::async_runtime::spawn_blocking(move || file_io::open(&path, encoding.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_file(req: SaveRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || file_io::save(&req))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn read_app_file(app: AppHandle, name: String) -> Result<Option<String>, String> {
    session::read(&app, &name)
}

#[tauri::command]
fn write_app_file(app: AppHandle, name: String, content: String) -> Result<(), String> {
    session::write(&app, &name, &content)
}

/// Launch flag for an extra window (Notepad++ "-multiInst"): it skips the single-instance
/// hand-off and runs without a session.
const NEW_INSTANCE_FLAG: &str = "--new-instance";

fn is_secondary() -> bool {
    std::env::args().skip(1).any(|a| a == NEW_INSTANCE_FLAG)
}

/// True in a window started with `--new-instance` (no session, no projects).
#[tauri::command]
fn instance_secondary() -> bool {
    is_secondary()
}

/// Start another NotchPad window, opening `paths` in it.
#[tauri::command]
fn spawn_instance(paths: Vec<String>) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    std::process::Command::new(exe)
        .arg(NEW_INSTANCE_FLAG)
        .args(paths)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Can't start a new instance: {e}"))
}

/// Files passed on the command line ("Open with", drag onto exe).
#[tauri::command]
fn startup_files() -> Vec<String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    file_args(std::env::args().skip(1), &cwd)
}

fn file_args(args: impl Iterator<Item = String>, cwd: &Path) -> Vec<String> {
    args.filter(|a| !a.starts_with('-'))
        .filter_map(|a| std::fs::canonicalize(cwd.join(a)).ok())
        .filter(|p| p.is_file() || p.is_dir())
        .map(clean_path)
        .collect()
}

fn clean_path(p: std::path::PathBuf) -> String {
    let s = p.to_string_lossy().into_owned();
    // canonicalize on Windows yields \\?\C:\... or \\?\UNC\server\share\..., which is noisy in the UI.
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    s.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(s)
}

#[cfg(test)]
mod clean_path_tests {
    use super::clean_path;
    use std::path::PathBuf;

    #[test]
    fn strips_verbatim_prefixes() {
        assert_eq!(clean_path(PathBuf::from(r"\\?\C:\a\b.txt")), r"C:\a\b.txt");
        assert_eq!(clean_path(PathBuf::from(r"\\?\UNC\10.0.0.1\share\x.log")), r"\\10.0.0.1\share\x.log");
        assert_eq!(clean_path(PathBuf::from(r"\\server\share\x.log")), r"\\server\share\x.log");
    }
}

/// The app was called "Text Editor" (id `com.simple.texteditor`) before 0.2.0. Copy its settings,
/// session and projects over once, so renaming doesn't lose open tabs or unsaved buffers.
fn migrate_old_app_data(app: &AppHandle) {
    let Ok(new_dir) = app.path().app_data_dir() else { return };
    let Some(old_dir) = new_dir.parent().map(|p| p.join("com.simple.texteditor")) else { return };
    if new_dir.exists() || !old_dir.is_dir() {
        return;
    }
    if let Err(e) = copy_dir(&old_dir, &new_dir) {
        eprintln!("migrating {} failed: {e}", old_dir.display());
    }
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // The default macOS menu binds Cmd+W to "Close Window"; keep only what the webview
    // needs (clipboard) and let the frontend own every other shortcut.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|app| {
        use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
        let app_menu = Submenu::with_items(
            app,
            "NotchPad",
            true,
            &[
                &PredefinedMenuItem::about(app, None, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        let edit_menu = Submenu::with_items(
            app,
            "Edit",
            true,
            &[
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
            ],
        )?;
        Menu::with_items(app, &[&app_menu, &edit_menu])
    });
    // Must be the first plugin: a second launch hands its files to the running window and exits.
    // Windows started with --new-instance stay independent.
    let builder = if is_secondary() {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let files = file_args(argv.into_iter().skip(1), Path::new(&cwd));
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
        }))
    };
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            migrate_old_app_data(app.handle());
            // Extra instances open where the mouse is (e.g. where a tab was dropped), not exactly
            // on top of the main window.
            if is_secondary() {
                if let (Some(win), Ok(pos)) = (app.get_webview_window("main"), app.cursor_position()) {
                    let _ = win.set_position(tauri::PhysicalPosition::new((pos.x - 120.0) as i32, (pos.y - 16.0).max(0.0) as i32));
                }
            }
            Ok(())
        })
        .manage(BigFiles::default())
        .manage(runner::Runs::default())
        .manage(terminal::Terminals::default())
        .manage(HexDocs::default())
        .invoke_handler(tauri::generate_handler![
            open_file,
            save_file,
            read_app_file,
            write_app_file,
            startup_files,
            instance_secondary,
            spawn_instance,
            search_start,
            search_cancel,
            replace_in_files,
            probe_file,
            bigfile_open,
            bigfile_lines,
            bigfile_find,
            bigfile_refresh,
            bigfile_close,
            run_detect_interpreters,
            run_start,
            run_stdin,
            run_eof,
            run_kill,
            run_cache_dir,
            write_run_file,
            run_detect_runtime,
            run_find_up,
            format_pipe,
            run_probe,
            term_spawn,
            term_write,
            term_resize,
            term_kill,
            read_image_data_url,
            hex_open,
            hex_read,
            hex_replace,
            hex_save,
            hex_find,
            hex_checksums,
            hex_close,
            fs_list_dir,
            fs_list_files,
            fs_stat,
            file_sig,
            fs_create_file,
            fs_create_dir,
            fs_rename,
            fs_copy,
            fs_trash,
            fs_reveal
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Don't leave scripts running after the editor quits.
            if let tauri::RunEvent::Exit = event {
                app.state::<runner::Runs>().kill_all();
                app.state::<terminal::Terminals>().kill_all();
            }
        });
}
