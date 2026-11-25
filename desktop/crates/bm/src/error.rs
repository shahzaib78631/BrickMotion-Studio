use std::fmt;
use std::path::PathBuf;

/// A file that could not be opened, and why.
#[derive(Debug, Clone)]
pub struct OpenError {
    pub path: PathBuf,
    pub message: String,
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = self.path.file_name().map(|n| n.to_string_lossy()).unwrap_or_else(|| self.path.to_string_lossy());
        write!(f, "{name}: {}", self.message)
    }
}

impl std::error::Error for OpenError {}
