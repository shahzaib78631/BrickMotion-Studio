// The Render Queue: one helper at a time, staging beside the destination, progress from
// `frame d t` lines, cancel, history. The helpers here are `sh` scripts in a temp folder.
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use brickmotion::render_queue::{BatchMovie, Helpers, JobStatus, Operation, RenderQueue};
use brickmotion::{BrickMotionApp, run};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

const RESERVED: &str = "An export is already using that destination. Choose another file name.";
const CHANGED: &str = "A different version of the file is at the destination. Choose a new location and export again.";

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("bm-queue-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A helper script: `$1` is the operation, `$2` the project, `$4` the staging file.
fn helper(dir: &Path, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("helper.sh");
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn queue(dir: &Path, body: &str) -> RenderQueue {
    let h = helper(dir, body);
    RenderQueue::load(dir.join("render-queue.json"), Helpers { still: h.clone(), movie: h })
}

const OK: &str = "echo 'frame 1 2'\necho 'frame 2 2'\nprintf '%s|%s|%s' \"$1\" \"$(cat \"$2\")\" \"$BM_LDRAW_DIR\" > \"$4\"";

fn enqueue(q: &mut RenderQueue, dest: &Path) -> Result<String, String> {
    q.enqueue(b"project".to_vec(), Operation::Still, vec!["--size".into(), "8x8".into()], Path::new("/lib"), dest.to_path_buf(), "Still".into(), None)
}

/// Polls until the queue is idle.
fn settle(q: &mut RenderQueue) {
    let start = Instant::now();
    while q.poll() {
        assert!(start.elapsed() < Duration::from_secs(30), "the queue never finished: {:?}", q.jobs());
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn wait_for(q: &mut RenderQueue, what: impl Fn(&RenderQueue) -> bool) {
    let start = Instant::now();
    while !what(q) {
        q.poll();
        assert!(start.elapsed() < Duration::from_secs(10), "timed out: {:?}", q.jobs());
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn staging_left(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.starts_with(".brickmotion-"))
        .collect()
}

#[test]
fn queue_runs_one_job_and_moves_the_file() {
    let dir = temp("one");
    let mut q = queue(&dir, OK);
    let dest = dir.join("out.png");
    let id = enqueue(&mut q, &dest).expect("queued");
    assert_eq!(id.len(), 32);
    assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    settle(&mut q);
    assert_eq!(q.jobs()[0].status, JobStatus::Complete);
    assert_eq!(q.jobs()[0].summary, "Still");
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "still|project|/lib");
    assert!(staging_left(&dir).is_empty());
}

#[test]
fn queue_runs_jobs_one_at_a_time() {
    let dir = temp("serial");
    let log = dir.join("log.txt");
    let body = format!("echo start >> '{l}'\nsleep 0.2\necho end >> '{l}'\nprintf x > \"$4\"", l = log.display());
    let mut q = queue(&dir, &body);
    for n in 0..3 {
        enqueue(&mut q, &dir.join(format!("{n}.png"))).unwrap();
    }
    assert!(matches!(q.jobs()[2].status, JobStatus::Rendering { .. }), "the first job starts at once");
    assert_eq!(q.jobs()[0].status, JobStatus::Queued);
    assert_eq!(q.jobs()[1].status, JobStatus::Queued);
    settle(&mut q);
    let text = std::fs::read_to_string(&log).unwrap();
    assert_eq!(text, "start\nend\nstart\nend\nstart\nend\n");
    assert!(q.jobs().iter().all(|j| j.status == JobStatus::Complete));
}

#[test]
fn queue_refuses_a_reserved_destination() {
    let dir = temp("reserved");
    let mut q = queue(&dir, "sleep 30");
    let id = enqueue(&mut q, &dir.join("out.png")).unwrap();
    assert_eq!(enqueue(&mut q, &dir.join("OUT.png")), Err(RESERVED.to_owned()), "the same file in another case");
    q.cancel(&id);
    settle(&mut q);
    assert!(enqueue(&mut q, &dir.join("out.png")).is_ok(), "a finished job frees its destination");
    q.stop_for_quit();
    settle(&mut q);
}

#[test]
fn queue_keeps_a_file_changed_meanwhile() {
    let dir = temp("changed");
    let dest = dir.join("out.png");
    std::fs::write(&dest, "old").unwrap();
    let mut q = queue(&dir, &format!("printf touched > '{}'\nprintf new > \"$4\"", dest.display()));
    enqueue(&mut q, &dest).unwrap();
    settle(&mut q);
    assert_eq!(q.jobs()[0].status, JobStatus::Failed(CHANGED.into()));
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "touched");
    assert!(staging_left(&dir).is_empty());
}

#[test]
fn queue_replaces_an_unchanged_file() {
    let dir = temp("replace");
    let dest = dir.join("out.png");
    std::fs::write(&dest, "old").unwrap();
    let mut q = queue(&dir, OK);
    enqueue(&mut q, &dest).unwrap();
    settle(&mut q);
    assert_eq!(q.jobs()[0].status, JobStatus::Complete);
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "still|project|/lib");
}

#[test]
fn cancel_kills_helper_and_leaves_no_file() {
    let dir = temp("cancel");
    let dest = dir.join("out.mp4");
    let mut q = queue(&dir, "echo 'frame 1 100'\nsleep 30\nprintf x > \"$4\"");
    let id = enqueue(&mut q, &dest).unwrap();
    wait_for(&mut q, |q| q.jobs()[0].status == JobStatus::Rendering { done: 1, total: 100 });
    let start = Instant::now();
    q.cancel(&id);
    assert_eq!(q.jobs()[0].status, JobStatus::Cancelling);
    settle(&mut q);
    assert!(start.elapsed() < Duration::from_secs(5), "the helper's whole group is killed");
    assert_eq!(q.jobs()[0].status, JobStatus::Cancelled);
    assert!(!dest.exists());
    assert!(staging_left(&dir).is_empty());
}

#[test]
fn cancel_a_waiting_job() {
    let dir = temp("cancel-waiting");
    let mut q = queue(&dir, "sleep 30");
    let first = enqueue(&mut q, &dir.join("a.png")).unwrap();
    let second = enqueue(&mut q, &dir.join("b.png")).unwrap();
    q.cancel(&second);
    assert_eq!(q.jobs()[0].status, JobStatus::Cancelled);
    q.cancel(&first);
    settle(&mut q);
    assert!(q.jobs().iter().all(|j| j.status == JobStatus::Cancelled));
    q.clear_finished();
    assert!(q.jobs().is_empty());
}

#[test]
fn failed_helper_shows_its_last_line() {
    let dir = temp("failed");
    let mut q = queue(&dir, "echo first\necho 'frame 1 2'\necho '  the last line  ' >&2\nexit 3");
    enqueue(&mut q, &dir.join("a.png")).unwrap();
    settle(&mut q);
    assert_eq!(q.jobs()[0].status, JobStatus::Failed("the last line".into()));

    let dir = temp("failed-silent");
    let mut q = queue(&dir, "exit 4");
    enqueue(&mut q, &dir.join("a.png")).unwrap();
    settle(&mut q);
    assert_eq!(q.jobs()[0].status, JobStatus::Failed("The exporter stopped with status 4.".into()));

    let dir = temp("missing");
    let gone = dir.join("nothing-here");
    let mut q = RenderQueue::load(dir.join("render-queue.json"), Helpers { still: gone.clone(), movie: gone });
    enqueue(&mut q, &dir.join("a.png")).unwrap();
    settle(&mut q);
    assert_eq!(q.jobs()[0].status, JobStatus::Failed("The render helper is missing from the app bundle.".into()));
}

#[test]
fn interrupted_job_sweeps_only_its_staging() {
    let dir = temp("interrupted");
    let out = dir.join("films");
    std::fs::create_dir_all(out.join(".brickmotion-0F0E7B52-3B7C-4C59-9C2A-6D2A1E0B9F11")).unwrap();
    std::fs::create_dir_all(out.join(".brickmotion-notauuid")).unwrap();
    std::fs::write(out.join("keep.txt"), "keep").unwrap();
    let record = format!(
        r#"[{{"id":"00112233445566778899aabbccddeeff","destination":"{}","summary":"Build","status":{{"Rendering":{{"done":3,"total":9}}}}}}]"#,
        out.join("Build.mp4").display()
    );
    std::fs::write(dir.join("render-queue.json"), record).unwrap();
    let q = queue(&dir, OK);
    assert_eq!(q.jobs().len(), 1);
    assert_eq!(q.jobs()[0].status, JobStatus::Interrupted);
    let mut left = staging_left(&out);
    left.sort();
    assert_eq!(left, [".brickmotion-notauuid"]);
    assert!(out.join("keep.txt").exists());
    let again = queue(&dir, OK);
    assert_eq!(again.jobs()[0].status, JobStatus::Interrupted, "the history was saved");
}

#[test]
fn history_keeps_40_finished() {
    let dir = temp("history");
    let mut q = queue(&dir, "printf x > \"$4\"");
    for n in 0..45 {
        enqueue(&mut q, &dir.join(format!("{n}.png"))).unwrap();
    }
    settle(&mut q);
    assert_eq!(q.jobs().len(), 45);
    let again = queue(&dir, OK);
    assert_eq!(again.jobs().len(), 40);
    assert_eq!(again.jobs()[0].destination, dir.join("44.png"), "newest first");
    assert!(again.jobs().iter().all(|j| j.status == JobStatus::Complete));
}

#[test]
fn finish_runs_before_the_move() {
    let dir = temp("finish");
    let dest = dir.join("out.png");
    let mut q = queue(&dir, "printf rendered > \"$4\"");
    let seen: Arc<Mutex<Option<(PathBuf, bool)>>> = Arc::default();
    let seen2 = seen.clone();
    let dest2 = dest.clone();
    let finish: brickmotion::render_queue::Finish = Box::new(move |staged: &Path| {
        *seen2.lock().unwrap() = Some((staged.to_path_buf(), dest2.exists()));
        let mut text = std::fs::read_to_string(staged).map_err(|e| e.to_string())?;
        text.push_str("+logo");
        std::fs::write(staged, text).map_err(|e| e.to_string())
    });
    q.enqueue(b"p".to_vec(), Operation::Still, vec![], Path::new("/lib"), dest.clone(), "Still".into(), Some(finish)).unwrap();
    settle(&mut q);
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "rendered+logo");
    let (staged, existed) = seen.lock().unwrap().clone().expect("finish ran");
    assert!(!existed, "the destination is written only after finish");
    let folder = staged.parent().unwrap().file_name().unwrap().to_string_lossy().into_owned();
    assert!(folder.starts_with(".brickmotion-"), "{folder}");
    assert_eq!(staged.file_name().unwrap(), "Render.png");

    let mut q = queue(&dir, "printf rendered > \"$4\"");
    let other = dir.join("refused.png");
    let refuse: brickmotion::render_queue::Finish = Box::new(|_| Err("The logo could not be drawn.".into()));
    q.enqueue(b"p".to_vec(), Operation::Still, vec![], Path::new("/lib"), other.clone(), "Still".into(), Some(refuse)).unwrap();
    settle(&mut q);
    assert_eq!(q.jobs()[0].status, JobStatus::Failed("The logo could not be drawn.".into()));
    assert!(!other.exists());
}

#[test]
fn movies_get_numbered_names() {
    let dir = temp("movies");
    std::fs::write(dir.join("Build.mp4"), "old").unwrap();
    let mut q = queue(&dir, "printf '%s' \"$1\" > \"$4\"");
    let movie = |name: &str| BatchMovie { name: name.into(), options: vec![], summary: format!("{name} film") };
    q.enqueue_movies(vec![movie("Build"), movie("Build"), movie("a/b")], b"p".to_vec(), Path::new("/lib"), &dir);
    settle(&mut q);
    let mut names: Vec<String> = q.jobs().iter().map(|j| j.destination.file_name().unwrap().to_string_lossy().into_owned()).collect();
    names.sort();
    assert_eq!(names, ["Build 2.mp4", "Build 3.mp4", "a b.mp4"]);
    assert_eq!(std::fs::read_to_string(dir.join("Build.mp4")).unwrap(), "old");
    assert_eq!(std::fs::read_to_string(dir.join("Build 2.mp4")).unwrap(), "--render-editor-movie");
}

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

#[test]
fn render_queue_command_opens_panel() {
    if !bm::metal_available() {
        return;
    }
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
        app.wait_loaded();
        app.dialogs_off();
        app.prefs.auto_plan = false;
        app
    });
    h.run_steps(3);
    assert!(h.query_by_label("Render Queue panel").is_none());
    assert!(run(h.state_mut(), "output.render_queue"));
    h.run_steps(3);
    assert!(h.query_by_label("Render Queue panel").is_some());
    assert!(h.query_by_label("Build, Keyframes, and Turntable exports appear here.").is_some());
}

/// The real movie helper: `brickmotion --render-editor-movie` films two seconds of turntable.
#[test]
fn movie_helper_renders_two_seconds() {
    if std::env::var("BM_SLOW").as_deref() != Ok("1") {
        return;
    }
    let exe = PathBuf::from(env!("CARGO_BIN_EXE_brickmotion"));
    let dir = temp("movie");
    let bytes = {
        let mut s = bm::Session::new();
        s.open(Path::new(HELI)).expect("the helicopter opens");
        s.project_bytes()
    };
    let mut q = RenderQueue::load(dir.join("render-queue.json"), Helpers { still: exe.clone(), movie: exe });
    let dest = dir.join("turn.mp4");
    let options = ["--size", "320x180", "--fps", "12", "--source", "turntable", "--duration", "2"].map(String::from).to_vec();
    let library = bm::ldraw_directory().unwrap_or_default();
    q.enqueue(bytes, Operation::Movie, options, &library, dest.clone(), "Turntable".into(), None).unwrap();
    let start = Instant::now();
    while q.poll() {
        assert!(start.elapsed() < Duration::from_secs(300));
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(q.jobs()[0].status, JobStatus::Complete);
    assert_eq!(bm::recorder::frame_count(&dest), Some(24));
}

#[test]
fn dead_worker_fails_its_job() {
    let dir = temp("dead-worker");
    let mut q = queue(&dir, "printf x > \"$4\"");
    let boom: brickmotion::render_queue::Finish = Box::new(|_| panic!("finish blew up"));
    q.enqueue(b"p".to_vec(), Operation::Still, vec![], Path::new("/lib"), dir.join("a.png"), "Still".into(), Some(boom)).unwrap();
    enqueue(&mut q, &dir.join("b.png")).unwrap();
    settle(&mut q);
    assert_eq!(q.jobs()[1].status, JobStatus::Failed("The export stopped unexpectedly.".into()));
    assert_eq!(q.jobs()[0].status, JobStatus::Complete, "the next job still runs");
}

#[test]
fn running_job_records_its_staging() {
    let dir = temp("records-staging");
    let mut q = queue(&dir, "printf x > \"$4\"\nsleep 5");
    enqueue(&mut q, &dir.join("a.png")).unwrap();
    wait_for(&mut q, |_| !staging_left(&dir).is_empty());
    let history = std::fs::read_to_string(dir.join("render-queue.json")).unwrap();
    let staging = staging_left(&dir).remove(0);
    assert!(history.contains(&format!("\"staging\":\"{staging}\"")), "{history}");
    q.cancel(&q.jobs()[0].id.clone());
    settle(&mut q);
}

#[test]
fn interrupted_job_sweeps_its_named_staging() {
    let dir = temp("interrupted-named");
    let out = dir.join("films");
    let mine = ".brickmotion-0F0E7B52-3B7C-4C59-9C2A-6D2A1E0B9F11";
    let other = ".brickmotion-1F0E7B52-3B7C-4C59-9C2A-6D2A1E0B9F11";
    std::fs::create_dir_all(out.join(mine)).unwrap();
    std::fs::create_dir_all(out.join(other)).unwrap();
    let record = format!(
        r#"[{{"id":"00112233445566778899aabbccddeeff","destination":"{}","summary":"Build","status":{{"Rendering":{{"done":3,"total":9}}}},"staging":"{mine}"}}]"#,
        out.join("Build.mp4").display()
    );
    std::fs::write(dir.join("render-queue.json"), record).unwrap();
    let q = queue(&dir, OK);
    assert_eq!(q.jobs()[0].status, JobStatus::Interrupted);
    assert_eq!(staging_left(&out), [other], "another process's staging stays");
}

/// The worker wakes the window on each piece of news, so nothing polls while a render runs.
#[test]
fn worker_wakes_on_each_event() {
    let dir = temp("waker");
    let mut q = queue(&dir, OK);
    let woken = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let w = woken.clone();
    q.set_waker(Arc::new(move || {
        w.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }));
    assert!(q.has_waker());
    enqueue(&mut q, &dir.join("a.png")).unwrap();
    settle(&mut q);
    // frame 1 2, frame 2 2, and Done.
    assert!(woken.load(std::sync::atomic::Ordering::SeqCst) >= 3, "{woken:?}");
}

/// Snap sounds through the Rust helper: the movie has an audio track as long as its video.
#[test]
fn movie_helper_mixes_snap_audio() {
    if std::env::var("BM_SLOW").as_deref() != Ok("1") {
        return;
    }
    let exe = PathBuf::from(env!("CARGO_BIN_EXE_brickmotion"));
    let dir = temp("snap-audio");
    let model = dir.join("three.ldr");
    std::fs::write(
        &model,
        "0 Three\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n0 STEP\n1 1 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat\n0 STEP\n1 14 0 -48 0 1 0 0 0 1 0 0 0 1 3001.dat\n",
    )
    .unwrap();
    let bytes = {
        let mut s = bm::Session::new();
        s.open(&model).expect("the model opens");
        s.project_bytes()
    };
    let mut q = RenderQueue::load(dir.join("render-queue.json"), Helpers { still: exe.clone(), movie: exe });
    let dest = dir.join("build.mp4");
    let options = ["--size", "160x90", "--fps", "12", "--source", "build", "--snap-audio"].map(String::from).to_vec();
    let library = bm::ldraw_directory().unwrap_or_default();
    q.enqueue(bytes, Operation::Movie, options, &library, dest.clone(), "Build".into(), None).unwrap();
    let start = Instant::now();
    while q.poll() {
        assert!(start.elapsed() < Duration::from_secs(300));
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(q.jobs()[0].status, JobStatus::Complete, "{:?}", q.jobs());
    let frames = bm::recorder::frame_count(&dest).expect("a video track");
    let audio = bm::recorder::audio_seconds(&dest).expect("an audio track");
    let video = f64::from(frames) / 12.0;
    assert!((audio - video).abs() < 0.5, "audio {audio} s, video {video} s");
}
