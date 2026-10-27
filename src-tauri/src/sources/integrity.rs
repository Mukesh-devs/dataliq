//! Integrity check for gzip files. DuckDB stops quietly at an unexpected end
//! of a gzip stream (see docs/DECISIONS.md, D12), so imports verify the whole
//! stream (deflate data, CRC and length) themselves.

use std::fs::File;
use std::io::{self, BufReader, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// Reads the whole gzip file. `Ok(false)` if `stop` was set first.
pub fn verify_gzip(path: &Path, stop: &AtomicBool) -> io::Result<bool> {
    let file = BufReader::with_capacity(1 << 20, File::open(path)?);
    // Multi-member: concatenated gzip files are valid and DuckDB reads them.
    let mut dec = flate2::read::MultiGzDecoder::new(file);
    let mut buf = vec![0u8; 1 << 20];
    loop {
        if stop.load(Ordering::Relaxed) {
            return Ok(false);
        }
        if dec.read(&mut buf)? == 0 {
            return Ok(true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn detects_truncation_and_accepts_complete_streams() {
        let dir = tempfile::tempdir().unwrap();
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        for i in 0..20_000 {
            writeln!(enc, "{i},row {i}").unwrap();
        }
        let full = enc.finish().unwrap();
        let ok = dir.path().join("ok.gz");
        std::fs::write(&ok, &full).unwrap();
        let cut = dir.path().join("cut.gz");
        std::fs::write(&cut, &full[..full.len() / 2]).unwrap();
        let stop = AtomicBool::new(false);
        assert!(verify_gzip(&ok, &stop).unwrap());
        assert!(verify_gzip(&cut, &stop).is_err());
        // Concatenated members are fine.
        let two = dir.path().join("two.gz");
        std::fs::write(&two, [full.clone(), full].concat()).unwrap();
        assert!(verify_gzip(&two, &stop).unwrap());
    }
}
