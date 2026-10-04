use crate::file_io::{self, MAX_EDITOR_FILE_SIZE};
use encoding_rs::{Encoding, UTF_8};
use grep_matcher::{LineTerminator, Matcher};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::overrides::OverrideBuilder;
use ignore::{WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

/// Stop collecting once this many matches were found; the UI can't use more.
pub const MAX_MATCHES: u64 = 20_000;
/// Preview length (UTF-16 units) sent for one matched line.
const PREVIEW_LEN: usize = 240;
/// How much of the line before the first match to keep in the preview.
const PREVIEW_LEAD: usize = 40;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub root: String,
    pub query: String,
    pub is_regex: bool,
    pub match_case: bool,
    pub whole_word: bool,
    /// Comma separated globs, e.g. "*.ts, *.md". Empty = everything.
    #[serde(default)]
    pub include: String,
    /// Comma separated globs, e.g. "node_modules, *.min.js".
    #[serde(default)]
    pub exclude: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    /// 1-based line number.
    pub line: u64,
    /// Possibly shortened line text.
    pub text: String,
    /// UTF-16 offset in the full line where `text` starts.
    pub preview_start: u32,
    /// Match ranges as UTF-16 [start, end) offsets in the full line.
    pub ranges: Vec<(u32, u32)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub search_id: u64,
    pub path: String,
    pub matches: Vec<LineMatch>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchDone {
    pub search_id: u64,
    pub files: u64,
    pub matches: u64,
    pub searched_files: u64,
    pub truncated: bool,
    pub cancelled: bool,
    pub elapsed_ms: u64,
}

pub fn build_matcher(req: &SearchRequest) -> Result<RegexMatcher, String> {
    if req.query.is_empty() {
        return Err("Search text is empty".into());
    }
    RegexMatcherBuilder::new()
        .case_insensitive(!req.match_case)
        .word(req.whole_word)
        .fixed_strings(!req.is_regex)
        .line_terminator(Some(b'\n'))
        .crlf(true)
        .build(&req.query)
        .map_err(|e| format!("Invalid regular expression: {e}"))
}

fn split_globs(s: &str) -> impl Iterator<Item = &str> {
    s.split(',').map(str::trim).filter(|g| !g.is_empty())
}

fn walker(req: &SearchRequest) -> Result<WalkBuilder, String> {
    let root = Path::new(&req.root);
    if !root.exists() {
        return Err(format!("{} does not exist", req.root));
    }
    let mut ov = OverrideBuilder::new(root);
    for g in split_globs(&req.include) {
        ov.add(g).map_err(|e| format!("Bad include pattern {g}: {e}"))?;
    }
    for g in split_globs(&req.exclude) {
        ov.add(&format!("!{g}")).map_err(|e| format!("Bad exclude pattern {g}: {e}"))?;
    }
    let ov = ov.build().map_err(|e| e.to_string())?;
    let mut wb = WalkBuilder::new(root);
    wb.hidden(true).git_ignore(true).git_global(true).require_git(false).ignore(true).overrides(ov);
    Ok(wb)
}

fn utf16_len(bytes: &[u8], enc: &'static Encoding) -> u32 {
    if enc == UTF_8 {
        String::from_utf8_lossy(bytes).encode_utf16().count() as u32
    } else {
        enc.decode_without_bom_handling(bytes).0.encode_utf16().count() as u32
    }
}

/// Non-empty match ranges in one line, as UTF-16 [start, end) offsets.
pub fn match_ranges(matcher: &RegexMatcher, raw: &[u8], enc: &'static Encoding) -> Vec<(u32, u32)> {
    let line = trim_eol(raw);
    let mut ranges = Vec::new();
    let _ = matcher.find_iter(line, |m| {
        if m.start() < m.end() {
            ranges.push((utf16_len(&line[..m.start()], enc), utf16_len(&line[..m.end()], enc)));
        }
        true
    });
    ranges
}

fn trim_eol(mut line: &[u8]) -> &[u8] {
    while let Some((&last, rest)) = line.split_last() {
        if last == b'\n' || last == b'\r' {
            line = rest;
        } else {
            break;
        }
    }
    line
}

/// Build the display record for one matched line.
fn line_match(matcher: &RegexMatcher, line_no: u64, raw: &[u8]) -> Option<LineMatch> {
    let line = trim_eol(raw);
    let ranges = match_ranges(matcher, raw, UTF_8);
    let &(first, _) = ranges.first()?;
    let full: Vec<u16> = String::from_utf8_lossy(line).encode_utf16().collect();
    let start = (first as usize).saturating_sub(PREVIEW_LEAD);
    // Don't cut a surrogate pair in half.
    let start = if start > 0 && (0xDC00..0xE000).contains(&full[start]) { start - 1 } else { start };
    let mut end = (start + PREVIEW_LEN).min(full.len());
    if end < full.len() && (0xDC00..0xE000).contains(&full[end]) {
        end += 1;
    }
    Some(LineMatch {
        line: line_no,
        text: String::from_utf16_lossy(&full[start..end]),
        preview_start: start as u32,
        ranges,
    })
}

struct Collect<'a> {
    matcher: &'a RegexMatcher,
    matches: Vec<LineMatch>,
    total: &'a AtomicU64,
}

impl Sink for Collect<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, _: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        let Some(lm) = line_match(self.matcher, mat.line_number().unwrap_or(0), mat.bytes()) else {
            return Ok(true);
        };
        let n = lm.ranges.len() as u64;
        self.matches.push(lm);
        Ok(self.total.fetch_add(n, Ordering::Relaxed) + n < MAX_MATCHES)
    }
}

/// Search `req.root` in parallel. `emit` receives one batch per file that has matches.
pub fn run(
    req: &SearchRequest,
    matcher: &RegexMatcher,
    search_id: u64,
    cancelled: &(dyn Fn() -> bool + Sync),
    emit: &(dyn Fn(FileMatches) + Sync),
) -> Result<SearchDone, String> {
    let started = Instant::now();
    let total = AtomicU64::new(0);
    let files = AtomicU64::new(0);
    let searched = AtomicU64::new(0);
    let stopped_by_cancel = AtomicBool::new(false);

    walker(req)?.build_parallel().run(|| {
        // Must agree with the matcher's CRLF setting or every search errors out.
        let mut searcher = SearcherBuilder::new()
            .binary_detection(BinaryDetection::quit(0))
            .line_terminator(LineTerminator::crlf())
            .line_number(true)
            .build();
        let (total, files, searched, stopped_by_cancel) = (&total, &files, &searched, &stopped_by_cancel);
        Box::new(move |entry| {
            if cancelled() {
                stopped_by_cancel.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            if total.load(Ordering::Relaxed) >= MAX_MATCHES {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else { return WalkState::Continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }
            searched.fetch_add(1, Ordering::Relaxed);
            let mut sink = Collect { matcher, matches: Vec::new(), total };
            let _ = searcher.search_path(matcher, entry.path(), &mut sink);
            if !sink.matches.is_empty() {
                files.fetch_add(1, Ordering::Relaxed);
                emit(FileMatches {
                    search_id,
                    path: entry.path().to_string_lossy().into_owned(),
                    matches: sink.matches,
                });
            }
            WalkState::Continue
        })
    });

    let matches = total.load(Ordering::Relaxed);
    Ok(SearchDone {
        search_id,
        files: files.load(Ordering::Relaxed),
        matches: matches.min(MAX_MATCHES),
        searched_files: searched.load(Ordering::Relaxed),
        truncated: matches >= MAX_MATCHES,
        cancelled: stopped_by_cancel.load(Ordering::Relaxed),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceSummary {
    pub changed_files: Vec<String>,
    pub replacements: u64,
    pub errors: Vec<String>,
}

fn build_regex(req: &SearchRequest) -> Result<regex::Regex, String> {
    let pat = if req.is_regex { req.query.clone() } else { regex::escape(&req.query) };
    let pat = if req.whole_word { format!(r"\b(?:{pat})\b") } else { pat };
    regex::RegexBuilder::new(&pat)
        .case_insensitive(!req.match_case)
        .multi_line(true)
        .crlf(true)
        .build()
        .map_err(|e| format!("Invalid regular expression: {e}"))
}

/// Replace every match in `paths`, keeping each file's encoding, BOM and line endings.
pub fn replace_in_files(req: &SearchRequest, replacement: &str, paths: &[String]) -> Result<ReplaceSummary, String> {
    let re = build_regex(req)?;
    let mut summary = ReplaceSummary::default();
    for path in paths {
        let p = Path::new(path);
        let result = (|| -> Result<u64, String> {
            if std::fs::metadata(p).map_err(|e| e.to_string())?.len() > MAX_EDITOR_FILE_SIZE {
                return Err("file too large".into());
            }
            let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
            let decoded = file_io::decode(&bytes);
            if decoded.had_errors {
                return Err(format!("not valid {} text, skipped", decoded.encoding.name()));
            }
            let count = re.find_iter(&decoded.content).filter(|m| !m.is_empty()).count() as u64;
            if count == 0 {
                return Ok(0);
            }
            let replaced = if req.is_regex {
                re.replace_all(&decoded.content, replacement)
            } else {
                re.replace_all(&decoded.content, regex::NoExpand(replacement))
            };
            let out = file_io::encode_text(&replaced, decoded.encoding, decoded.has_bom)?;
            file_io::atomic_write(p, &out).map_err(|e| e.to_string())?;
            Ok(count)
        })();
        match result {
            Ok(0) => {}
            Ok(n) => {
                summary.replacements += n;
                summary.changed_files.push(path.clone());
            }
            Err(e) => summary.errors.push(format!("{path}: {e}")),
        }
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;

    fn req(root: &Path, query: &str) -> SearchRequest {
        SearchRequest {
            root: root.to_string_lossy().into_owned(),
            query: query.into(),
            is_regex: false,
            match_case: false,
            whole_word: false,
            include: String::new(),
            exclude: String::new(),
        }
    }

    fn search(r: &SearchRequest) -> (Vec<FileMatches>, SearchDone) {
        let m = build_matcher(r).unwrap();
        let out = Mutex::new(Vec::new());
        let done = run(r, &m, 1, &|| false, &|f| out.lock().unwrap().push(f)).unwrap();
        let mut v = out.into_inner().unwrap();
        v.sort_by(|a, b| a.path.cmp(&b.path));
        (v, done)
    }

    fn fixture() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("a.txt"), "Hello world\r\nsay hello again\n").unwrap();
        fs::create_dir(d.path().join("sub")).unwrap();
        fs::write(d.path().join("sub/b.md"), "nothing\nhello there, héllo hello\n").unwrap();
        fs::write(d.path().join("sub/bin.dat"), b"hello\x00\x01\x02").unwrap();
        fs::create_dir(d.path().join("node_modules")).unwrap();
        fs::write(d.path().join("node_modules/x.txt"), "hello").unwrap();
        fs::write(d.path().join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(d.path().join("ignored.txt"), "hello").unwrap();
        d
    }

    #[test]
    fn finds_matches_with_lines_and_utf16_ranges() {
        let d = fixture();
        let mut r = req(d.path(), "hello");
        r.exclude = "node_modules".into();
        let (files, done) = search(&r);
        let names: Vec<_> = files.iter().map(|f| Path::new(&f.path).file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["a.txt", "b.md"], "binary, gitignored and excluded files skipped");
        assert_eq!(files[0].matches.iter().map(|m| m.line).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(files[0].matches[0].text, "Hello world", "CRLF trimmed");
        let b = &files[1].matches[0];
        assert_eq!(b.line, 2);
        // "héllo" is not "hello". The last hit is at byte 20 but UTF-16 offset 19 (é is 2 bytes, 1 unit).
        assert_eq!(b.ranges, [(0, 5), (19, 24)]);
        assert_eq!(done.files, 2);
        assert_eq!(done.matches, 4);
    }

    #[test]
    fn case_word_regex_and_include() {
        let d = fixture();
        let mut r = req(d.path(), "Hello");
        r.match_case = true;
        r.exclude = "node_modules".into();
        assert_eq!(search(&r).1.matches, 1);

        let mut r = req(d.path(), r"h\w+o\b");
        r.is_regex = true;
        r.include = "*.md".into();
        let (files, _) = search(&r);
        assert_eq!(files.len(), 1);
        // Rust's \w is Unicode-aware, so "héllo" matches too.
        assert_eq!(files[0].matches[0].ranges.len(), 3);

        let mut r = req(d.path(), "hell");
        r.whole_word = true;
        assert_eq!(search(&r).1.matches, 0);
    }

    #[test]
    fn invalid_regex_reported() {
        let d = fixture();
        let mut r = req(d.path(), "(unclosed");
        r.is_regex = true;
        assert!(build_matcher(&r).is_err());
        assert!(build_regex(&r).is_err());
    }

    #[test]
    fn dbg_hidden_root() {
        let d = fixture();
        let r = req(d.path(), "hello");
        let (_, done) = search(&r);
        eprintln!("ROOT {:?} searched={}", d.path(), done.searched_files);
        let d2 = tempfile::Builder::new().prefix("plain").tempdir().unwrap();
        fs::write(d2.path().join("a.txt"), "hello").unwrap();
        let (_, done) = search(&req(d2.path(), "hello"));
        eprintln!("ROOT {:?} searched={}", d2.path(), done.searched_files);
    }

    #[test]
    fn cancel_stops_search() {
        let d = fixture();
        let r = req(d.path(), "hello");
        let m = build_matcher(&r).unwrap();
        let done = run(&r, &m, 1, &|| true, &|_| panic!("no results after cancel")).unwrap();
        assert!(done.cancelled);
    }

    #[test]
    fn long_lines_get_a_preview_window() {
        let long = format!("{}needle{}", "x".repeat(1000), "y".repeat(1000));
        let m = build_matcher(&SearchRequest { query: "needle".into(), ..req(Path::new("."), "") }).unwrap();
        let lm = line_match(&m, 7, long.as_bytes()).unwrap();
        assert_eq!(lm.preview_start, 1000 - PREVIEW_LEAD as u32);
        assert_eq!(lm.ranges, [(1000, 1006)]);
        assert!(lm.text.len() <= PREVIEW_LEN + 1);
        assert!(lm.text.contains("needle"));
    }

    #[test]
    fn replace_keeps_encoding_and_eol() {
        let d = tempfile::tempdir().unwrap();
        let utf16 = d.path().join("u.txt");
        fs::write(&utf16, file_io::encode("foo bar\nfoo", "UTF-16LE", true, file_io::Eol::Crlf).unwrap()).unwrap();
        let plain = d.path().join("p.txt");
        fs::write(&plain, "food foo\n").unwrap();

        let mut r = req(d.path(), "foo");
        r.whole_word = true;
        let paths = [utf16.to_string_lossy().into_owned(), plain.to_string_lossy().into_owned()];
        let s = replace_in_files(&r, "$1baz", &paths).unwrap();
        assert_eq!(s.replacements, 3);
        assert_eq!(s.changed_files.len(), 2);
        let u = file_io::decode(&fs::read(&utf16).unwrap());
        assert_eq!((u.content.as_str(), u.encoding.name(), u.has_bom), ("$1baz bar\r\n$1baz", "UTF-16LE", true));
        assert_eq!(fs::read_to_string(&plain).unwrap(), "food $1baz\n", "literal mode doesn't expand $1");

        let mut r = req(d.path(), r"(\w+) bar");
        r.is_regex = true;
        replace_in_files(&r, "bar ${1}", &paths[..1]).unwrap();
        // `\w+` matches "1baz" (digits are word chars) but not the '$'.
        assert_eq!(file_io::decode(&fs::read(&utf16).unwrap()).content, "$bar 1baz\r\n$1baz");
    }
}
