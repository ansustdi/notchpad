//! Run external programs (Python scripts) with streamed output, stdin and tree kill.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Hide the console window a GUI app would otherwise pop up for console programs.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn no_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Turns a byte stream into UTF-8 text without breaking characters split across reads.
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        let mut start = 0;
        loop {
            match std::str::from_utf8(&self.pending[start..]) {
                Ok(s) => {
                    out.push_str(s);
                    start = self.pending.len();
                    break;
                }
                Err(e) => {
                    let valid = start + e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[start..valid]).unwrap());
                    match e.error_len() {
                        // Truly invalid bytes: show a replacement character and move on.
                        Some(n) => {
                            out.push('\u{FFFD}');
                            start = valid + n;
                        }
                        // Incomplete character at the end: keep it for the next read.
                        None => {
                            start = valid;
                            break;
                        }
                    }
                }
            }
        }
        self.pending.drain(..start);
        out
    }

    /// Whatever is left when the stream ends.
    pub fn finish(&mut self) -> String {
        let s = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        s
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exit {
    /// None when killed by a signal.
    pub code: Option<i32>,
    pub elapsed_ms: u64,
    pub killed: bool,
}

struct Running {
    pid: u32,
    stdin: Option<ChildStdin>,
    killed: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Runs {
    procs: Mutex<HashMap<u64, Running>>,
}

pub struct Spec<'a> {
    pub program: &'a str,
    pub args: &'a [String],
    pub cwd: &'a Path,
    pub env: &'a [(String, String)],
}

impl Runs {
    /// Start a process; `on_output` gets decoded text chunks, `on_exit` fires once, after
    /// all output has been delivered.
    pub fn start(
        &self,
        id: u64,
        spec: &Spec,
        on_output: impl Fn(Stream, String) + Send + Sync + 'static,
        on_exit: impl FnOnce(Exit) + Send + 'static,
    ) -> Result<u32, String> {
        let mut cmd = Command::new(spec.program);
        cmd.args(spec.args)
            .current_dir(spec.cwd)
            .envs(spec.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        no_window(&mut cmd);
        // Own process group so Stop can take down children the script started.
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut cmd, 0);

        let mut child: Child = cmd.spawn().map_err(|e| format!("Couldn't start {}: {e}", spec.program))?;
        let pid = child.id();
        let started = Instant::now();
        let killed = Arc::new(AtomicBool::new(false));
        let on_output = Arc::new(on_output);

        let mut readers = Vec::new();
        for (stream, reader) in [
            (Stream::Stdout, child.stdout.take().map(|r| Box::new(r) as Box<dyn Read + Send>)),
            (Stream::Stderr, child.stderr.take().map(|r| Box::new(r) as Box<dyn Read + Send>)),
        ] {
            let Some(mut reader) = reader else { continue };
            let on_output = on_output.clone();
            readers.push(std::thread::spawn(move || {
                let mut dec = Utf8Stream::default();
                let mut buf = [0u8; 8192];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let text = dec.push(&buf[..n]);
                    if !text.is_empty() {
                        on_output(stream, text);
                    }
                }
                let rest = dec.finish();
                if !rest.is_empty() {
                    on_output(stream, rest);
                }
            }));
        }

        self.procs.lock().unwrap().insert(id, Running { pid, stdin: child.stdin.take(), killed: killed.clone() });

        std::thread::spawn(move || {
            let status = child.wait();
            // Deliver all output before reporting the exit.
            for r in readers {
                let _ = r.join();
            }
            on_exit(Exit {
                code: status.ok().and_then(|s| s.code()),
                elapsed_ms: started.elapsed().as_millis() as u64,
                killed: killed.load(Ordering::SeqCst),
            });
        });
        Ok(pid)
    }

    /// Forget a finished run (called from the exit callback).
    pub fn finished(&self, id: u64) {
        self.procs.lock().unwrap().remove(&id);
    }

    pub fn write_stdin(&self, id: u64, data: &str) -> Result<(), String> {
        let mut procs = self.procs.lock().unwrap();
        let run = procs.get_mut(&id).ok_or("Process has exited")?;
        let stdin = run.stdin.as_mut().ok_or("Input is closed")?;
        stdin.write_all(data.as_bytes()).and_then(|_| stdin.flush()).map_err(|e| e.to_string())
    }

    /// Close stdin (EOF), e.g. to end a script reading until end of input.
    pub fn close_stdin(&self, id: u64) {
        if let Some(run) = self.procs.lock().unwrap().get_mut(&id) {
            run.stdin = None;
        }
    }

    /// Kill the process and everything it started.
    pub fn kill(&self, id: u64) -> Result<(), String> {
        let procs = self.procs.lock().unwrap();
        let run = procs.get(&id).ok_or("Process has exited")?;
        run.killed.store(true, Ordering::SeqCst);
        kill_tree(run.pid)
    }

    pub fn kill_all(&self) {
        for run in self.procs.lock().unwrap().values() {
            let _ = kill_tree(run.pid);
        }
    }
}

#[cfg(windows)]
fn kill_tree(pid: u32) -> Result<(), String> {
    let status = no_window(Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Couldn't stop the process".into())
    }
}

#[cfg(unix)]
fn kill_tree(pid: u32) -> Result<(), String> {
    // Negative pid = the whole process group (the script was started as its leader).
    let rc = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

// ---- Interpreter discovery

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Interpreter {
    pub program: String,
    /// Extra args placed before the script (e.g. `-3` for the Windows `py` launcher).
    pub args: Vec<String>,
    pub version: String,
    /// Where it came from: "venv", "PATH".
    pub source: String,
}

/// Run a short-lived command and return (exited successfully, stdout + stderr).
/// Gives up (and kills it) after `timeout`, so a hung tool can't stall detection.
fn capture(program: &str, args: &[&str], timeout: Duration) -> Option<(bool, String)> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let out = child.wait_with_output().ok()?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    Some((out.status.success(), text))
}

/// Run `program args --version` and return "Python x.y.z" if it's a real interpreter.
/// The Windows Store alias `python.exe` prints an install hint and fails this check.
fn probe(program: &str, args: &[&str]) -> Option<String> {
    let mut all: Vec<&str> = args.to_vec();
    all.push("--version");
    // Python 2 printed its version on stderr, hence both streams.
    let (_, text) = capture(program, &all, Duration::from_secs(5))?;
    let line = text.lines().find(|l| l.starts_with("Python "))?.trim().to_owned();
    line["Python ".len()..].chars().next().filter(char::is_ascii_digit)?;
    Some(line)
}

fn venv_python(dir: &Path) -> Option<PathBuf> {
    for name in [".venv", "venv", "env"] {
        let p = if cfg!(windows) {
            dir.join(name).join("Scripts").join("python.exe")
        } else {
            dir.join(name).join("bin").join("python")
        };
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Candidates for running a script in `start_dir`: nearest virtualenvs first, then PATH.
pub fn detect_interpreters(start_dir: Option<&Path>) -> Vec<Interpreter> {
    let mut found: Vec<Interpreter> = Vec::new();
    let mut push = |program: String, args: &[&str], source: &str| {
        if found.iter().any(|f| f.program == program && f.args.iter().map(String::as_str).eq(args.iter().copied())) {
            return;
        }
        if let Some(version) = probe(&program, args) {
            found.push(Interpreter { program, args: args.iter().map(|s| s.to_string()).collect(), version, source: source.into() });
        }
    };
    let mut dir = start_dir;
    while let Some(d) = dir {
        if let Some(p) = venv_python(d) {
            push(p.to_string_lossy().into_owned(), &[], "venv");
        }
        dir = d.parent();
    }
    if cfg!(windows) {
        push("py".into(), &["-3"], "PATH");
    }
    push("python".into(), &[], "PATH");
    push("python3".into(), &[], "PATH");
    found
}

// ---- Other language runtimes

/// Full path of `program` on PATH (honouring PATHEXT on Windows, so `tsx` finds `tsx.cmd`).
pub fn which(program: &str) -> Option<PathBuf> {
    let p = Path::new(program);
    if p.components().count() > 1 {
        return p.is_file().then(|| p.to_owned());
    }
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| e.to_ascii_lowercase())
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&std::env::var_os("PATH")?) {
        for ext in &exts {
            let candidate = dir.join(format!("{program}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Nearest `name` in `start` or its parents. `name` may be `*.ext` to match by extension.
pub fn find_up(start: &Path, names: &[&str]) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        for name in names {
            if let Some(ext) = name.strip_prefix("*.") {
                let mut hits: Vec<PathBuf> = std::fs::read_dir(d)
                    .ok()?
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case(ext)))
                    .collect();
                hits.sort();
                if let Some(first) = hits.into_iter().next() {
                    return Some(first);
                }
            } else if d.join(name).is_file() {
                return Some(d.join(name));
            }
        }
        dir = d.parent();
    }
    None
}

/// `canonicalize` on Windows returns `\\?\C:\...`; drop the prefix for normal-looking paths.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p,
    }
}

/// Major version from `java -version` output: `"1.8.0_421"` → 8, `"21.0.5"` → 21.
pub fn java_major(version_output: &str) -> Option<u32> {
    let start = version_output.find('"')? + 1;
    let rest = &version_output[start..];
    let quoted = &rest[..rest.find('"')?];
    let mut parts = quoted.split(['.', '_', '-', '+']);
    let first: u32 = parts.next()?.parse().ok()?;
    if first == 1 {
        parts.next()?.parse().ok()
    } else {
        Some(first)
    }
}

fn first_line(text: &str) -> String {
    text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_owned()
}

fn runtime(program: PathBuf, version: String, source: &str) -> Interpreter {
    Interpreter { program: program.to_string_lossy().into_owned(), args: Vec::new(), version, source: source.into() }
}

/// Version line of `program version_args`, if it runs and succeeds.
fn tool_version(program: &Path, version_args: &[&str]) -> Option<String> {
    let (ok, text) = capture(&program.to_string_lossy(), version_args, Duration::from_secs(15))?;
    ok.then(|| first_line(&text)).filter(|l| !l.is_empty())
}

/// Single-file source launch (`java Main.java`) needs Java 11+. PATH often holds an old
/// Java 8 stub (Oracle's `javapath`), so prefer JAVA_HOME and the JDK that owns `javac`.
fn detect_java() -> Option<Interpreter> {
    let exe = if cfg!(windows) { "java.exe" } else { "java" };
    let mut candidates: Vec<(PathBuf, &str)> = Vec::new();
    for var in ["JAVA_HOME", "JDK_HOME"] {
        if let Some(home) = std::env::var_os(var) {
            candidates.push((PathBuf::from(home).join("bin").join(exe), var));
        }
    }
    if let Some(javac) = which("javac") {
        // Resolve symlinks (e.g. /usr/bin/javac → /usr/lib/jvm/.../bin/javac).
        let javac = std::fs::canonicalize(&javac).map(strip_verbatim).unwrap_or(javac);
        if let Some(bin) = javac.parent() {
            candidates.push((bin.join(exe), "JDK"));
        }
    }
    if let Some(java) = which("java") {
        candidates.push((java, "PATH"));
    }
    let mut too_old = None;
    for (path, source) in candidates {
        if !path.is_file() {
            continue;
        }
        let Some((true, text)) = capture(&path.to_string_lossy(), &["-version"], Duration::from_secs(15)) else { continue };
        match java_major(&text) {
            Some(major) if major >= 11 => return Some(runtime(path, first_line(&text), source)),
            Some(major) => too_old = too_old.or(Some(major)),
            None => {}
        }
    }
    // Report the old one so the UI can explain why Java can't run single files.
    too_old.map(|major| Interpreter {
        program: String::new(),
        args: Vec::new(),
        version: format!("Java {major} (too old: single-file run needs Java 11+)"),
        source: "too-old".into(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Piped {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Run `program args` in `cwd`, feed `input` on stdin, collect stdout/stderr (formatters).
/// Killed after `timeout`. Stdin is written on its own thread so large outputs can't deadlock.
pub fn pipe(program: &str, args: &[String], cwd: &Path, input: Option<&str>, timeout: Duration) -> Result<Piped, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start {program}: {e}"))?;
    let writer = input.map(|text| {
        let mut stdin = child.stdin.take().expect("piped stdin");
        let bytes = text.as_bytes().to_vec();
        std::thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
            // Dropping stdin closes it, telling the formatter the input is complete.
        })
    });
    let read = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut buf);
            }
            String::from_utf8_lossy(&buf).into_owned()
        })
    };
    let out = read(child.stdout.take().map(|r| Box::new(r) as Box<dyn Read + Send>));
    let err = read(child.stderr.take().map(|r| Box::new(r) as Box<dyn Read + Send>));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(s) => break s,
            None if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(15)),
            None => {
                let _ = kill_tree(child.id());
                let _ = child.kill();
                return Err(format!("{program} took longer than {}s and was stopped", timeout.as_secs()));
            }
        }
    };
    if let Some(w) = writer {
        let _ = w.join();
    }
    Ok(Piped { code: status.code(), stdout: out.join().unwrap_or_default(), stderr: err.join().unwrap_or_default() })
}

/// First output line of `program args` if it exits successfully (e.g. `python -m black --version`).
pub fn probe_line(program: &str, args: &[&str]) -> Option<String> {
    let (ok, text) = capture(program, args, Duration::from_secs(15))?;
    ok.then(|| first_line(&text)).filter(|l| !l.is_empty())
}

/// Well-known install folders for tools that often aren't on PATH.
fn extra_locations(name: &str) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if matches!(name, "clang-format" | "clang" | "clang++") {
        if cfg!(windows) {
            for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
                if let Some(pf) = std::env::var_os(var) {
                    let pf = PathBuf::from(pf);
                    dirs.push(pf.join("LLVM").join("bin"));
                    // Visual Studio's bundled LLVM: <VS>\<year>\<edition>\VC\Tools\Llvm\[x64\]bin
                    for year in std::fs::read_dir(pf.join("Microsoft Visual Studio")).into_iter().flatten().flatten() {
                        for edition in std::fs::read_dir(year.path()).into_iter().flatten().flatten() {
                            let llvm = edition.path().join("VC").join("Tools").join("Llvm");
                            dirs.push(llvm.join("x64").join("bin"));
                            dirs.push(llvm.join("bin"));
                        }
                    }
                }
            }
        } else {
            dirs.extend(["/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin", "/usr/lib/llvm/bin"].map(PathBuf::from));
        }
    }
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_owned() };
    let mut found: Vec<PathBuf> = dirs.into_iter().map(|d| d.join(&exe)).filter(|p| p.is_file()).collect();
    // Linux distros ship versioned binaries (clang-format-18); prefer the newest.
    if !cfg!(windows) {
        let mut versioned: Vec<(u32, PathBuf)> = std::fs::read_dir("/usr/bin")
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                let v: u32 = n.strip_prefix(&format!("{name}-"))?.parse().ok()?;
                Some((v, e.path()))
            })
            .collect();
        versioned.sort_by(|a, b| b.0.cmp(&a.0));
        found.extend(versioned.into_iter().map(|(_, p)| p));
    }
    found
}

/// Visual C++ (Windows): not on PATH, so find Visual Studio with vswhere. `program` is its
/// `vcvars64.bat`, which a generated build script calls to set up `cl`.
fn detect_msvc() -> Option<Interpreter> {
    if !cfg!(windows) {
        return None;
    }
    let pf = PathBuf::from(std::env::var_os("ProgramFiles(x86)")?);
    let vswhere = pf.join("Microsoft Visual Studio").join("Installer").join("vswhere.exe");
    let vswhere = vswhere.to_string_lossy();
    let query = |prop: &str| {
        probe_line(
            &vswhere,
            &["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", prop],
        )
    };
    let vcvars = PathBuf::from(query("installationPath")?).join("VC").join("Auxiliary").join("Build").join("vcvars64.bat");
    if !vcvars.is_file() {
        return None;
    }
    let version = query("catalog_productDisplayVersion").map_or("Visual C++".into(), |v| format!("Visual C++ (Visual Studio {v})"));
    Some(runtime(vcvars, version, "Visual Studio"))
}

/// Find a runtime or build tool: node, deno, bun, tsx, go, java, dotnet, cargo, rustc, gcc, g++,
/// clang, clang++, msvc, cmake — or a
/// formatter: ruff, black, autopep8, gofmt, rustfmt, clang-format, prettier, google-java-format.
/// `dir` is used for project-local tools (`node_modules/.bin/tsx`, `…/prettier`).
pub fn detect_runtime(kind: &str, dir: Option<&Path>) -> Option<Interpreter> {
    let simple = |name: &str, args: &[&str]| {
        let path = which(name)?;
        let v = tool_version(&path, args)?;
        Some(runtime(path, v, "PATH"))
    };
    let node_bin = |name: &str| {
        let local = dir.and_then(|d| {
            let file = if cfg!(windows) { format!("{name}.cmd") } else { name.to_owned() };
            find_up(d, &[&format!("node_modules/.bin/{file}")])
        });
        match local {
            Some(p) => tool_version(&p, &["--version"]).map(|v| runtime(p, v, "project")),
            None => simple(name, &["--version"]),
        }
    };
    match kind {
        "ruff" => simple("ruff", &["--version"]),
        "black" => simple("black", &["--version"]),
        "autopep8" => simple("autopep8", &["--version"]),
        "rustfmt" => simple("rustfmt", &["--version"]),
        "google-java-format" => simple("google-java-format", &["--version"]),
        "prettier" => node_bin("prettier"),
        // gofmt has no version flag; it ships with Go, so finding it is enough.
        "gofmt" => which("gofmt").map(|p| runtime(p, "gofmt".into(), "PATH")),
        "clang-format" | "clang" | "clang++" => which(kind)
            .map(|p| (p, "PATH"))
            .into_iter()
            .chain(extra_locations(kind).into_iter().map(|p| (p, "installed")))
            .find_map(|(p, src)| tool_version(&p, &["--version"]).map(|v| runtime(p, v, src))),
        "gcc" => simple("gcc", &["--version"]),
        "g++" => simple("g++", &["--version"]),
        "cmake" => simple("cmake", &["--version"]),
        "msvc" => detect_msvc(),
        "node" => simple("node", &["--version"]),
        "deno" => simple("deno", &["--version"]),
        "bun" => simple("bun", &["--version"]),
        "go" => simple("go", &["version"]),
        "dotnet" => simple("dotnet", &["--version"]),
        "cargo" => simple("cargo", &["--version"]),
        "rustc" => simple("rustc", &["--version"]),
        "java" => detect_java(),
        "tsx" => node_bin("tsx"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn java_version_parsing() {
        assert_eq!(java_major("java version \"1.8.0_421\"\nJava(TM) SE Runtime"), Some(8));
        assert_eq!(java_major("openjdk version \"21.0.5\" 2024-10-15"), Some(21));
        assert_eq!(java_major("openjdk version \"17\" 2021-09-14"), Some(17));
        assert_eq!(java_major("openjdk version \"23-ea\" 2024-09-17"), Some(23));
        assert_eq!(java_major("no version here"), None);
    }

    #[test]
    fn find_up_matches_names_and_extensions() {
        let d = tempfile::tempdir().unwrap();
        let deep = d.path().join("a/b/c");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(d.path().join("go.mod"), "module x").unwrap();
        std::fs::write(d.path().join("a/App.csproj"), "<Project/>").unwrap();
        assert_eq!(find_up(&deep, &["go.mod"]), Some(d.path().join("go.mod")));
        assert_eq!(find_up(&deep, &["*.csproj"]), Some(d.path().join("a/App.csproj")));
        assert_eq!(find_up(&deep, &["Cargo.toml"]).filter(|p| p.starts_with(d.path())), None);
    }

    #[test]
    fn pipe_feeds_stdin_and_reports_failure() {
        let Some(rustfmt) = which("rustfmt") else { return };
        let p = rustfmt.to_string_lossy();
        let args = vec!["--edition".to_string(), "2021".to_string()];
        let cwd = std::env::temp_dir();
        let ok = pipe(&p, &args, &cwd, Some("fn main(){let x=1;}"), Duration::from_secs(30)).unwrap();
        assert_eq!(ok.code, Some(0));
        assert_eq!(ok.stdout.replace("\r\n", "\n"), "fn main() {\n    let x = 1;\n}\n");
        let bad = pipe(&p, &args, &cwd, Some("fn main( {"), Duration::from_secs(30)).unwrap();
        assert_ne!(bad.code, Some(0));
        assert!(bad.stdout.is_empty());
        assert!(bad.stderr.contains("unclosed delimiter"));
        // Large input must not deadlock (stdin is written on its own thread).
        let big: String = (0..20_000).map(|i| format!("fn f{i}(){{}}\n")).collect();
        let out = pipe(&p, &args, &cwd, Some(&big), Duration::from_secs(60)).unwrap();
        assert_eq!(out.code, Some(0));
        assert!(out.stdout.len() > big.len());
    }

    #[test]
    fn which_finds_tools_on_path() {
        // cargo is on PATH whenever these tests run.
        let cargo = which("cargo").expect("cargo on PATH");
        assert!(cargo.is_file());
        assert!(which("definitely-not-a-real-tool-xyz").is_none());
        assert!(detect_runtime("cargo", None).is_some_and(|r| r.version.starts_with("cargo ")));
        // C/C++ compilers, where installed: each one found must report a version.
        for kind in ["gcc", "g++", "clang", "clang++", "msvc", "cmake"] {
            if let Some(t) = detect_runtime(kind, None) {
                assert!(!t.version.is_empty() && Path::new(&t.program).is_file(), "{kind}: {t:?}");
            }
        }
    }

    #[test]
    fn utf8_stream_keeps_split_characters() {
        let bytes = "é日本🎉".as_bytes();
        let mut s = Utf8Stream::default();
        let mut out = String::new();
        for b in bytes {
            out.push_str(&s.push(&[*b]));
        }
        out.push_str(&s.finish());
        assert_eq!(out, "é日本🎉");
    }

    #[test]
    fn utf8_stream_replaces_invalid_bytes() {
        let mut s = Utf8Stream::default();
        assert_eq!(s.push(b"a\xFFb"), "a\u{FFFD}b");
        assert_eq!(s.push(b"\xE6\x97"), ""); // incomplete, held back
        assert_eq!(s.finish(), "\u{FFFD}");
    }

    fn python() -> Option<Interpreter> {
        detect_interpreters(None).into_iter().next()
    }

    fn run(runs: &Runs, id: u64, code: &str) -> (mpsc::Receiver<(Stream, String)>, mpsc::Receiver<Exit>) {
        let py = python().expect("python needed for this test");
        let (otx, orx) = mpsc::channel();
        let (etx, erx) = mpsc::channel();
        let otx = Mutex::new(otx);
        let mut args = py.args.clone();
        args.extend(["-u".into(), "-c".into(), code.into()]);
        let cwd = std::env::temp_dir();
        let env = [("PYTHONIOENCODING".to_string(), "utf-8".to_string())];
        runs.start(
            id,
            &Spec { program: &py.program, args: &args, cwd: &cwd, env: &env },
            move |s, t| {
                let _ = otx.lock().unwrap().send((s, t));
            },
            move |e| {
                let _ = etx.send(e);
            },
        )
        .unwrap();
        (orx, erx)
    }

    #[test]
    fn runs_python_with_output_stdin_and_exit_code() {
        if python().is_none() {
            eprintln!("skipping: no python on PATH");
            return;
        }
        let runs = Runs::default();
        let (out, exit) = run(&runs, 1, "import sys\nname = input()\nprint('hi ' + name + ' ✓')\nprint('oops', file=sys.stderr)\nsys.exit(3)");
        runs.write_stdin(1, "Ana\n").unwrap();
        let e = exit.recv_timeout(Duration::from_secs(20)).unwrap();
        runs.finished(1);
        let chunks: Vec<_> = out.try_iter().collect();
        let stdout: String = chunks.iter().filter(|(s, _)| *s == Stream::Stdout).map(|(_, t)| t.as_str()).collect();
        let stderr: String = chunks.iter().filter(|(s, _)| *s == Stream::Stderr).map(|(_, t)| t.as_str()).collect();
        assert_eq!(stdout.trim_end(), "hi Ana ✓");
        assert_eq!(stderr.trim_end(), "oops");
        assert_eq!(e.code, Some(3));
        assert!(!e.killed);
    }

    #[test]
    fn kill_stops_a_running_script_and_its_children() {
        if python().is_none() {
            eprintln!("skipping: no python on PATH");
            return;
        }
        let runs = Runs::default();
        let code = "import subprocess, sys, time\nsubprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\nprint('started', flush=True)\ntime.sleep(60)";
        let (out, exit) = run(&runs, 2, code);
        let (_, first) = out.recv_timeout(Duration::from_secs(20)).unwrap();
        assert!(first.contains("started"));
        runs.kill(2).unwrap();
        let e = exit.recv_timeout(Duration::from_secs(10)).expect("process should exit after kill");
        assert!(e.killed);
    }

    #[test]
    fn detection_finds_a_venv_first() {
        let Some(py) = python() else { return };
        let d = tempfile::tempdir().unwrap();
        let bin = if cfg!(windows) { d.path().join(".venv/Scripts") } else { d.path().join(".venv/bin") };
        std::fs::create_dir_all(&bin).unwrap();
        // A copy of a real interpreter isn't portable; a failing stub must simply be skipped.
        let stub = bin.join(if cfg!(windows) { "python.exe" } else { "python" });
        std::fs::write(&stub, b"not a program").unwrap();
        let found = detect_interpreters(Some(&d.path().join("src")));
        assert!(!found.iter().any(|i| i.source == "venv"), "broken venv python is not offered");
        assert!(found.iter().any(|i| i.program == py.program));
    }
}
