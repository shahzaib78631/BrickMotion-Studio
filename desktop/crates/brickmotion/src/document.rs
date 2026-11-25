//! Where a document saves, and saving it. Only `.brickmotion` is ever written: a document opened
//! from LDraw (or any other format) is imported, and its first Save is a Save As.
use std::path::{Path, PathBuf};

use crate::support::write_atomic;

/// The extension of a BrickMotion project.
pub const PROJECT_EXTENSION: &str = "brickmotion";

/// The file behind the open document.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DocState {
    /// The file it was opened from or last saved to; None for a new document.
    pub path: Option<PathBuf>,
    /// It came from another format: Save must ask for a .brickmotion file.
    pub imported: bool,
}

impl DocState {
    /// The project file Save writes in place, if there is one.
    pub fn save_path(&self) -> Option<&Path> {
        self.path.as_deref().filter(|p| !self.imported && is_project(p))
    }
}

pub fn is_project(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(PROJECT_EXTENSION))
}

/// `path` with the project extension added when it has another.
pub fn with_project_extension(path: PathBuf) -> PathBuf {
    if is_project(&path) {
        return path;
    }
    let mut s = path.into_os_string();
    s.push(".");
    s.push(PROJECT_EXTENSION);
    PathBuf::from(s)
}

/// Writes the project atomically, then marks it saved. Err is "<file name>: <why>".
pub fn save_to(session: &mut bm::Session, path: &Path) -> Result<(), String> {
    let bytes = session.project_bytes();
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
    if bytes.is_empty() {
        return Err(format!("{name}: the engine produced no project data"));
    }
    write_atomic(path, &bytes).map_err(|e| format!("{name}: {e}"))?;
    session.mark_saved();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_path_only_for_saved_projects() {
        let p = |s: &str, imported| DocState { path: Some(s.into()), imported };
        assert_eq!(p("/a/x.brickmotion", false).save_path(), Some(Path::new("/a/x.brickmotion")));
        assert_eq!(p("/a/x.brickmotion", true).save_path(), None);
        assert_eq!(p("/a/x.json", false).save_path(), None);
        assert_eq!(DocState::default().save_path(), None);
        assert_eq!(with_project_extension("/a/x".into()), PathBuf::from("/a/x.brickmotion"));
        assert_eq!(with_project_extension("/a/x.BrickMotion".into()), PathBuf::from("/a/x.BrickMotion"));
    }
}
