//! Binary documents for the hex editor: a piece table over the file on disk plus an append-only
//! buffer of typed bytes, so files of any size open instantly and inserts / deletes are cheap.

use digest::Digest;
use serde::Serialize;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq)]
enum Src {
    File,
    Add,
}

#[derive(Clone, Copy, Debug)]
struct Piece {
    src: Src,
    start: u64,
    len: u64,
}

pub struct HexDoc {
    pub path: Option<PathBuf>,
    file: Option<File>,
    add: Vec<u8>,
    pieces: Vec<Piece>,
    len: u64,
}

/// Bytes are read and hashed in chunks of this size.
const CHUNK: usize = 1 << 20;

impl HexDoc {
    /// Open `path`, or start an empty document.
    pub fn open(path: Option<&Path>) -> Result<HexDoc, String> {
        let mut doc = HexDoc { path: None, file: None, add: Vec::new(), pieces: Vec::new(), len: 0 };
        if let Some(p) = path {
            doc.attach(p)?;
        }
        Ok(doc)
    }

    /// Make `path` the document's backing file, with no edits on top.
    fn attach(&mut self, path: &Path) -> Result<(), String> {
        let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let len = file.metadata().map_err(|e| e.to_string())?.len();
        self.path = Some(path.to_owned());
        self.file = Some(file);
        self.add.clear();
        self.pieces = if len > 0 { vec![Piece { src: Src::File, start: 0, len }] } else { Vec::new() };
        self.len = len;
        Ok(())
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    fn read_piece(&mut self, p: Piece, from: u64, out: &mut [u8]) -> Result<(), String> {
        match p.src {
            Src::Add => {
                let s = (p.start + from) as usize;
                out.copy_from_slice(&self.add[s..s + out.len()]);
            }
            Src::File => {
                let f = self.file.as_mut().ok_or("file is closed")?;
                f.seek(SeekFrom::Start(p.start + from)).map_err(|e| e.to_string())?;
                f.read_exact(out).map_err(|e| format!("read failed (file changed on disk?): {e}"))?;
            }
        }
        Ok(())
    }

    /// Up to `len` bytes starting at `offset`.
    pub fn read(&mut self, offset: u64, len: u64) -> Result<Vec<u8>, String> {
        let end = (offset.saturating_add(len)).min(self.len);
        if offset >= end {
            return Ok(Vec::new());
        }
        let mut out = vec![0u8; (end - offset) as usize];
        let mut pos = 0u64; // document offset of the current piece
        let mut written = 0usize;
        for i in 0..self.pieces.len() {
            let p = self.pieces[i];
            let (ps, pe) = (pos, pos + p.len);
            pos = pe;
            if pe <= offset {
                continue;
            }
            if ps >= end {
                break;
            }
            let from = offset.max(ps) - ps;
            let to = end.min(pe) - ps;
            let n = (to - from) as usize;
            self.read_piece(p, from, &mut out[written..written + n])?;
            written += n;
        }
        Ok(out)
    }

    /// Split so that a piece boundary falls at `offset`; returns the index of the piece starting there.
    fn split_at(&mut self, offset: u64) -> usize {
        let mut pos = 0u64;
        for i in 0..self.pieces.len() {
            let p = self.pieces[i];
            if pos == offset {
                return i;
            }
            if offset < pos + p.len {
                let left = offset - pos;
                self.pieces[i].len = left;
                self.pieces.insert(i + 1, Piece { src: p.src, start: p.start + left, len: p.len - left });
                return i + 1;
            }
            pos += p.len;
        }
        self.pieces.len()
    }

    /// Replace `del` bytes at `offset` with `ins` (overwrite, insert and delete are all this).
    /// Returns the bytes removed (what undo needs), or None when more than `keep_limit` went.
    pub fn replace(&mut self, offset: u64, del: u64, ins: &[u8], keep_limit: u64) -> Result<Option<Vec<u8>>, String> {
        if offset > self.len {
            return Err(format!("offset {offset} is past the end ({})", self.len));
        }
        let del = del.min(self.len - offset);
        let removed = if del <= keep_limit { Some(self.read(offset, del)?) } else { None };
        let a = self.split_at(offset);
        let b = self.split_at(offset + del);
        self.pieces.drain(a..b);
        if !ins.is_empty() {
            let start = self.add.len() as u64;
            self.add.extend_from_slice(ins);
            let piece = Piece { src: Src::Add, start, len: ins.len() as u64 };
            // Typing appends right after the previous piece: grow it instead of adding one.
            match a.checked_sub(1).map(|i| &mut self.pieces[i]) {
                Some(prev) if prev.src == Src::Add && prev.start + prev.len == start => prev.len += piece.len,
                _ => self.pieces.insert(a, piece),
            }
        }
        self.len = self.len - del + ins.len() as u64;
        Ok(removed)
    }

    /// Feed `[offset, offset+len)` to `f` in chunks.
    fn each_chunk(&mut self, offset: u64, len: u64, mut f: impl FnMut(&[u8])) -> Result<(), String> {
        let end = offset.saturating_add(len).min(self.len);
        let mut pos = offset;
        while pos < end {
            let n = (end - pos).min(CHUNK as u64);
            let buf = self.read(pos, n)?;
            f(&buf);
            pos += n;
        }
        Ok(())
    }

    /// Write the document to `path` atomically (temp file + rename) and reopen from there.
    pub fn save(&mut self, path: &Path) -> Result<(), String> {
        let dir = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
        let result = (|| {
            let mut out = std::io::BufWriter::new(File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?);
            let mut err = None;
            self.each_chunk(0, self.len, |chunk| {
                if err.is_none() {
                    err = out.write_all(chunk).err();
                }
            })?;
            if let Some(e) = err {
                return Err(e.to_string());
            }
            let f = out.into_inner().map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
            drop(f);
            let perms = fs::metadata(path).ok().map(|m| m.permissions());
            // Our own handle on the old file must not block the rename (Windows).
            self.file = None;
            fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))?;
            // After the rename: a read-only temp file couldn't be cleaned up if the rename failed.
            if let Some(p) = perms {
                let _ = fs::set_permissions(path, p);
            }
            Ok(())
        })();
        if let Err(e) = result {
            let _ = fs::remove_file(&tmp);
            // Keep reading the original if the rename never happened.
            if self.file.is_none() {
                if let Some(p) = self.path.clone() {
                    self.file = File::open(p).ok();
                }
            }
            return Err(e);
        }
        self.attach(path)
    }

    /// First match of `pattern` at or after `from` (or the last one before `from` when `backwards`).
    pub fn find(&mut self, pattern: &[u8], from: u64, backwards: bool, ignore_case: bool) -> Result<Option<u64>, String> {
        if pattern.is_empty() || pattern.len() as u64 > self.len {
            return Ok(None);
        }
        let fold = |b: &[u8]| -> Vec<u8> { if ignore_case { b.to_ascii_lowercase() } else { b.to_vec() } };
        let needle = fold(pattern);
        let plen = needle.len() as u64;
        let overlap = plen - 1;
        if !backwards {
            let mut pos = from.min(self.len);
            while pos + plen <= self.len {
                let n = (CHUNK as u64 + overlap).min(self.len - pos);
                let hay = fold(&self.read(pos, n)?);
                if let Some(i) = memchr::memmem::find(&hay, &needle) {
                    return Ok(Some(pos + i as u64));
                }
                if pos + n >= self.len {
                    break;
                }
                pos += n - overlap;
            }
        } else {
            // Matches must start before `from`.
            let mut end = (from + overlap).min(self.len);
            while end >= plen {
                let start = end.saturating_sub(CHUNK as u64 + overlap);
                let hay = fold(&self.read(start, end - start)?);
                if let Some(i) = memchr::memmem::rfind(&hay, &needle) {
                    let at = start + i as u64;
                    if at < from {
                        return Ok(Some(at));
                    }
                }
                if start == 0 {
                    break;
                }
                end = start + overlap;
            }
        }
        Ok(None)
    }

    pub fn checksums(&mut self, offset: u64, len: u64) -> Result<Vec<Checksum>, String> {
        let mut crc = crc32fast::Hasher::new();
        let mut md5 = md5::Md5::new();
        let mut sha1 = sha1::Sha1::new();
        let mut sha256 = sha2::Sha256::new();
        let mut sha512 = sha2::Sha512::new();
        let mut sum8 = 0u8;
        self.each_chunk(offset, len, |c| {
            crc.update(c);
            md5.update(c);
            sha1.update(c);
            sha256.update(c);
            sha512.update(c);
            sum8 = c.iter().fold(sum8, |a, &b| a.wrapping_add(b));
        })?;
        let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02X}")).collect::<String>();
        Ok(vec![
            Checksum { name: "Checksum-8", value: format!("{sum8:02X}") },
            Checksum { name: "CRC-32", value: format!("{:08X}", crc.finalize()) },
            Checksum { name: "MD5", value: hex(&md5.finalize()) },
            Checksum { name: "SHA-1", value: hex(&sha1.finalize()) },
            Checksum { name: "SHA-256", value: hex(&sha256.finalize()) },
            Checksum { name: "SHA-512", value: hex(&sha512.finalize()) },
        ])
    }
}

#[derive(Serialize)]
pub struct Checksum {
    pub name: &'static str,
    pub value: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc_with(bytes: &[u8]) -> (tempfile::TempDir, HexDoc) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.bin");
        fs::write(&p, bytes).unwrap();
        let doc = HexDoc::open(Some(&p)).unwrap();
        (dir, doc)
    }

    fn all(doc: &mut HexDoc) -> Vec<u8> {
        doc.read(0, doc.len()).unwrap()
    }

    #[test]
    fn overwrite_insert_delete_and_undo() {
        let (_d, mut doc) = doc_with(b"0123456789");
        assert_eq!(doc.replace(2, 2, b"ab", u64::MAX).unwrap().unwrap(), b"23");
        assert_eq!(all(&mut doc), b"01ab456789");
        assert_eq!(doc.replace(5, 0, b"XYZ", u64::MAX).unwrap().unwrap(), b"");
        assert_eq!(all(&mut doc), b"01ab4XYZ56789");
        assert_eq!(doc.replace(0, 3, b"", u64::MAX).unwrap().unwrap(), b"01a");
        assert_eq!(all(&mut doc), b"b4XYZ56789");
        assert_eq!(doc.len(), 10);
        // Undo in reverse order with the returned bytes.
        doc.replace(0, 0, b"01a", u64::MAX).unwrap();
        doc.replace(5, 3, b"", u64::MAX).unwrap();
        doc.replace(2, 2, b"23", u64::MAX).unwrap();
        assert_eq!(all(&mut doc), b"0123456789");
        assert_eq!(doc.read(8, 100).unwrap(), b"89");
        assert!(doc.read(10, 5).unwrap().is_empty());
        // Over the limit nothing is kept, but the edit still happens.
        assert_eq!(doc.replace(0, 10, b"", 4).unwrap(), None);
        assert_eq!(doc.len(), 0);
    }

    #[test]
    fn sequential_typing_reuses_one_piece() {
        let (_d, mut doc) = doc_with(b"");
        for (i, b) in b"hello".iter().enumerate() {
            doc.replace(i as u64, 0, &[*b], u64::MAX).unwrap();
        }
        assert_eq!(all(&mut doc), b"hello");
        assert_eq!(doc.pieces.len(), 1);
    }

    #[test]
    fn save_writes_edits_and_reopens() {
        let (dir, mut doc) = doc_with(b"abcdef");
        doc.replace(3, 0, b"--", u64::MAX).unwrap();
        let p = dir.path().join("a.bin");
        doc.save(&p).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"abc--def");
        assert_eq!(doc.pieces.len(), 1);
        doc.replace(0, 1, b"A", u64::MAX).unwrap();
        doc.save(&dir.path().join("b.bin")).unwrap();
        assert_eq!(fs::read(dir.path().join("b.bin")).unwrap(), b"Abc--def");
        assert_eq!(fs::read(&p).unwrap(), b"abc--def");
    }

    #[test]
    fn find_both_directions_across_chunks() {
        let mut data = vec![0u8; CHUNK * 2 + 10];
        data[5..8].copy_from_slice(b"KEY");
        data[CHUNK - 1..CHUNK + 2].copy_from_slice(b"KEY"); // straddles a chunk boundary
        let (_d, mut doc) = doc_with(&data);
        assert_eq!(doc.find(b"KEY", 0, false, false).unwrap(), Some(5));
        assert_eq!(doc.find(b"KEY", 6, false, false).unwrap(), Some(CHUNK as u64 - 1));
        assert_eq!(doc.find(b"key", 6, false, true).unwrap(), Some(CHUNK as u64 - 1));
        assert_eq!(doc.find(b"KEY", CHUNK as u64, false, false).unwrap(), None);
        assert_eq!(doc.find(b"KEY", data.len() as u64, true, false).unwrap(), Some(CHUNK as u64 - 1));
        assert_eq!(doc.find(b"KEY", CHUNK as u64 - 1, true, false).unwrap(), Some(5));
        assert_eq!(doc.find(b"KEY", 5, true, false).unwrap(), None);
    }

    #[test]
    fn checksums_of_known_input() {
        let (_d, mut doc) = doc_with(b"abc");
        let sums = doc.checksums(0, 3).unwrap();
        let get = |n: &str| sums.iter().find(|c| c.name == n).unwrap().value.clone();
        assert_eq!(get("CRC-32"), "352441C2");
        assert_eq!(get("MD5"), "900150983CD24FB0D6963F7D28E17F72");
        assert_eq!(get("SHA-256"), "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD");
    }
}
