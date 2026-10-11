//! Integrated terminal: shells running in a pseudo-terminal (ConPTY on Windows, openpty elsewhere).

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    open: Mutex<HashMap<u64, Term>>,
}

/// The user's shell: $SHELL on Unix, PowerShell 7 / Windows PowerShell / cmd on Windows.
pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        for name in ["pwsh", "powershell"] {
            if let Some(p) = crate::runner::which(name) {
                return p.to_string_lossy().into_owned();
            }
        }
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into())
    }
}

impl Terminals {
    /// Start `shell` in `cwd`. Output goes to `on_output` (UTF-8, split characters kept whole),
    /// then `on_exit` once with the exit code when the shell ends. `on_exit` should call
    /// [`Terminals::forget`]: on Windows the output pipe only closes once the PTY is dropped.
    pub fn spawn(
        &self,
        id: u64,
        shell: &str,
        cwd: &Path,
        cols: u16,
        rows: u16,
        on_output: impl Fn(String) + Send + 'static,
        on_exit: impl FnOnce(u32) + Send + 'static,
    ) -> Result<(), String> {
        let pair = native_pty_system()
            .openpty(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
        let mut cmd = CommandBuilder::new(shell);
        if cwd.is_dir() {
            cmd.cwd(cwd);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("Couldn't start {shell}: {e}"))?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let killer = child.clone_killer();
        self.open.lock().unwrap().insert(id, Term { master: pair.master, writer, killer });

        std::thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
            on_exit(code);
        });

        std::thread::spawn(move || {
            let mut utf8 = crate::runner::Utf8Stream::default();
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = utf8.push(&buf[..n]);
                        if !text.is_empty() {
                            on_output(text);
                        }
                    }
                }
            }
            let rest = utf8.finish();
            if !rest.is_empty() {
                on_output(rest);
            }
        });
        Ok(())
    }

    pub fn write(&self, id: u64, data: &str) -> Result<(), String> {
        let mut open = self.open.lock().unwrap();
        let t = open.get_mut(&id).ok_or("terminal is closed")?;
        t.writer.write_all(data.as_bytes()).and_then(|_| t.writer.flush()).map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: u64, cols: u16, rows: u16) -> Result<(), String> {
        let open = self.open.lock().unwrap();
        let t = open.get(&id).ok_or("terminal is closed")?;
        t.master
            .resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }

    /// Kill the shell (and, through the closed PTY, what runs in it).
    pub fn kill(&self, id: u64) {
        let term = self.open.lock().unwrap().remove(&id);
        if let Some(mut t) = term {
            let _ = t.killer.kill();
        }
    }

    /// Drop the PTY of a shell that has exited.
    pub fn forget(&self, id: u64) {
        let term = self.open.lock().unwrap().remove(&id);
        drop(term);
    }

    pub fn kill_all(&self) {
        let ids: Vec<u64> = self.open.lock().unwrap().keys().copied().collect();
        for id in ids {
            self.kill(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn shell_runs_commands_and_reports_exit() {
        let terms = Terminals::default();
        let (out_tx, out_rx) = mpsc::channel::<String>();
        let (exit_tx, exit_rx) = mpsc::channel::<u32>();
        let cwd = std::env::temp_dir();
        terms
            .spawn(1, &default_shell(), &cwd, 80, 24, move |s| { let _ = out_tx.send(s); }, move |c| { let _ = exit_tx.send(c); })
            .unwrap();
        #[cfg(windows)]
        let cmd = "echo pty-ok-$(6*7)\r";
        #[cfg(not(windows))]
        let cmd = "echo pty-ok-$((6*7))\r";
        terms.write(1, cmd).unwrap();
        let mut seen = String::new();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !seen.contains("pty-ok-42") && Instant::now() < deadline {
            if let Ok(s) = out_rx.recv_timeout(Duration::from_millis(200)) {
                // ConPTY asks for the cursor position and waits; answer like xterm would.
                if s.contains("\x1b[6n") {
                    terms.write(1, "\x1b[1;1R").unwrap();
                }
                seen.push_str(&s);
            }
        }
        assert!(seen.contains("pty-ok-42"), "output was: {seen}");
        terms.resize(1, 100, 30).unwrap();
        terms.write(1, "exit\r").unwrap();
        exit_rx.recv_timeout(Duration::from_secs(10)).expect("shell should exit");
    }
}
