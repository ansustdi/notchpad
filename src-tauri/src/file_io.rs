use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Files above this size are refused until big-file mode exists.
pub const MAX_EDITOR_FILE_SIZE: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum Eol {
    #[serde(rename = "LF")]
    Lf,
    #[serde(rename = "CRLF")]
    Crlf,
}

impl Eol {
    fn as_str(self) -> &'static str {
        match self {
            Eol::Lf => "\n",
            Eol::Crlf => "\r\n",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub path: String,
    pub name: String,
    pub content: String,
    pub encoding: String,
    pub has_bom: bool,
    pub eol: Eol,
    pub size: u64,
    pub had_errors: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub path: String,
    pub content: String,
    pub encoding: String,
    pub has_bom: bool,
    pub eol: Eol,
}

pub struct Decoded {
    pub content: String,
    pub encoding: &'static Encoding,
    pub has_bom: bool,
    pub had_errors: bool,
}

pub fn decode(bytes: &[u8]) -> Decoded {
    if let Some((enc, bom_len)) = Encoding::for_bom(bytes) {
        let (text, had_errors) = enc.decode_without_bom_handling(&bytes[bom_len..]);
        return Decoded { content: text.into_owned(), encoding: enc, has_bom: true, had_errors };
    }
    // NUL-heavy UTF-16 is also valid UTF-8, so check it first.
    let enc = if let Some(enc) = guess_utf16_without_bom(bytes) {
        enc
    } else if let Ok(text) = std::str::from_utf8(bytes) {
        return Decoded { content: text.to_owned(), encoding: UTF_8, has_bom: false, had_errors: false };
    } else {
        let mut det = chardetng::EncodingDetector::new();
        det.feed(bytes, true);
        det.guess(None, true)
    };
    let (text, had_errors) = enc.decode_without_bom_handling(bytes);
    Decoded { content: text.into_owned(), encoding: enc, has_bom: false, had_errors }
}

/// Binary (not text) judging by the first bytes: NULs that aren't UTF-16 / UTF-32 text.
pub fn looks_binary(head: &[u8]) -> bool {
    if Encoding::for_bom(head).is_some() || head.starts_with(&[0xFF, 0xFE, 0, 0]) || head.starts_with(&[0, 0, 0xFE, 0xFF]) {
        return false;
    }
    head.contains(&0) && guess_utf16_without_bom(head).is_none()
}

/// The first 8 KB of `path` look binary.
pub fn file_looks_binary(path: &Path) -> bool {
    let mut head = [0u8; 8192];
    let Ok(mut f) = fs::File::open(path) else { return false };
    let mut n = 0;
    while n < head.len() {
        match std::io::Read::read(&mut f, &mut head[n..]) {
            Ok(0) | Err(_) => break,
            Ok(k) => n += k,
        }
    }
    looks_binary(&head[..n])
}

/// BOM-less UTF-16 is common on Windows; detect it by NUL byte placement in ASCII-heavy text.
fn guess_utf16_without_bom(bytes: &[u8]) -> Option<&'static Encoding> {
    let sample = &bytes[..bytes.len().min(4096) & !1];
    if sample.len() < 4 {
        return None;
    }
    let pairs = sample.len() / 2;
    let even_nul = sample.iter().step_by(2).filter(|b| **b == 0).count();
    let odd_nul = sample.iter().skip(1).step_by(2).filter(|b| **b == 0).count();
    if odd_nul * 10 > pairs * 7 && even_nul * 10 < pairs {
        Some(UTF_16LE)
    } else if even_nul * 10 > pairs * 7 && odd_nul * 10 < pairs {
        Some(UTF_16BE)
    } else {
        None
    }
}

pub fn detect_eol(text: &str) -> Eol {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    if crlf > lf {
        Eol::Crlf
    } else if lf == 0 && crlf == 0 && cfg!(windows) {
        Eol::Crlf
    } else {
        Eol::Lf
    }
}

pub fn encode(content: &str, encoding_name: &str, has_bom: bool, eol: Eol) -> Result<Vec<u8>, String> {
    let enc = Encoding::for_label(encoding_name.as_bytes())
        .ok_or_else(|| format!("Unknown encoding: {encoding_name}"))?;
    let normalized = content.replace("\r\n", "\n");
    let text = if eol == Eol::Lf { normalized } else { normalized.replace('\n', eol.as_str()) };
    encode_text(&text, enc, has_bom)
}

/// Encode text as-is (line endings untouched).
pub fn encode_text(text: &str, enc: &'static Encoding, has_bom: bool) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(text.len() + 3);
    if enc == UTF_16LE || enc == UTF_16BE {
        // encoding_rs only decodes UTF-16, so encode it by hand.
        let le = enc == UTF_16LE;
        if has_bom {
            out.extend_from_slice(if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
        }
        for unit in text.encode_utf16() {
            out.extend_from_slice(&if le { unit.to_le_bytes() } else { unit.to_be_bytes() });
        }
        return Ok(out);
    }
    if has_bom && enc == UTF_8 {
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    let (bytes, _, unmappable) = enc.encode(text);
    if unmappable {
        return Err(format!("Some characters cannot be represented in {}", enc.name()));
    }
    out.extend_from_slice(&bytes);
    Ok(out)
}

/// Write to a sibling temp file then rename, so a crash never leaves a half-written file.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp: PathBuf = dir.join(format!(".{file_name}.{}.tmp", std::process::id()));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    if let Ok(meta) = fs::metadata(path) {
        let _ = fs::set_permissions(&tmp, meta.permissions());
    }
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// Decode with a user-chosen encoding ("Reopen with Encoding"), skipping a matching BOM.
pub fn decode_as(bytes: &[u8], label: &str) -> Result<Decoded, String> {
    let enc = Encoding::for_label(label.as_bytes()).ok_or_else(|| format!("Unknown encoding: {label}"))?;
    let bom_len = match Encoding::for_bom(bytes) {
        Some((bom_enc, len)) if bom_enc == enc => len,
        _ => 0,
    };
    let (text, had_errors) = enc.decode_without_bom_handling(&bytes[bom_len..]);
    Ok(Decoded { content: text.into_owned(), encoding: enc, has_bom: bom_len > 0, had_errors })
}

pub fn open(path: &str, forced_encoding: Option<&str>) -> Result<OpenedFile, String> {
    let p = Path::new(path);
    let meta = fs::metadata(p).map_err(|e| format!("{path}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("{path} is a directory"));
    }
    if meta.len() > MAX_EDITOR_FILE_SIZE {
        return Err(format!(
            "{path} is {} MB. Files over {} MB need big-file mode (not implemented yet).",
            meta.len() / 1024 / 1024,
            MAX_EDITOR_FILE_SIZE / 1024 / 1024
        ));
    }
    let bytes = fs::read(p).map_err(|e| format!("{path}: {e}"))?;
    let decoded = match forced_encoding {
        Some(label) => decode_as(&bytes, label)?,
        None => decode(&bytes),
    };
    Ok(OpenedFile {
        path: path.to_owned(),
        name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_owned()),
        eol: detect_eol(&decoded.content),
        encoding: decoded.encoding.name().to_owned(),
        has_bom: decoded.has_bom,
        had_errors: decoded.had_errors,
        content: decoded.content,
        size: meta.len(),
    })
}

pub fn save(req: &SaveRequest) -> Result<(), String> {
    let bytes = encode(&req.content, &req.encoding, req.has_bom, req.eol)?;
    atomic_write(Path::new(&req.path), &bytes).map_err(|e| format!("{}: {e}", req.path))
}

/// Largest image the Markdown preview inlines.
const MAX_IMAGE_SIZE: u64 = 20 * 1024 * 1024;

/// `path` as a `data:` URL. Only image types, so this can't be used to read arbitrary files.
pub fn image_data_url(path: &Path) -> Result<String, String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => return Err(format!("not an image: {}", path.display())),
    };
    let len = fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?.len();
    if len > MAX_IMAGE_SIZE {
        return Err(format!("image too large: {}", path.display()));
    }
    let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(format!("data:{mime};base64,{}", base64(&bytes)))
}

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn binary_detection() {
        assert!(looks_binary(b"MZ\x90\x00\x03\x00\x00\x00"));
        assert!(!looks_binary(b"plain text\r\n"));
        assert!(!looks_binary(b"h\x00e\x00l\x00l\x00o\x00 \x00w\x00o\x00r\x00l\x00d\x00"));
        assert!(!looks_binary(b"\xFF\xFEh\x00i\x00"));
        assert!(!looks_binary(b""));
    }

    #[test]
    fn image_data_url_rejects_non_images() {
        assert!(image_data_url(Path::new("Cargo.toml")).is_err());
    }

    #[test]
    fn utf8_plain_and_bom() {
        let d = decode("héllo".as_bytes());
        assert_eq!(d.encoding, UTF_8);
        assert!(!d.has_bom);
        let d = decode(b"\xEF\xBB\xBFhi");
        assert_eq!((d.content.as_str(), d.has_bom), ("hi", true));
    }

    #[test]
    fn utf16_roundtrip_with_and_without_bom() {
        // BOM-less detection is a heuristic for ASCII-heavy text, so test it with that.
        for (bom, text) in [(true, "Привет\nworld"), (false, "hello\nworld é")] {
            let bytes = encode(text, "UTF-16LE", bom, Eol::Crlf).unwrap();
            let d = decode(&bytes);
            assert_eq!(d.encoding, UTF_16LE);
            assert_eq!(d.has_bom, bom);
            assert_eq!(d.content, text.replace('\n', "\r\n"));
        }
    }

    #[test]
    fn legacy_encoding_detected() {
        let (bytes, _, _) = encoding_rs::WINDOWS_1251.encode("Съешь же ещё этих мягких французских булок");
        let d = decode(&bytes);
        assert_eq!(d.encoding, encoding_rs::WINDOWS_1251);
        assert!(d.content.starts_with("Съешь"));
    }

    #[test]
    fn eol_detection_and_conversion() {
        assert_eq!(detect_eol("a\r\nb\r\nc\n"), Eol::Crlf);
        assert_eq!(detect_eol("a\nb\n"), Eol::Lf);
        assert_eq!(encode("a\r\nb\nc", "UTF-8", false, Eol::Lf).unwrap(), b"a\nb\nc");
        assert_eq!(encode("a\nb", "UTF-8", false, Eol::Crlf).unwrap(), b"a\r\nb");
    }

    #[test]
    fn forced_encoding_overrides_detection() {
        let (bytes, _, _) = encoding_rs::WINDOWS_1251.encode("Привет");
        assert_eq!(decode_as(&bytes, "windows-1251").unwrap().content, "Привет");
        let d = decode_as(b"\xEF\xBB\xBFhi", "utf-8").unwrap();
        assert_eq!((d.content.as_str(), d.has_bom), ("hi", true));
    }

    #[test]
    fn unmappable_chars_rejected() {
        assert!(encode("日本", "windows-1252", false, Eol::Lf).is_err());
    }

    #[test]
    fn save_and_reopen_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.txt");
        fs::write(&path, "old").unwrap();
        let req = SaveRequest {
            path: path.to_string_lossy().into_owned(),
            content: "new\ncontent".into(),
            encoding: "UTF-8".into(),
            has_bom: false,
            eol: Eol::Crlf,
        };
        save(&req).unwrap();
        let f = open(&req.path, None).unwrap();
        assert_eq!(f.content, "new\r\ncontent");
        assert_eq!(f.eol, Eol::Crlf);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "temp file left behind");
    }
}
