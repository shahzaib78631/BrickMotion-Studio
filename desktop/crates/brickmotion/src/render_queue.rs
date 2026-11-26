//! The Render Queue (Swift `RenderQueue` + `RenderExportProcess`): one helper process at a time,
//! its output staged beside the destination and moved in only when the render succeeds.
//!
//! - The project goes to `$TMPDIR/BrickMotion-<uuid>/Model.brickmotion`.
//! - Staging is `<dest dir>/.brickmotion-<uuid>/Render.<ext>`.
//! - The helper is run as `[still | --render-editor-movie] <input> --out <staging> …options`,
//!   with `BM_LDRAW_DIR` set. `frame d t` lines are progress; the last four other lines are
//!   the diagnostics a failure shows.
//! - The destination's version (device, inode, modified time, length) is read when the job is
//!   queued and again before the move: a file changed meanwhile is never overwritten.
//! - The history keeps the active jobs and the 40 newest finished ones.
use std::collections::{HashSet, VecDeque};
use std::io::{BufReader, Read};
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{Receiver, Sender, TryRecvError, channel};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

const RESERVED: &str = "An export is already using that destination. Choose another file name.";
const CHANGED: &str = "A different version of the file is at the destination. Choose a new location and export again.";
const MISSING: &str = "The render helper is missing from the app bundle.";
const STAGING: &str = ".brickmotion-";
const KEEP_FINISHED: usize = 40;
const STOPPED: &str = "The export stopped unexpectedly.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Still,
    Movie,
}

impl Operation {
    fn command(self) -> &'static str {
        match self {
            Operation::Still => "still",
            Operation::Movie => "--render-editor-movie",
        }
    }
}

/// The two helper executables: `bmexport` for stills, this app for movies.
#[derive(Clone, Debug)]
pub struct Helpers {
    pub still: PathBuf,
    pub movie: PathBuf,
}

impl Helpers {
    /// In the bundle: `Contents/Helpers/bmexport` and `Contents/MacOS/brickmotion`. From the
    /// build tree: `native/build-rust/render/bmexport` and this executable.
    pub fn locate() -> Helpers {
        let exe = std::env::current_exe().unwrap_or_default();
        let bundled = exe.parent().and_then(Path::parent).map(|c| c.join("Helpers/bmexport"));
        let still = match bundled {
            Some(p) if p.exists() => p,
            _ => PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../native/build-rust/render/bmexport")),
        };
        Helpers { still, movie: exe }
    }

    fn executable(&self, op: Operation) -> &Path {
        match op {
            Operation::Still => &self.still,
            Operation::Movie => &self.movie,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum JobStatus {
    Queued,
    Rendering { done: u32, total: u32 },
    Cancelling,
    Complete,
    Cancelled,
    Interrupted,
    Failed(String),
}

impl JobStatus {
    pub fn finished(&self) -> bool {
        !matches!(self, JobStatus::Queued | JobStatus::Rendering { .. } | JobStatus::Cancelling)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub destination: PathBuf,
    pub summary: String,
    pub status: JobStatus,
    /// Its staging folder's name beside the destination: the one a relaunch removes if the job
    /// was cut short.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staging: Option<String>,
}

/// One movie of a batch: its name (a file stem is made from it), helper options and summary.
#[derive(Clone, Debug)]
pub struct BatchMovie {
    pub name: String,
    pub options: Vec<String>,
    pub summary: String,
}

/// Runs on the staged file before it reaches the destination (e.g. the logo over a still).
pub type Finish = Box<dyn FnOnce(&Path) -> Result<(), String> + Send>;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Version {
    Missing,
    File { device: u64, inode: u64, modified: (i64, i64), bytes: u64 },
}

impl Version {
    fn read(path: &Path) -> Result<Version, String> {
        match std::fs::symlink_metadata(path) {
            Ok(m) => Ok(Version::File { device: m.dev(), inode: m.ino(), modified: (m.mtime(), m.mtime_nsec()), bytes: m.len() }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Version::Missing),
            Err(e) => Err(e.to_string()),
        }
    }
}

struct Request {
    project: Vec<u8>,
    op: Operation,
    options: Vec<String>,
    library: PathBuf,
    destination: PathBuf,
    expected: Version,
    finish: Option<Finish>,
    staging: String,
}

enum Outcome {
    Rendered,
    Cancelled,
    Failed(String),
}

enum Event {
    Progress(u32, u32),
    Done(Outcome),
}

/// The running helper: cancel sets `stopped` and kills its process group.
#[derive(Default)]
struct Control {
    stopped: bool,
    group: Option<i32>,
}

struct Active {
    id: String,
    control: Arc<Mutex<Control>>,
    events: Receiver<Event>,
}

pub struct RenderQueue {
    history: PathBuf,
    helpers: Helpers,
    /// Newest first.
    jobs: Vec<Job>,
    pending: VecDeque<(String, Request)>,
    active: Option<Active>,
}

impl RenderQueue {
    /// Reads the history; jobs that were running when the app quit are Interrupted and their
    /// staging folders are removed.
    pub fn load(history: PathBuf, helpers: Helpers) -> Self {
        let records: Vec<Job> = std::fs::read(&history).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let mut abandoned: HashSet<PathBuf> = HashSet::new();
        let mut named: Vec<PathBuf> = Vec::new();
        for j in records.iter().filter(|j| !j.status.finished()) {
            let Some(folder) = j.destination.parent() else { continue };
            match &j.staging {
                Some(name) => named.push(folder.join(name)),
                // A record from before staging names were kept: every staging folder there.
                None => {
                    abandoned.insert(folder.to_path_buf());
                }
            }
        }
        let jobs = records
            .into_iter()
            .map(|mut j| {
                if !j.status.finished() {
                    j.status = JobStatus::Interrupted;
                }
                j
            })
            .collect();
        let queue = RenderQueue { history, helpers, jobs, pending: VecDeque::new(), active: None };
        // Before any new job stages beside the same destinations.
        remove_staging(&abandoned);
        remove_named_staging(&named);
        if !abandoned.is_empty() || !named.is_empty() {
            queue.save_history();
        }
        queue
    }

    pub fn jobs(&self) -> &[Job] {
        &self.jobs
    }

    pub fn has_finished_jobs(&self) -> bool {
        self.jobs.iter().any(|j| j.status.finished())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn enqueue(
        &mut self,
        project: Vec<u8>,
        op: Operation,
        options: Vec<String>,
        library: &Path,
        destination: PathBuf,
        summary: String,
        finish: Option<Finish>,
    ) -> Result<String, String> {
        let path = key(&destination);
        if self.jobs.iter().any(|j| !j.status.finished() && key(&j.destination) == path) {
            return Err(RESERVED.to_owned());
        }
        let expected = Version::read(&destination)?;
        let staging = format!("{STAGING}{}", uuid());
        let request = Request { project, op, options, library: library.to_path_buf(), destination, expected, finish, staging };
        let id = self.add(request, summary);
        self.save_history();
        self.start_next();
        Ok(id)
    }

    /// Folder selection authorizes new files: numbered names leave existing movies in place.
    pub fn enqueue_movies(&mut self, movies: Vec<BatchMovie>, project: Vec<u8>, library: &Path, folder: &Path) {
        if movies.is_empty() {
            return;
        }
        let mut reserved: HashSet<String> = self.jobs.iter().filter(|j| !j.status.finished()).map(|j| key(&j.destination)).collect();
        for movie in movies {
            let stem = bm::export::safe_file_stem(&movie.name);
            let mut destination = folder.join(format!("{stem}.mp4"));
            let mut suffix = 2;
            while reserved.contains(&key(&destination)) || destination.exists() {
                destination = folder.join(format!("{stem} {suffix}.mp4"));
                suffix += 1;
            }
            reserved.insert(key(&destination));
            let request = Request {
                project: project.clone(),
                op: Operation::Movie,
                options: movie.options,
                library: library.to_path_buf(),
                destination,
                expected: Version::Missing,
                finish: None,
                staging: format!("{STAGING}{}", uuid()),
            };
            self.add(request, movie.summary);
        }
        self.save_history();
        self.start_next();
    }

    fn add(&mut self, request: Request, summary: String) -> String {
        let id = hex(&random_bytes());
        self.jobs.insert(0, Job {
            id: id.clone(),
            destination: request.destination.clone(),
            summary,
            status: JobStatus::Queued,
            staging: Some(request.staging.clone()),
        });
        self.pending.push_back((id.clone(), request));
        id
    }

    fn job_mut(&mut self, id: &str) -> Option<&mut Job> {
        self.jobs.iter_mut().find(|j| j.id == id)
    }

    pub fn cancel(&mut self, id: &str) {
        let Some(status) = self.job_mut(id).map(|j| j.status.clone()) else { return };
        match status {
            JobStatus::Queued => {
                self.pending.retain(|(p, _)| p != id);
                self.set(id, JobStatus::Cancelled);
                self.save_history();
            }
            JobStatus::Rendering { .. } => {
                self.set(id, JobStatus::Cancelling);
                if let Some(a) = self.active.as_ref().filter(|a| a.id == id) {
                    stop(&a.control);
                }
                self.save_history();
            }
            _ => {}
        }
    }

    pub fn clear_finished(&mut self) {
        self.jobs.retain(|j| !j.status.finished());
        self.save_history();
    }

    /// Kills the running helper; its staging is swept on the next launch.
    pub fn stop_for_quit(&mut self) {
        if let Some(a) = &self.active {
            stop(&a.control);
        }
    }

    /// Takes the worker's news; once a frame. True while work remains (keep repainting).
    pub fn poll(&mut self) -> bool {
        let mut done = None;
        if let Some(a) = &self.active {
            let id = a.id.clone();
            let mut progress = Vec::new();
            loop {
                match a.events.try_recv() {
                    Ok(Event::Progress(d, t)) => progress.push((d, t)),
                    Ok(Event::Done(outcome)) => done = Some((id.clone(), outcome)),
                    Err(TryRecvError::Empty) => break,
                    // The worker died (a panic) without reporting: its job ends here.
                    Err(TryRecvError::Disconnected) => {
                        if done.is_none() {
                            done = Some((id.clone(), Outcome::Failed(STOPPED.to_owned())));
                        }
                        break;
                    }
                }
            }
            for (d, t) in progress {
                if let Some(job) = self.job_mut(&id)
                    && let JobStatus::Rendering { done: last, .. } = job.status
                    && d >= last
                {
                    job.status = JobStatus::Rendering { done: d, total: t };
                }
            }
        }
        if let Some((id, outcome)) = done {
            let status = match outcome {
                Outcome::Rendered => JobStatus::Complete,
                Outcome::Cancelled => JobStatus::Cancelled,
                Outcome::Failed(reason) => JobStatus::Failed(reason),
            };
            self.set(&id, status);
            self.active = None;
            self.save_history();
            self.start_next();
        }
        self.active.is_some() || !self.pending.is_empty()
    }

    fn set(&mut self, id: &str, status: JobStatus) {
        if let Some(job) = self.job_mut(id) {
            job.status = status;
        }
    }

    fn start_next(&mut self) {
        if self.active.is_some() {
            return;
        }
        let Some((id, request)) = self.pending.pop_front() else { return };
        let control = Arc::new(Mutex::new(Control::default()));
        let (tx, rx) = channel();
        let executable = self.helpers.executable(request.op).to_path_buf();
        let worker = control.clone();
        std::thread::Builder::new()
            .name("render-queue".into())
            .spawn(move || {
                let outcome = render(request, &executable, &worker, &tx);
                let _ = tx.send(Event::Done(outcome));
            })
            .expect("a render thread");
        self.set(&id, JobStatus::Rendering { done: 0, total: 0 });
        self.active = Some(Active { id, control, events: rx });
        self.save_history();
    }

    fn save_history(&self) {
        let active = self.jobs.iter().filter(|j| !j.status.finished());
        let recent = self.jobs.iter().filter(|j| j.status.finished()).take(KEEP_FINISHED);
        let records: Vec<&Job> = active.chain(recent).collect();
        if let Ok(bytes) = serde_json::to_vec(&records) {
            if let Some(dir) = self.history.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = crate::support::write_atomic(&self.history, &bytes);
        }
    }
}

/// macOS volumes are case-insensitive by default: two spellings of one name are one file.
fn key(path: &Path) -> String {
    let resolved = match (path.parent().and_then(|p| p.canonicalize().ok()), path.file_name()) {
        (Some(dir), Some(name)) => dir.join(name),
        _ => path.to_path_buf(),
    };
    resolved.to_string_lossy().to_lowercase()
}

unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

fn stop(control: &Mutex<Control>) {
    let mut c = control.lock().unwrap_or_else(|e| e.into_inner());
    c.stopped = true;
    if let Some(group) = c.group {
        // The helper's whole process group, so a child it started cannot hold the pipe open.
        unsafe {
            kill(-group, 15);
        }
    }
}

/// Staging folders a render in this process is using: never swept.
static LIVE: Mutex<Vec<String>> = Mutex::new(Vec::new());

struct LiveStaging(String);

impl LiveStaging {
    fn new(name: String) -> LiveStaging {
        LIVE.lock().unwrap_or_else(|e| e.into_inner()).push(name.clone());
        LiveStaging(name)
    }
}

impl Drop for LiveStaging {
    fn drop(&mut self) {
        LIVE.lock().unwrap_or_else(|e| e.into_inner()).retain(|n| *n != self.0);
    }
}

/// Removes the staging folders this queue names (`.brickmotion-<UUID>`) and nothing else.
fn remove_staging(folders: &HashSet<PathBuf>) {
    let live = LIVE.lock().unwrap_or_else(|e| e.into_inner()).clone();
    for folder in folders {
        let Ok(entries) = std::fs::read_dir(folder) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(rest) = name.strip_prefix(STAGING)
                && is_uuid(rest)
                && !live.contains(&name)
            {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

/// Removes these staging folders (each `.brickmotion-<UUID>`), unless a render here is using one.
fn remove_named_staging(folders: &[PathBuf]) {
    let live = LIVE.lock().unwrap_or_else(|e| e.into_inner()).clone();
    for folder in folders {
        let Some(name) = folder.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
        if name.strip_prefix(STAGING).is_some_and(is_uuid) && !live.contains(&name) {
            let _ = std::fs::remove_dir_all(folder);
        }
    }
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

fn random_bytes() -> [u8; 16] {
    let mut b = [0u8; 16];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_err() {
        // Never expected; a time-and-counter id is still unique in this process.
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos() as u64;
        b[..8].copy_from_slice(&t.to_le_bytes());
        b[8..].copy_from_slice(&N.fetch_add(1, Ordering::Relaxed).to_le_bytes());
    }
    b
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// An uppercase version-4 UUID, as Swift's `UUID().uuidString`.
pub(crate) fn uuid() -> String {
    let mut b = random_bytes();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b).to_uppercase();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// Removes a folder when dropped.
struct Remove(PathBuf);

impl Drop for Remove {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

unsafe extern "C" {
    fn renamex_np(from: *const std::ffi::c_char, to: *const std::ffi::c_char, flags: u32) -> i32;
}
const RENAME_EXCL: u32 = 0x4;

/// Moves the staged file to the destination. Replacing an unchanged file is a plain rename; a
/// new file is moved only if none appeared since the last check (Swift's `moveItem`).
fn move_in(output: &Path, destination: &Path, expected: &Version) -> Result<(), String> {
    if *expected != Version::Missing {
        return std::fs::rename(output, destination).map_err(|e| e.to_string());
    }
    use std::os::unix::ffi::OsStrExt;
    let c = |p: &Path| std::ffi::CString::new(p.as_os_str().as_bytes()).map_err(|e| e.to_string());
    let (from, to) = (c(output)?, c(destination)?);
    if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), RENAME_EXCL) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    match error.kind() {
        std::io::ErrorKind::AlreadyExists => Err(CHANGED.to_owned()),
        // A volume without exclusive rename: check, then move.
        std::io::ErrorKind::Unsupported => {
            if destination.symlink_metadata().is_ok() {
                return Err(CHANGED.to_owned());
            }
            std::fs::rename(output, destination).map_err(|e| e.to_string())
        }
        _ => Err(error.to_string()),
    }
}

/// Keeps the last four diagnostics (each at most 1200 characters) and reports progress.
fn consume(bytes: &[u8], diagnostics: &mut VecDeque<String>, events: &Sender<Event>) {
    let text = String::from_utf8_lossy(bytes);
    let line = text.trim();
    let fields: Vec<&str> = line.split(' ').collect();
    if let [frame, d, t] = fields[..]
        && frame == "frame"
        && let (Ok(d), Ok(t)) = (d.parse::<u32>(), t.parse::<u32>())
        && d > 0
        && d <= t
    {
        let _ = events.send(Event::Progress(d, t));
    } else if !line.is_empty() {
        diagnostics.push_back(line.chars().take(1200).collect());
        if diagnostics.len() > 4 {
            diagnostics.pop_front();
        }
    }
}

fn render(request: Request, executable: &Path, control: &Mutex<Control>, events: &Sender<Event>) -> Outcome {
    let Request { project, op, options, library, destination, expected, finish, staging: staging_name } = request;
    if std::fs::metadata(executable).map(|m| !m.is_file() || m.mode() & 0o111 == 0).unwrap_or(true) {
        return Outcome::Failed(MISSING.to_owned());
    }
    let result = (|| -> Result<Outcome, String> {
        let initial = Version::read(&destination)?;
        if initial != expected {
            return Ok(Outcome::Failed(CHANGED.to_owned()));
        }
        let directory = std::env::temp_dir().join(format!("BrickMotion-{}", uuid()));
        let ext = destination.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
        let staging = destination.parent().unwrap_or(Path::new(".")).join(&staging_name);
        let output = staging.join(if ext.is_empty() { "Render".to_owned() } else { format!("Render.{ext}") });
        std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
        let _temp = Remove(directory.clone());
        let _live = LiveStaging::new(staging_name);
        std::fs::create_dir(&staging).map_err(|e| e.to_string())?;
        let _staged = Remove(staging.clone());
        let input = directory.join("Model.brickmotion");
        crate::support::write_atomic(&input, &project).map_err(|e| e.to_string())?;

        let (reader, writer) = std::io::pipe().map_err(|e| e.to_string())?;
        let mut command = Command::new(executable);
        command
            .arg(op.command())
            .arg(&input)
            .arg("--out")
            .arg(&output)
            .args(&options)
            .env("BM_LDRAW_DIR", &library)
            .stdin(Stdio::null())
            .stdout(writer.try_clone().map_err(|e| e.to_string())?)
            .stderr(writer)
            .process_group(0);
        let mut child = {
            let mut c = control.lock().unwrap_or_else(|e| e.into_inner());
            if c.stopped {
                return Ok(Outcome::Cancelled);
            }
            let child = command.spawn().map_err(|e| e.to_string())?;
            c.group = Some(child.id() as i32);
            child
        };
        // The command holds the pipe's write ends: drop it so the read ends at the helper's exit.
        drop(command);

        let mut diagnostics = VecDeque::new();
        let mut reader = BufReader::new(reader);
        let mut pending: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            pending.extend_from_slice(&chunk[..n]);
            while let Some(end) = pending.iter().position(|&b| b == b'\n') {
                consume(&pending[..end], &mut diagnostics, events);
                pending.drain(..=end);
            }
            if pending.len() > 8192 {
                pending.drain(..pending.len() - 8192);
            }
        }
        if !pending.is_empty() {
            consume(&pending, &mut diagnostics, events);
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        let cancelled = {
            let mut c = control.lock().unwrap_or_else(|e| e.into_inner());
            c.group = None;
            c.stopped
        };
        if cancelled {
            return Ok(Outcome::Cancelled);
        }
        if !status.success() {
            let code = status.code().map_or_else(|| "a signal".to_owned(), |c| c.to_string());
            return Ok(Outcome::Failed(diagnostics.pop_back().unwrap_or_else(|| format!("The exporter stopped with status {code}."))));
        }
        if let Some(finish) = finish {
            finish(&output)?;
        }
        if Version::read(&destination)? != expected {
            return Ok(Outcome::Failed(CHANGED.to_owned()));
        }
        move_in(&output, &destination, &expected)?;
        Ok(Outcome::Rendered)
    })();
    result.unwrap_or_else(Outcome::Failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusive_move_keeps_a_file_that_appeared() {
        let dir = std::env::temp_dir().join(format!("bm-move-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (staged, dest) = (dir.join("staged.png"), dir.join("out.png"));
        std::fs::write(&staged, "new").unwrap();
        std::fs::write(&dest, "appeared").unwrap();
        assert_eq!(move_in(&staged, &dest, &Version::Missing), Err(CHANGED.to_owned()));
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "appeared");
        std::fs::remove_file(&dest).unwrap();
        assert_eq!(move_in(&staged, &dest, &Version::Missing), Ok(()));
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "new");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn uuids() {
        let u = uuid();
        assert!(is_uuid(&u), "{u}");
        assert_eq!(&u[14..15], "4");
        assert!(!is_uuid("notauuid"));
        assert!(is_uuid("0f0e7b52-3b7c-4c59-9c2a-6d2a1e0b9f11"));
    }

    #[test]
    fn progress_lines() {
        let (tx, rx) = channel();
        let mut d = VecDeque::new();
        for line in ["frame 1 2", "frame 0 2", "frame 3 2", "x", "y", "z", "w", "v"] {
            consume(line.as_bytes(), &mut d, &tx);
        }
        assert!(matches!(rx.try_recv(), Ok(Event::Progress(1, 2))));
        assert!(rx.try_recv().is_err());
        assert_eq!(d.iter().map(String::as_str).collect::<Vec<_>>(), ["y", "z", "w", "v"]);
    }
}
