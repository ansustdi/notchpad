//! File-system operations for the sidebar (folder tree) and "Goto Anything" file list.

use ignore::WalkBuilder;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Version-control folders and OS clutter that Sublime hides by default.
const EXCLUDED: &[&str] = &[".git", ".svn", ".hg", "CVS", ".bzr", ".DS_Store", "Thumbs.db", "desktop.ini"];

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

fn path_string(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Children of `dir`: folders first, then files, each sorted case-insensitively (numbers naturally).
pub fn list_dir(dir: &Path) -> Result<Vec<Entry>, String> {
    let mut out: Vec<Entry> = std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .filter_map(|e| e.ok())
        .filter(|e| !EXCLUDED.iter().any(|x| e.file_name().to_string_lossy().eq_ignore_ascii_case(x)))
        .map(|e| {
            // Follow symlinks for the folder/file decision; broken links show as files.
            let is_dir = std::fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false);
            Entry { name: e.file_name().to_string_lossy().into_owned(), path: path_string(&e.path()), is_dir }
        })
        .collect();
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| natural_cmp(&a.name, &b.name)));
    Ok(out)
}

/// "file2" before "file10", case-insensitive.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    fn chunks(s: &str) -> Vec<(bool, String)> {
        let mut v: Vec<(bool, String)> = Vec::new();
        for c in s.chars() {
            let digit = c.is_ascii_digit();
            match v.last_mut() {
                Some((d, buf)) if *d == digit => buf.push(c),
                _ => v.push((digit, c.to_string())),
            }
        }
        v
    }
    let (x, y) = (chunks(a), chunks(b));
    for ((dx, sx), (dy, sy)) in x.iter().zip(y.iter()) {
        let ord = if *dx && *dy {
            let (tx, ty) = (sx.trim_start_matches('0'), sy.trim_start_matches('0'));
            tx.len().cmp(&ty.len()).then_with(|| tx.cmp(ty))
        } else {
            sx.to_lowercase().cmp(&sy.to_lowercase())
        };
        if ord != std::cmp::Ordering::Equal {
            return ord;
        }
    }
    x.len().cmp(&y.len()).then_with(|| a.cmp(b))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    pub files: Vec<String>,
    /// True when `limit` was reached and some files were left out.
    pub truncated: bool,
}

/// All files under `roots` for quick open: respects .gitignore; dotfiles (`.env`, `.gitignore`)
/// are listed like Sublime does, version-control folders are not.
pub fn list_files(roots: &[PathBuf], limit: usize) -> FileList {
    let mut files = Vec::new();
    let mut truncated = false;
    for root in roots {
        let mut wb = WalkBuilder::new(root);
        wb.hidden(false)
            .git_ignore(true)
            .git_global(true)
            .require_git(false)
            .ignore(true)
            .filter_entry(|e| !EXCLUDED.iter().any(|x| e.file_name().to_string_lossy().eq_ignore_ascii_case(x)));
        for entry in wb.build().flatten() {
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            if files.len() >= limit {
                truncated = true;
                break;
            }
            files.push(path_string(entry.path()));
        }
    }
    FileList { files, truncated }
}

fn ensure_absent(p: &Path) -> Result<(), String> {
    if p.exists() {
        Err(format!("{} already exists", p.display()))
    } else {
        Ok(())
    }
}

pub fn create_file(p: &Path) -> Result<(), String> {
    ensure_absent(p)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // create_new: never truncate an existing file even if it appeared in the meantime.
    std::fs::OpenOptions::new().write(true).create_new(true).open(p).map(|_| ()).map_err(|e| format!("{}: {e}", p.display()))
}

pub fn create_dir(p: &Path) -> Result<(), String> {
    ensure_absent(p)?;
    std::fs::create_dir_all(p).map_err(|e| format!("{}: {e}", p.display()))
}

/// Rename / move without overwriting. A case-only rename (`a.txt` → `A.txt`) is allowed.
pub fn rename(from: &Path, to: &Path) -> Result<(), String> {
    let same_file = from.to_string_lossy().eq_ignore_ascii_case(&to.to_string_lossy());
    if !same_file {
        ensure_absent(to)?;
    }
    std::fs::rename(from, to).map_err(|e| format!("{}: {e}", from.display()))
}

/// Copy a file or a whole folder to `to`, never overwriting anything that already exists.
pub fn copy(from: &Path, to: &Path) -> Result<(), String> {
    ensure_absent(to)?;
    if to.starts_with(from) {
        return Err("Can't copy a folder into itself".into());
    }
    copy_rec(from, to).map_err(|e| format!("{}: {e}", from.display()))
}

fn copy_rec(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = std::fs::metadata(from)?;
    if meta.is_dir() {
        std::fs::create_dir(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_rec(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        // create_new semantics: fail rather than overwrite a file that appeared meanwhile.
        let mut src = std::fs::File::open(from)?;
        let mut dst = std::fs::OpenOptions::new().write(true).create_new(true).open(to)?;
        std::io::copy(&mut src, &mut dst)?;
        dst.set_permissions(meta.permissions())
    }
}

/// Move to the Recycle Bin / Trash (recoverable), never a permanent delete.
pub fn trash(p: &Path) -> Result<(), String> {
    trash::delete(p).map_err(|e| format!("{}: {e}", p.display()))
}

/// Show `p` selected in the system file manager.
pub fn reveal(p: &Path) -> Result<(), String> {
    use std::process::Command;
    #[cfg(windows)]
    let status = {
        use std::os::windows::process::CommandExt;
        // explorer.exe wants `/select,"path"` as one raw argument.
        Command::new("explorer.exe").raw_arg(format!("/select,\"{}\"", p.display())).spawn()
    };
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg("-R").arg(p).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(if p.is_dir() { p } else { p.parent().unwrap_or(p) }).spawn();
    status.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn names(v: &[Entry]) -> Vec<String> {
        v.iter().map(|e| format!("{}{}", e.name, if e.is_dir { "/" } else { "" })).collect()
    }

    #[test]
    fn lists_folders_first_naturally_and_hides_vcs() {
        let d = tempfile::tempdir().unwrap();
        for f in ["b.txt", "a10.log", "a2.log", "Zeta.md", ".env"] {
            fs::write(d.path().join(f), "").unwrap();
        }
        for dir in ["src", ".git", "Docs", "node_modules"] {
            fs::create_dir(d.path().join(dir)).unwrap();
        }
        assert_eq!(
            names(&list_dir(d.path()).unwrap()),
            ["Docs/", "node_modules/", "src/", ".env", "a2.log", "a10.log", "b.txt", "Zeta.md"]
        );
    }

    #[test]
    fn file_list_respects_gitignore_and_limit() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("src/deep")).unwrap();
        fs::create_dir_all(d.path().join("target")).unwrap();
        fs::write(d.path().join(".gitignore"), "target/\n*.tmp\n").unwrap();
        fs::write(d.path().join("src/main.rs"), "").unwrap();
        fs::write(d.path().join("src/deep/x.rs"), "").unwrap();
        fs::write(d.path().join("src/skip.tmp"), "").unwrap();
        fs::write(d.path().join("target/out.bin"), "").unwrap();
        let roots = [d.path().to_path_buf()];
        let mut all: Vec<String> = list_files(&roots, 100)
            .files
            .iter()
            .map(|f| Path::new(f).strip_prefix(d.path()).unwrap().to_string_lossy().replace('\\', "/"))
            .collect();
        all.sort();
        assert_eq!(all, [".gitignore", "src/deep/x.rs", "src/main.rs"]);
        let capped = list_files(&roots, 2);
        assert_eq!(capped.files.len(), 2);
        assert!(capped.truncated);
    }

    #[test]
    fn create_and_rename_never_overwrite() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("sub/a.txt");
        create_file(&a).unwrap();
        fs::write(&a, "keep").unwrap();
        assert!(create_file(&a).is_err());
        assert_eq!(fs::read_to_string(&a).unwrap(), "keep");
        create_dir(&d.path().join("dir")).unwrap();
        assert!(create_dir(&d.path().join("dir")).is_err());

        let b = d.path().join("sub/b.txt");
        fs::write(&b, "other").unwrap();
        assert!(rename(&a, &b).is_err(), "must not clobber b.txt");
        assert_eq!(fs::read_to_string(&b).unwrap(), "other");
        let c = d.path().join("sub/c.txt");
        rename(&a, &c).unwrap();
        assert_eq!(fs::read_to_string(&c).unwrap(), "keep");
        // Case-only rename is fine even though the target "exists" on case-insensitive disks.
        rename(&c, &d.path().join("sub/C.txt")).unwrap();
    }

    #[test]
    fn copies_folders_recursively_without_overwriting() {
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("src");
        fs::create_dir_all(src.join("inner")).unwrap();
        fs::write(src.join("a.txt"), "A").unwrap();
        fs::write(src.join("inner/b.txt"), "B").unwrap();
        let dst = d.path().join("copy");
        copy(&src, &dst).unwrap();
        assert_eq!(fs::read_to_string(dst.join("inner/b.txt")).unwrap(), "B");
        assert!(copy(&src, &dst).is_err(), "target exists");
        assert!(copy(&src, &src.join("inner/nested")).is_err(), "into itself");
        let f = d.path().join("one.txt");
        copy(&src.join("a.txt"), &f).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "A");
    }
}
