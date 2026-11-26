//! View › Record Viewport (Swift `ViewportRecorder`): what the viewport shows, 30 times a second
//! of wall-clock time and never faster than frames are drawn, as an H.264 movie. The first frame
//! sets the movie's size; later frames are fitted into it on black if the view is resized. The
//! movie goes to a temporary file and is saved where the person chooses when it stops.
use std::path::PathBuf;

use bm::recorder::Recorder;

use crate::app::DialogRequest;
use crate::notices::Notice;
use crate::BrickMotionApp;

pub const FRAMES_PER_SECOND: f64 = 30.0;
const ENCODER_STOPPED: &str = "The movie encoder stopped. Try a smaller window.";

pub struct Recording {
    recorder: Recorder,
    file: PathBuf,
    /// `input.time` of the first frame.
    started: f64,
    /// Seconds recorded so far.
    pub seconds: f64,
    /// Frames handed to the encoder (some may be dropped while it is busy).
    pub frames: u32,
}

/// The recording, and a finished movie waiting for its save panel.
#[derive(Default)]
pub struct RecordingState {
    pub active: Option<Recording>,
    finished: Option<PathBuf>,
}

/// "m:ss".
pub fn clock(seconds: f64) -> String {
    let s = seconds.max(0.0) as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

impl BrickMotionApp {
    pub fn recording(&self) -> bool {
        self.recording.active.is_some()
    }

    /// The movie's pixel size while recording.
    pub fn recording_size(&self) -> Option<(u32, u32)> {
        self.recording.active.as_ref().map(|r| r.recorder.size())
    }

    /// The viewport's last frame size in pixels.
    pub fn viewport_frame_size(&self) -> (u32, u32) {
        let f = self.viewport.last_frame();
        (f.width, f.height)
    }

    /// View › Record Viewport, and its Stop.
    pub fn toggle_recording(&mut self, now: f64) {
        if self.recording() {
            self.stop_recording();
        } else {
            self.start_recording(now);
        }
    }

    fn start_recording(&mut self, now: f64) {
        let frame = self.viewport.last_frame();
        let (w, h) = (frame.width, frame.height);
        if w == 0 || h == 0 || frame.rgba.len() < w as usize * h as usize * 4 {
            crate::notices::push(
                &mut self.notices,
                Notice::Warning { title: "Couldn't record the viewport".into(), detail: "The viewport has not drawn a picture yet.".into() },
            );
            return;
        }
        let file = std::env::temp_dir().join(format!("BrickMotion-Recording-{}.mp4", crate::render_queue::uuid()));
        match Recorder::start(&file, w, h) {
            Ok(mut recorder) => {
                recorder.append(&frame.rgba, w, h, 0.0);
                self.recording.active = Some(Recording { recorder, file, started: now, seconds: 0.0, frames: 1 });
            }
            Err(detail) => {
                crate::notices::push(&mut self.notices, Notice::Error { title: "Couldn't record the viewport".into(), detail });
            }
        }
    }

    /// Once a frame: hands the viewport's picture to the encoder when the next 1/30 s is due.
    pub fn tick_recording(&mut self, now: f64) {
        let Some(r) = self.recording.active.as_mut() else { return };
        let elapsed = (now - r.started).max(0.0);
        r.seconds = elapsed;
        if elapsed + 1e-6 < f64::from(r.frames) / FRAMES_PER_SECOND {
            return;
        }
        let frame = self.viewport.last_frame();
        if frame.width > 0 && frame.height > 0 && r.recorder.append(&frame.rgba, frame.width, frame.height, elapsed) {
            r.frames += 1;
        }
    }

    fn stop_recording(&mut self) {
        let Some(r) = self.recording.active.take() else { return };
        if let Err(e) = r.recorder.finish() {
            let _ = std::fs::remove_file(&r.file);
            crate::notices::push(
                &mut self.notices,
                Notice::Error { title: "The Recording Couldn’t Be Saved".into(), detail: format!("{ENCODER_STOPPED} ({e})") },
            );
            return;
        }
        self.recording.finished = Some(r.file);
        let name = crate::export_files::display_name(&self.doc.session().title());
        let suggested = format!("{name} Viewport.mp4");
        if !self.dialogs_enabled() {
            self.dialog_requests.push(DialogRequest { kind: "recording", suggested: Some(suggested) });
            return;
        }
        let picked = rfd::FileDialog::new()
            .set_title("Save the viewport recording")
            .add_filter("MPEG-4 movie", &["mp4"])
            .set_file_name(&suggested)
            .save_file();
        match picked {
            Some(dest) => self.finish_recording(dest),
            None => {
                if let Some(file) = self.recording.finished.take() {
                    let _ = std::fs::remove_file(file);
                }
            }
        }
    }

    /// Quitting while recording: the temporary movie is removed.
    pub fn discard_recording(&mut self) {
        if let Some(r) = self.recording.active.take() {
            let _ = r.recorder.finish();
            let _ = std::fs::remove_file(r.file);
        }
    }

    /// Moves the finished movie to `dest` (the save panel's answer).
    pub fn finish_recording(&mut self, dest: PathBuf) {
        let Some(file) = self.recording.finished.take() else { return };
        let moved = std::fs::rename(&file, &dest).or_else(|_| std::fs::copy(&file, &dest).map(|_| ()));
        let _ = std::fs::remove_file(&file);
        match moved {
            Ok(()) => crate::chrome::export_movie::reveal(self, dest),
            Err(e) => crate::notices::push(
                &mut self.notices,
                Notice::Error { title: "The Recording Couldn’t Be Saved".into(), detail: e.to_string() },
            ),
        }
    }
}
