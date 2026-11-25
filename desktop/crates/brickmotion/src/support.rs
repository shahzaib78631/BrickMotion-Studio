//! The app's support folder: preferences, the Open Recent list and autosave backups.
//! Code reaches the folder only through [`Support`], so tests use a temp folder.
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const MAX_RECENTS: usize = 10;

/// `~/Library/Application Support/BrickMotion`, or a folder a test gives.
#[derive(Debug, Clone)]
pub struct Support {
    pub dir: PathBuf,
}

impl Support {
    pub fn user() -> Support {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
        Support { dir: home.join("Library/Application Support/BrickMotion") }
    }

    pub fn at(dir: impl Into<PathBuf>) -> Support {
        Support { dir: dir.into() }
    }

    pub fn backups(&self) -> PathBuf {
        self.dir.join("Backups")
    }

    fn file(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }
}

/// The settings kept in `preferences.toml`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Prefs {
    pub autosave_seconds: u64,
    pub backups_kept: usize,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { autosave_seconds: 30, backups_kept: 10 }
    }
}

impl Prefs {
    /// The defaults when the file is missing or cannot be read.
    pub fn load(support: &Support) -> Prefs {
        std::fs::read_to_string(support.file("preferences.toml"))
            .ok()
            .and_then(|t| toml::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, support: &Support) -> io::Result<()> {
        let text = toml::to_string(self).map_err(io::Error::other)?;
        std::fs::create_dir_all(&support.dir)?;
        write_atomic(&support.file("preferences.toml"), text.as_bytes())
    }
}

/// Recently opened or saved files, newest first.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Recents(pub Vec<PathBuf>);

#[derive(Serialize, Deserialize)]
struct RecentsFile {
    files: Vec<PathBuf>,
}

impl Recents {
    pub fn load(support: &Support) -> Recents {
        let files = std::fs::read_to_string(support.file("recents.toml"))
            .ok()
            .and_then(|t| toml::from_str::<RecentsFile>(&t).ok())
            .map(|f| f.files)
            .unwrap_or_default();
        Recents(files.into_iter().take(MAX_RECENTS).collect())
    }

    pub fn save(&self, support: &Support) -> io::Result<()> {
        let text = toml::to_string(&RecentsFile { files: self.0.clone() }).map_err(io::Error::other)?;
        std::fs::create_dir_all(&support.dir)?;
        write_atomic(&support.file("recents.toml"), text.as_bytes())
    }

    /// Puts `path` first, once, keeping at most ten.
    pub fn add(&mut self, path: PathBuf) {
        self.0.retain(|p| p != &path);
        self.0.insert(0, path);
        self.0.truncate(MAX_RECENTS);
    }

    /// The files that still exist; missing ones stay in the list in case they come back.
    pub fn existing(&self) -> Vec<&Path> {
        self.0.iter().map(PathBuf::as_path).filter(|p| p.exists()).collect()
    }

    pub fn clear(&mut self) {
        self.0.clear();
    }
}

/// Writes `bytes` to a temp file beside `path`, then renames it over `path`. On error the temp
/// file is removed and `path` is untouched.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = path.file_name().ok_or_else(|| io::Error::other("no file name"))?;
    let tmp = dir.join(format!("{}.tmp-{}", name.to_string_lossy(), std::process::id()));
    let result = (|| {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bm-support-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn prefs_default_when_missing_or_bad() {
        let s = Support::at(tmp("prefs-bad"));
        assert_eq!(Prefs::load(&s), Prefs::default());
        std::fs::write(s.dir.join("preferences.toml"), "autosave_seconds = 'x'").unwrap();
        assert_eq!(Prefs::load(&s), Prefs::default());
        assert_eq!(Prefs::default(), Prefs { autosave_seconds: 30, backups_kept: 10 });
    }

    #[test]
    fn prefs_round_trip() {
        let s = Support::at(tmp("prefs-rt"));
        let p = Prefs { autosave_seconds: 5, backups_kept: 3 };
        p.save(&s).unwrap();
        assert_eq!(Prefs::load(&s), p);
    }

    #[test]
    fn recents_dedupe_front_and_cap() {
        let mut r = Recents::default();
        r.add("/a".into());
        r.add("/b".into());
        r.add("/a".into());
        assert_eq!(r.0, vec![PathBuf::from("/a"), PathBuf::from("/b")]);
        for i in 0..12 {
            r.add(format!("/p{i}").into());
        }
        assert_eq!(r.0.len(), 10);
        assert_eq!(r.0[0], PathBuf::from("/p11"));
        r.clear();
        assert!(r.0.is_empty());
    }

    #[test]
    fn recents_hide_missing_but_keep() {
        let d = tmp("recents");
        let s = Support::at(d.join("support"));
        let real = d.join("real.brickmotion");
        std::fs::write(&real, "{}").unwrap();
        let mut r = Recents::default();
        r.add(d.join("gone.brickmotion"));
        r.add(real.clone());
        r.save(&s).unwrap();
        let back = Recents::load(&s);
        assert_eq!(back.0.len(), 2);
        assert_eq!(back.existing(), vec![real.as_path()]);
    }

    #[test]
    fn write_atomic_leaves_no_temp_on_error() {
        let d = tmp("atomic");
        let ok = d.join("ok.txt");
        write_atomic(&ok, b"hello").unwrap();
        assert_eq!(std::fs::read(&ok).unwrap(), b"hello");

        let ro = d.join("ro");
        std::fs::create_dir_all(&ro).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o555)).unwrap();
        assert!(write_atomic(&ro.join("x.brickmotion"), b"data").is_err());
        let left: Vec<_> = std::fs::read_dir(&ro).unwrap().collect();
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(left.is_empty(), "left {left:?}");
    }
}
