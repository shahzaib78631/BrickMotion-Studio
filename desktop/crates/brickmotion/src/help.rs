//! Help › BrickMotion Help: a short offline guide, written next to the preferences and opened in
//! the default browser.
use std::path::PathBuf;

pub const GUIDE: &str = include_str!("../assets/help/guide.html");

/// Writes the guide to `dir` and returns its path.
pub fn write_guide(dir: &std::path::Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("BrickMotion Help.html");
    crate::support::write_atomic(&path, GUIDE.as_bytes())?;
    Ok(path)
}

/// Writes the guide to the support folder and opens it.
pub fn open_guide(support: &crate::support::Support) {
    if let Ok(path) = write_guide(&support.dir.join("Help")) {
        let _ = std::process::Command::new("open").arg(&path).spawn();
    }
}
