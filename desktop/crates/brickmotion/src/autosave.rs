//! Autosave: while a document has unsaved changes, every `autosave_seconds` it writes a
//! timestamped backup to `Backups/<title>/`, keeps the newest `backups_kept`, and saves a titled
//! project in place (like the Swift app's autosavesInPlace). Untitled and imported documents get
//! the backup only and stay edited, so closing them still asks.
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use chrono::{DateTime, Local};

use crate::document::{DocState, PROJECT_EXTENSION, save_to};
use crate::support::{Prefs, Support, write_atomic};

#[derive(Debug, Default)]
pub struct Autosaver {
    /// When the clock started: the last autosave, or when the document was first seen edited.
    last: Option<Instant>,
    /// The document version last autosaved.
    seen_version: u64,
    /// The document (generation) the above belong to.
    generation: u64,
}

impl Autosaver {
    /// Autosaves when it is due. Returns the backup written, or why it failed.
    pub fn tick(
        &mut self,
        now: Instant,
        wall: DateTime<Local>,
        doc: &bm::Session,
        state: &DocState,
        prefs: &Prefs,
        support: &Support,
    ) -> Option<Result<PathBuf, String>> {
        if doc.generation() != self.generation {
            *self = Autosaver { generation: doc.generation(), ..Autosaver::default() };
        }
        if !doc.dirty() {
            self.last = None;
            return None;
        }
        if doc.version() == self.seen_version {
            return None;
        }
        let Some(last) = self.last else {
            self.last = Some(now);
            return None;
        };
        if now.duration_since(last) < Duration::from_secs(prefs.autosave_seconds) {
            return None;
        }
        self.last = Some(now);
        self.seen_version = doc.version();
        Some(self.save(wall, doc, state, prefs, support))
    }

    fn save(&self, wall: DateTime<Local>, doc: &bm::Session, state: &DocState, prefs: &Prefs, support: &Support) -> Result<PathBuf, String> {
        let stem = state.path.as_deref().and_then(Path::file_stem).map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Untitled".into());
        let dir = support.backups().join(&stem);
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let backup = dir.join(format!("{}.{PROJECT_EXTENSION}", wall.format("%Y-%m-%d %H.%M.%S")));
        let bytes = doc.project_bytes();
        write_atomic(&backup, &bytes).map_err(|e| format!("{}: {e}", backup.display()))?;
        prune(&dir, prefs.backups_kept);
        if let Some(path) = state.save_path() {
            save_to(doc, path)?;
        }
        Ok(backup)
    }
}

/// Keeps the newest `keep` backups in `dir`. Their names sort by time.
fn prune(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == PROJECT_EXTENSION))
        .collect();
    files.sort();
    let extra = files.len().saturating_sub(keep);
    for f in &files[..extra] {
        let _ = std::fs::remove_file(f);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use chrono::{Local, TimeZone};

    use crate::document::DocState;
    use crate::support::{Prefs, Support};

    const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bm-autosave-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn wall(sec: u32) -> chrono::DateTime<Local> {
        Local.with_ymd_and_hms(2026, 11, 25, 10, 0, sec).unwrap()
    }

    fn open(p: &Path) -> bm::Session {
        let mut s = bm::Session::new();
        s.open(p).unwrap();
        s
    }

    fn edit(s: &bm::Session) {
        assert_eq!(s.remove(&[0]).refused, None);
    }

    fn backups(support: &Support, stem: &str) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(support.backups().join(stem))
            .map(|r| r.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        v.sort();
        v
    }

    /// A project saved at `dir/name.brickmotion`, opened.
    fn project(dir: &Path, name: &str) -> (bm::Session, DocState) {
        let s = open(Path::new(HELI));
        let path = dir.join(format!("{name}.brickmotion"));
        crate::document::save_to(&s, &path).unwrap();
        (open(&path), DocState { path: Some(path), imported: false })
    }

    #[test]
    fn nothing_before_interval() {
        let d = tmp("interval");
        let support = Support::at(d.join("support"));
        let prefs = Prefs::default();
        let (s, state) = project(&d, "p");
        let mut a = Autosaver::default();
        let t0 = Instant::now();
        assert!(a.tick(t0, wall(0), &s, &state, &prefs, &support).is_none(), "clean");
        edit(&s);
        assert!(a.tick(t0, wall(0), &s, &state, &prefs, &support).is_none());
        assert!(a.tick(t0 + Duration::from_secs(29), wall(29), &s, &state, &prefs, &support).is_none());
        assert!(a.tick(t0 + Duration::from_secs(30), wall(30), &s, &state, &prefs, &support).is_some());
    }

    #[test]
    fn titled_project_saved_in_place_and_backed_up() {
        let d = tmp("titled");
        let support = Support::at(d.join("support"));
        let prefs = Prefs { autosave_seconds: 0, backups_kept: 10 };
        let (s, state) = project(&d, "p");
        let n = s.piece_count();
        let mut a = Autosaver::default();
        let t0 = Instant::now();
        edit(&s);
        a.tick(t0, wall(0), &s, &state, &prefs, &support);
        let r = a.tick(t0 + Duration::from_secs(1), wall(1), &s, &state, &prefs, &support).expect("autosaved").unwrap();
        assert!(!s.dirty());
        assert_eq!(r, support.backups().join("p").join("2026-11-25 10.00.01.brickmotion"));
        assert_eq!(backups(&support, "p").len(), 1);
        assert_eq!(open(state.path.as_ref().unwrap()).piece_count(), n - 1);
    }

    #[test]
    fn untitled_gets_backup_only_and_stays_dirty() {
        let d = tmp("untitled");
        let support = Support::at(d.join("support"));
        let prefs = Prefs { autosave_seconds: 0, backups_kept: 10 };
        let s = open(Path::new(HELI));
        let state = DocState::default();
        let mut a = Autosaver::default();
        let t0 = Instant::now();
        edit(&s);
        a.tick(t0, wall(0), &s, &state, &prefs, &support);
        a.tick(t0 + Duration::from_secs(1), wall(1), &s, &state, &prefs, &support).unwrap().unwrap();
        assert!(s.dirty());
        assert_eq!(backups(&support, "Untitled").len(), 1);
    }

    #[test]
    fn imported_source_untouched() {
        let d = tmp("imported");
        let support = Support::at(d.join("support"));
        let prefs = Prefs { autosave_seconds: 0, backups_kept: 10 };
        let src = d.join("heli.mpd");
        std::fs::copy(HELI, &src).unwrap();
        let before = std::fs::read(&src).unwrap();
        let s = open(&src);
        let state = DocState { path: Some(src.clone()), imported: true };
        let mut a = Autosaver::default();
        let t0 = Instant::now();
        edit(&s);
        a.tick(t0, wall(0), &s, &state, &prefs, &support);
        a.tick(t0 + Duration::from_secs(1), wall(1), &s, &state, &prefs, &support).unwrap().unwrap();
        assert_eq!(std::fs::read(&src).unwrap(), before);
        assert!(s.dirty());
        assert_eq!(backups(&support, "heli").len(), 1);
    }

    #[test]
    fn prunes_to_kept() {
        let d = tmp("prune");
        let support = Support::at(d.join("support"));
        let prefs = Prefs { autosave_seconds: 0, backups_kept: 3 };
        let s = open(Path::new(HELI));
        let state = DocState::default();
        let mut a = Autosaver::default();
        let t0 = Instant::now();
        for i in 0..5u32 {
            edit(&s);
            a.tick(t0 + Duration::from_secs(2 * i as u64), wall(2 * i), &s, &state, &prefs, &support);
            a.tick(t0 + Duration::from_secs(2 * i as u64 + 1), wall(2 * i + 1), &s, &state, &prefs, &support);
        }
        assert_eq!(
            backups(&support, "Untitled"),
            // Saved at 01 (the first dirty tick only starts the clock), then 02, 04, 06, 08.
            vec!["2026-11-25 10.00.04.brickmotion", "2026-11-25 10.00.06.brickmotion", "2026-11-25 10.00.08.brickmotion"]
        );
    }

    #[test]
    fn same_version_not_saved_twice() {
        let d = tmp("same");
        let support = Support::at(d.join("support"));
        let prefs = Prefs { autosave_seconds: 0, backups_kept: 10 };
        let s = open(Path::new(HELI));
        let state = DocState::default();
        let mut a = Autosaver::default();
        let t0 = Instant::now();
        edit(&s);
        a.tick(t0, wall(0), &s, &state, &prefs, &support);
        assert!(a.tick(t0 + Duration::from_secs(1), wall(1), &s, &state, &prefs, &support).is_some());
        assert!(a.tick(t0 + Duration::from_secs(5), wall(5), &s, &state, &prefs, &support).is_none());
        assert_eq!(backups(&support, "Untitled").len(), 1);
    }
}
