use crate::file_io::atomic_write;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Only these files may be read/written in the app data dir from the frontend.
const ALLOWED: &[&str] = &["session.json", "settings.json"];

/// Per-project sessions: `projects/<16 hex digits>.json` (an id derived from the project path).
fn is_project_session(name: &str) -> bool {
    name.strip_prefix("projects/")
        .and_then(|n| n.strip_suffix(".json"))
        .is_some_and(|id| id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn allowed(name: &str) -> bool {
    ALLOWED.contains(&name) || is_project_session(name)
}

fn app_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !allowed(name) {
        return Err(format!("{name} is not an app data file"));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join(name);
    fs::create_dir_all(path.parent().unwrap_or(&dir)).map_err(|e| e.to_string())?;
    Ok(path)
}

pub fn read(app: &AppHandle, name: &str) -> Result<Option<String>, String> {
    let path = app_file(app, name)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

pub fn write(app: &AppHandle, name: &str, content: &str) -> Result<(), String> {
    let path = app_file(app, name)?;
    atomic_write(&path, content.as_bytes()).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_app_files_are_allowed() {
        assert!(allowed("session.json"));
        assert!(allowed("projects/0123456789abcdef.json"));
        assert!(!allowed("projects/../settings.json"));
        assert!(!allowed("projects/0123456789abcdef.json.bak"));
        assert!(!allowed("projects/xyz.json"));
        assert!(!allowed("../evil.json"));
        assert!(!allowed("projects/0123456789abcdeg.json"));
    }
}
