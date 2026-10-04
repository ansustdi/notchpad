//! Read-only viewer backend for files too big for the editor.
//!
//! No memory mapping: on Windows a mapped file can't be truncated or rotated by its writer,
//! which would break "follow" on live logs. Every read re-opens the file instead; the OS page
//! cache makes that cheap.

use crate::search::{self, SearchRequest};
use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use grep_matcher::LineTerminator;
use grep_regex::RegexMatcher;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use serde::Serialize;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

/// A checkpoint (byte offset of a line start) is kept every STRIDE lines.
pub const STRIDE: u64 = 1024;
/// Longest line prefix returned for display; the rest of the line is skipped.
pub const MAX_LINE_BYTES: usize = 16 * 1024;
const READ_CHUNK: usize = 1 << 20;
/// Lines per window when searching backwards.
const BACK_WINDOW_LINES: u64 = STRIDE * 64;

#[derive(Debug, Default)]
pub struct Index {
    /// checkpoints[k] = byte offset where line k*STRIDE starts (0-based lines).
    pub checkpoints: Vec<u64>,
    /// Newlines seen so far; line count = newlines + 1 once indexing is complete.
    pub newlines: u64,
    pub indexed_to: u64,
    pub size: u64,
}

pub struct BigFile {
    pub path: PathBuf,
    pub encoding: &'static Encoding,
    pub bom_len: u64,
    pub index: RwLock<Index>,
    pub indexing: AtomicBool,
    pub closed: AtomicBool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    /// Lines known so far (all lines when `complete`).
    pub lines: u64,
    pub indexed_bytes: u64,
    pub size: u64,
    pub complete: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinePage {
    pub start: u64,
    pub lines: Vec<String>,
    /// Indices (into `lines`) of lines cut at MAX_LINE_BYTES.
    pub truncated: Vec<u32>,
    pub status: IndexStatus,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    /// 0-based line.
    pub line: u64,
    /// UTF-16 [start, end) within the line.
    pub start: u32,
    pub end: u32,
    pub wrapped: bool,
}

fn sniff_encoding(sample: &[u8]) -> Result<(&'static Encoding, u64), String> {
    if let Some((enc, bom)) = Encoding::for_bom(sample) {
        if enc == UTF_16LE || enc == UTF_16BE {
            return Err("UTF-16 files are not supported in big-file mode yet".into());
        }
        return Ok((enc, bom as u64));
    }
    match std::str::from_utf8(sample) {
        Ok(_) => Ok((UTF_8, 0)),
        // Sample may end mid-character; that's still UTF-8.
        Err(e) if e.error_len().is_none() => Ok((UTF_8, 0)),
        Err(_) => {
            let mut det = chardetng::EncodingDetector::new();
            det.feed(sample, false);
            Ok((det.guess(None, true), 0))
        }
    }
}

impl BigFile {
    pub fn open(path: &Path) -> Result<BigFile, String> {
        let mut f = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let size = f.metadata().map_err(|e| e.to_string())?.len();
        let mut sample = vec![0; 64 * 1024];
        let n = f.read(&mut sample).map_err(|e| e.to_string())?;
        let (encoding, bom_len) = sniff_encoding(&sample[..n])?;
        Ok(BigFile {
            path: path.to_owned(),
            encoding,
            bom_len,
            index: RwLock::new(Index { checkpoints: vec![bom_len], newlines: 0, indexed_to: bom_len, size }),
            indexing: AtomicBool::new(false),
            closed: AtomicBool::new(false),
        })
    }

    pub fn status(&self) -> IndexStatus {
        let ix = self.index.read().unwrap();
        let complete = ix.indexed_to >= ix.size;
        IndexStatus {
            lines: ix.newlines + if complete { 1 } else { 0 },
            indexed_bytes: ix.indexed_to,
            size: ix.size,
            complete,
        }
    }

    /// Re-check the file size. Growth is indexed incrementally; shrinking (truncation or
    /// rotation) restarts the index. Returns true if the index was reset.
    pub fn refresh(&self) -> Result<bool, String> {
        let size = std::fs::metadata(&self.path).map_err(|e| e.to_string())?.len();
        let mut ix = self.index.write().unwrap();
        if size < ix.indexed_to {
            *ix = Index { checkpoints: vec![self.bom_len.min(size)], newlines: 0, indexed_to: self.bom_len.min(size), size };
            return Ok(true);
        }
        ix.size = size;
        Ok(false)
    }

    /// Index up to the current end of file, calling `progress` every chunk batch.
    /// Only one indexer runs at a time; extra calls return immediately.
    pub fn index_to_end(&self, progress: &dyn Fn(IndexStatus)) -> Result<(), String> {
        if self.indexing.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let result = self.index_loop(progress);
        self.indexing.store(false, Ordering::SeqCst);
        progress(self.status());
        result
    }

    fn index_loop(&self, progress: &dyn Fn(IndexStatus)) -> Result<(), String> {
        let mut f = File::open(&self.path).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; READ_CHUNK];
        let mut last_report = std::time::Instant::now();
        loop {
            if self.closed.load(Ordering::Relaxed) {
                return Ok(());
            }
            let (from, size) = {
                let ix = self.index.read().unwrap();
                (ix.indexed_to, ix.size)
            };
            if from >= size {
                return Ok(());
            }
            f.seek(SeekFrom::Start(from)).map_err(|e| e.to_string())?;
            let want = ((size - from) as usize).min(READ_CHUNK);
            let n = f.read(&mut buf[..want]).map_err(|e| e.to_string())?;
            if n == 0 {
                // File shrank under us; refresh() will reset on the next poll.
                let mut ix = self.index.write().unwrap();
                ix.size = ix.indexed_to;
                return Ok(());
            }
            let mut ix = self.index.write().unwrap();
            if ix.indexed_to != from {
                continue; // index was reset concurrently
            }
            for pos in memchr::memchr_iter(b'\n', &buf[..n]) {
                ix.newlines += 1;
                if ix.newlines % STRIDE == 0 {
                    ix.checkpoints.push(from + pos as u64 + 1);
                }
            }
            ix.indexed_to = from + n as u64;
            drop(ix);
            if last_report.elapsed().as_millis() >= 150 {
                progress(self.status());
                last_report = std::time::Instant::now();
            }
        }
    }

    /// Byte offset where 0-based `line` starts, if that line is indexed.
    pub fn line_start(&self, line: u64) -> Result<Option<u64>, String> {
        let (cp, skip, indexed_to) = {
            let ix = self.index.read().unwrap();
            let k = (line / STRIDE) as usize;
            if line > ix.newlines || k >= ix.checkpoints.len() {
                return Ok(None);
            }
            (ix.checkpoints[k], line % STRIDE, ix.indexed_to)
        };
        if skip == 0 {
            return Ok(Some(cp));
        }
        let mut r = BufReader::with_capacity(64 * 1024, File::open(&self.path).map_err(|e| e.to_string())?);
        r.seek(SeekFrom::Start(cp)).map_err(|e| e.to_string())?;
        let mut pos = cp;
        let mut left = skip;
        while left > 0 && pos < indexed_to {
            let buf = r.fill_buf().map_err(|e| e.to_string())?;
            if buf.is_empty() {
                return Ok(None);
            }
            let avail = buf.len().min((indexed_to - pos) as usize);
            let mut consumed = avail;
            for i in memchr::memchr_iter(b'\n', &buf[..avail]) {
                left -= 1;
                if left == 0 {
                    consumed = i + 1;
                    break;
                }
            }
            pos += consumed as u64;
            r.consume(consumed);
        }
        Ok(if left == 0 { Some(pos) } else { None })
    }

    fn decode_line(&self, raw: &[u8]) -> String {
        let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
        self.encoding.decode_without_bom_handling(raw).0.into_owned()
    }

    pub fn lines(&self, start: u64, count: u64) -> Result<LinePage, String> {
        let status = self.status();
        let mut page = LinePage { start, lines: Vec::new(), truncated: Vec::new(), status };
        let Some(offset) = self.line_start(start)? else { return Ok(page) };
        let end = page.status.lines.min(start + count);
        let mut r = BufReader::with_capacity(256 * 1024, File::open(&self.path).map_err(|e| e.to_string())?);
        r.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        // While indexing, `lines` counts only complete lines, so the last one is never partial.
        for _ in start..end {
            match read_line_capped(&mut r, MAX_LINE_BYTES).map_err(|e| e.to_string())? {
                Some((raw, truncated)) => {
                    if truncated {
                        page.truncated.push(page.lines.len() as u32);
                    }
                    page.lines.push(self.decode_line(&raw));
                }
                // File ends with '\n': the final (empty) line has no bytes.
                None => page.lines.push(String::new()),
            }
        }
        Ok(page)
    }

    /// Call `on(line, ranges)` for matched lines in [start_line, end_line] (or to EOF),
    /// until it returns false.
    fn scan(
        &self,
        matcher: &RegexMatcher,
        start_line: u64,
        end_line: Option<u64>,
        on: &mut dyn FnMut(u64, Vec<(u32, u32)>) -> bool,
    ) -> Result<(), String> {
        let Some(offset) = self.line_start(start_line)? else { return Ok(()) };
        let mut f = File::open(&self.path).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        // Only read up to the end of `end_line` so windowed searches stay proportional to the window.
        let limit = match end_line {
            Some(l) => self.line_start(l + 1)?.map(|end| end - offset),
            None => None,
        };
        let f = f.take(limit.unwrap_or(u64::MAX));
        let mut searcher = SearcherBuilder::new()
            .binary_detection(BinaryDetection::none())
            .line_terminator(LineTerminator::crlf())
            .line_number(true)
            .build();
        let mut sink = ScanSink { matcher, enc: self.encoding, base: start_line, on };
        searcher.search_reader(matcher, f, &mut sink).map_err(|e| e.to_string())
    }

    pub fn find(&self, req: &SearchRequest, from_line: u64, from_col: u32, backwards: bool) -> Result<Option<Found>, String> {
        let matcher = search::build_matcher(req)?;
        if backwards {
            self.find_back(&matcher, from_line, from_col)
        } else {
            self.find_forward(&matcher, from_line, from_col)
        }
    }

    fn find_forward(&self, m: &RegexMatcher, from_line: u64, from_col: u32) -> Result<Option<Found>, String> {
        let mut hit = None;
        self.scan(m, from_line, None, &mut |line, ranges| {
            let first = ranges.into_iter().find(|&(s, _)| line > from_line || s >= from_col);
            if let Some((start, end)) = first {
                hit = Some(Found { line, start, end, wrapped: false });
                return false;
            }
            true
        })?;
        if hit.is_some() {
            return Ok(hit);
        }
        // Wrap to the top and stop once past the starting point.
        self.scan(m, 0, Some(from_line), &mut |line, ranges| {
            if line > from_line {
                return false;
            }
            if let Some(&(start, end)) = ranges.first() {
                hit = Some(Found { line, start, end, wrapped: true });
                return false;
            }
            true
        })?;
        Ok(hit)
    }

    /// Last match strictly before (line, col) within lines [lo, hi].
    fn last_before(&self, m: &RegexMatcher, lo: u64, hi: u64, line_lim: u64, col_lim: u32) -> Result<Option<Found>, String> {
        let mut hit = None;
        self.scan(m, lo, Some(hi), &mut |line, ranges| {
            if line > hi || line > line_lim {
                return false;
            }
            let last = ranges.into_iter().filter(|&(s, _)| line < line_lim || s < col_lim).last();
            if let Some((start, end)) = last {
                hit = Some(Found { line, start, end, wrapped: false });
            }
            true
        })?;
        Ok(hit)
    }

    fn find_back(&self, m: &RegexMatcher, from_line: u64, from_col: u32) -> Result<Option<Found>, String> {
        let mut hi = from_line;
        loop {
            let lo = hi.saturating_sub(BACK_WINDOW_LINES);
            if let Some(f) = self.last_before(m, lo, hi, from_line, from_col)? {
                return Ok(Some(f));
            }
            if lo == 0 {
                break;
            }
            hi = lo - 1;
        }
        // Wrap: search down from the end of the file to the starting line.
        let last_line = self.status().lines.saturating_sub(1);
        let mut hi = last_line;
        while hi >= from_line {
            let lo = hi.saturating_sub(BACK_WINDOW_LINES).max(from_line);
            if let Some(mut f) = self.last_before(m, lo, hi, u64::MAX, u32::MAX)? {
                f.wrapped = true;
                return Ok(Some(f));
            }
            if lo == from_line || lo == 0 {
                break;
            }
            hi = lo - 1;
        }
        Ok(None)
    }
}

/// Read one line (without '\n'), keeping at most `cap` bytes. None at EOF.
fn read_line_capped(r: &mut impl BufRead, cap: usize) -> std::io::Result<Option<(Vec<u8>, bool)>> {
    let mut out = Vec::new();
    let mut truncated = false;
    let mut any = false;
    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() {
            return Ok(any.then_some((out, truncated)));
        }
        any = true;
        let (chunk, done, used) = match memchr::memchr(b'\n', buf) {
            Some(i) => (&buf[..i], true, i + 1),
            None => (buf, false, buf.len()),
        };
        let room = cap.saturating_sub(out.len());
        if chunk.len() > room {
            truncated = true;
        }
        out.extend_from_slice(&chunk[..chunk.len().min(room)]);
        r.consume(used);
        if done {
            return Ok(Some((out, truncated)));
        }
    }
}

struct ScanSink<'a> {
    matcher: &'a RegexMatcher,
    enc: &'static Encoding,
    base: u64,
    on: &'a mut dyn FnMut(u64, Vec<(u32, u32)>) -> bool,
}

impl Sink for ScanSink<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, _: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        let line = self.base + mat.line_number().unwrap_or(1) - 1;
        let ranges = search::match_ranges(self.matcher, mat.bytes(), self.enc);
        if ranges.is_empty() {
            return Ok(true);
        }
        Ok((self.on)(line, ranges))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn big(content: &[u8]) -> (tempfile::TempDir, BigFile) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("big.log");
        fs::write(&p, content).unwrap();
        let bf = BigFile::open(&p).unwrap();
        bf.index_to_end(&|_| {}).unwrap();
        (d, bf)
    }

    fn numbered(n: u64) -> String {
        (0..n).map(|i| format!("line {i}\n")).collect()
    }

    fn req(q: &str) -> SearchRequest {
        SearchRequest {
            root: String::new(),
            query: q.into(),
            is_regex: false,
            match_case: false,
            whole_word: false,
            include: String::new(),
            exclude: String::new(),
        }
    }

    #[test]
    fn index_and_page_lines_across_checkpoints() {
        let (_d, bf) = big(numbered(5000).as_bytes());
        let st = bf.status();
        assert!(st.complete);
        assert_eq!(st.lines, 5001, "trailing newline gives a final empty line");
        assert_eq!(bf.index.read().unwrap().checkpoints.len(), 5); // 0,1024,2048,3072,4096
        let p = bf.lines(1020, 10).unwrap();
        assert_eq!(p.lines[0], "line 1020");
        assert_eq!(p.lines[9], "line 1029");
        let p = bf.lines(4998, 10).unwrap();
        assert_eq!(p.lines, ["line 4998", "line 4999", ""]);
        assert!(bf.lines(9999, 5).unwrap().lines.is_empty());
    }

    #[test]
    fn crlf_bom_and_long_lines() {
        let mut data = b"\xEF\xBB\xBFfirst\r\n".to_vec();
        data.extend(vec![b'x'; MAX_LINE_BYTES * 3]);
        data.extend(b"\r\nlast");
        let (_d, bf) = big(&data);
        let p = bf.lines(0, 5).unwrap();
        assert_eq!(p.lines.len(), 3);
        assert_eq!(p.lines[0], "first");
        assert_eq!(p.lines[1].len(), MAX_LINE_BYTES);
        assert_eq!(p.truncated, [1]);
        assert_eq!(p.lines[2], "last");
    }

    #[test]
    fn legacy_encoding_lines() {
        let (bytes, _, _) = encoding_rs::WINDOWS_1251.encode("Привет мир\nвторая строка\n");
        let (_d, bf) = big(&bytes);
        assert_eq!(bf.encoding, encoding_rs::WINDOWS_1251);
        assert_eq!(bf.lines(1, 1).unwrap().lines, ["вторая строка"]);
    }

    #[test]
    fn find_forward_backward_and_wrap() {
        let mut s = numbered(3000);
        s = s.replace("line 10\n", "line 10 needle\n").replace("line 2500\n", "needle line 2500\n");
        let (_d, bf) = big(s.as_bytes());
        let r = req("needle");
        let f = bf.find(&r, 0, 0, false).unwrap().unwrap();
        assert_eq!((f.line, f.start, f.end, f.wrapped), (10, 8, 14, false));
        let f = bf.find(&r, 10, 9, false).unwrap().unwrap();
        assert_eq!((f.line, f.start, f.wrapped), (2500, 0, false));
        let f = bf.find(&r, 2500, 1, false).unwrap().unwrap();
        assert_eq!((f.line, f.wrapped), (10, true));

        let f = bf.find(&r, 2000, 0, true).unwrap().unwrap();
        assert_eq!((f.line, f.wrapped), (10, false));
        let f = bf.find(&r, 5, 0, true).unwrap().unwrap();
        assert_eq!((f.line, f.wrapped), (2500, true));
        assert!(bf.find(&req("absent"), 0, 0, false).unwrap().is_none());
    }

    #[test]
    fn follow_growth_and_truncation() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("live.log");
        fs::write(&p, "a\nb\n").unwrap();
        let bf = BigFile::open(&p).unwrap();
        bf.index_to_end(&|_| {}).unwrap();
        assert_eq!(bf.status().lines, 3);

        fs::write(&p, "a\nb\nc\nd\n").unwrap();
        assert!(!bf.refresh().unwrap());
        bf.index_to_end(&|_| {}).unwrap();
        assert_eq!(bf.status().lines, 5);
        assert_eq!(bf.lines(2, 2).unwrap().lines, ["c", "d"]);

        fs::write(&p, "new\n").unwrap();
        assert!(bf.refresh().unwrap(), "shrink resets the index");
        bf.index_to_end(&|_| {}).unwrap();
        assert_eq!(bf.lines(0, 5).unwrap().lines, ["new", ""]);
    }

    /// `BIGFILE_BENCH=path cargo test --release bench_big -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_big() {
        let Ok(path) = std::env::var("BIGFILE_BENCH") else { return };
        let t = std::time::Instant::now();
        let bf = BigFile::open(Path::new(&path)).unwrap();
        bf.index_to_end(&|_| {}).unwrap();
        let st = bf.status();
        eprintln!("BENCH index {} lines / {} MB in {:?}", st.lines, st.size >> 20, t.elapsed());
        let t = std::time::Instant::now();
        let p = bf.lines(st.lines / 2, 200).unwrap();
        eprintln!("BENCH page of {} lines at middle in {:?}", p.lines.len(), t.elapsed());
        let t = std::time::Instant::now();
        let f = bf.find(&req("no-such-text-anywhere"), 0, 0, false).unwrap();
        eprintln!("BENCH full-file find (miss, {:?}) in {:?}", f, t.elapsed());
        let t = std::time::Instant::now();
        let f = bf.find(&req("ERROR"), st.lines / 2, 0, true).unwrap();
        eprintln!("BENCH backward find {:?} in {:?}", f.map(|f| f.line), t.elapsed());
    }

    #[test]
    fn rejects_utf16() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("u.txt");
        fs::write(&p, b"\xFF\xFEa\x00").unwrap();
        assert!(BigFile::open(&p).is_err());
    }
}
