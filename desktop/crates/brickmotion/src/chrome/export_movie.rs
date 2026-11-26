//! The Export Video panel (Swift `VideoExportSheet`): source, frame shape, resolution, quality,
//! frame rate, camera, logo, turntable duration and snap sounds, then a job on the Render Queue.
//! One video asks for a file; several submodels ask for a folder and are numbered so no file is
//! replaced. The panel follows its job until it is done.
use std::path::{Path, PathBuf};

use bm::export::{
    FrameShape, LogoCorner, MovieCamera, MovieChoice, MovieQuality, MovieResolution, MovieSource, VideoTarget, ViewAngles,
    movie_allows_track, movie_arguments, movie_size, movie_summary,
};
use egui::{Color32, CornerRadius, FontId, Sense, Stroke, StrokeKind, Ui, WidgetInfo, pos2, vec2};

use super::float_panel::{self, Head, PanelKind};
use super::widgets::{accent_button, footnote, hairline, inset_group, page_footer, popup_row, secondary_button, segmented, switch_row};
use crate::BrickMotionApp;
use crate::app::DialogRequest;
use crate::icons::Icon;
use crate::notices::Notice;
use crate::render_queue::{BatchMovie, JobStatus, Operation};
use crate::theme::Theme;

/// The camera the panel films with (Swift's `Camera`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CameraPick {
    Director,
    Track,
    Viewport,
    Saved(String),
}

pub struct MoviePanel {
    pub open: bool,
    pub source: MovieSource,
    pub shape: FrameShape,
    pub resolution: MovieResolution,
    pub quality: MovieQuality,
    pub fps: i32,
    pub turntable_seconds: i32,
    pub camera: CameraPick,
    pub include_snap_audio: bool,
    /// Submodel videos (a batch); empty for the whole project.
    pub targets: Vec<VideoTarget>,
    pub angles: ViewAngles,
    /// The queued job this panel follows.
    pub job: Option<String>,
    pub error: Option<String>,
    title: String,
    saved: Vec<(String, String)>,
    has_build_track: bool,
    has_timeline_track: bool,
    prefers_track: bool,
    standard_preview: bool,
    /// The logo preview, decoded once per file.
    /// The preview of the logo file it was made from; None when that file would not decode.
    logo_texture: Option<(PathBuf, Option<egui::TextureHandle>)>,
    /// How many times a logo file was decoded for the preview (tests read it).
    #[doc(hidden)]
    pub logo_reads: u32,
    /// A logo being converted on its own thread.
    logo_job: Option<std::sync::mpsc::Receiver<Result<PathBuf, String>>>,
}

impl Default for MoviePanel {
    fn default() -> Self {
        MoviePanel {
            open: false,
            source: MovieSource::Build,
            shape: FrameShape::Landscape,
            resolution: MovieResolution::Standard,
            quality: MovieQuality::Standard,
            fps: 30,
            turntable_seconds: 8,
            camera: CameraPick::Director,
            include_snap_audio: false,
            targets: Vec::new(),
            angles: ViewAngles::default(),
            job: None,
            error: None,
            title: String::new(),
            saved: Vec::new(),
            has_build_track: false,
            has_timeline_track: false,
            prefers_track: false,
            standard_preview: false,
            logo_texture: None,
            logo_reads: 0,
            logo_job: None,
        }
    }
}

const FPS: [i32; 5] = [24, 25, 30, 50, 60];
const SECONDS: [i32; 5] = [4, 6, 8, 12, 16];

/// Opens the panel for the project (`targets` empty) or for submodel videos, as Swift's `show`.
pub fn open(app: &mut BrickMotionApp, targets: Vec<VideoTarget>) {
    let angles = app.doc.viewport().map(|vp| bm::export::view_angles(vp.camera())).unwrap_or_default();
    let s = app.doc.session();
    let batch = !targets.is_empty();
    let scene = s.scene_cameras();
    let default_saved =
        if !batch && scene.use_for_video { scene.cameras.iter().find(|c| c.id == scene.active_id).map(|c| c.id.clone()) } else { None };
    let project = match bm::export::default_movie_camera(s, batch, angles.present) {
        MovieCamera::Viewport => CameraPick::Viewport,
        MovieCamera::Track => CameraPick::Track,
        _ => CameraPick::Director,
    };
    let keyframes = !batch && app.transport.clock() == crate::transport::Clock::Keyframes;
    let m = &mut app.movie;
    m.title = crate::export_files::display_name(&s.title());
    m.saved = scene.cameras.iter().map(|c| (c.id.clone(), c.name.clone())).collect();
    m.has_build_track = !s.camera_keys(bm::camera::CameraClock::Build).is_empty();
    m.has_timeline_track = !s.camera_keys(bm::camera::CameraClock::Timeline).is_empty();
    m.prefers_track = s.export_camera() == "track" && default_saved.is_none();
    m.standard_preview = app.transport.standard_preview() || s.build_settings().standard_planner;
    m.source = if keyframes { MovieSource::Keyframes } else { MovieSource::Build };
    m.include_snap_audio = s.snap_mix().enabled;
    m.camera = default_saved.map_or(project, CameraPick::Saved);
    m.angles = angles;
    m.targets = targets;
    m.job = None;
    m.error = None;
    m.open = true;
    app.panels.unfold(PanelKind::Movie);
    fix_camera(app);
}

pub fn is_open(app: &BrickMotionApp) -> bool {
    app.movie.open
}

fn batch(app: &BrickMotionApp) -> bool {
    !app.movie.targets.is_empty()
}

/// Keys belong to one video of the project: its Build or its Keyframes timeline.
pub fn allows_track(app: &BrickMotionApp) -> bool {
    let probe = MovieChoice { source: app.movie.source, ..MovieChoice::default() };
    movie_allows_track(app.session(), &probe, batch(app), false)
}

fn allows_saved(app: &BrickMotionApp) -> bool {
    app.movie.source != MovieSource::Turntable && !batch(app)
}

/// The camera follows what this video allows (Swift's `onChange` of allowsTrack/allowsSavedCameras).
fn fix_camera(app: &mut BrickMotionApp) {
    let (track, saved) = (allows_track(app), allows_saved(app));
    let m = &mut app.movie;
    if !saved && matches!(m.camera, CameraPick::Saved(_)) {
        m.camera = CameraPick::Director;
    }
    if !track && m.camera == CameraPick::Track {
        m.camera = CameraPick::Director;
    } else if track && m.prefers_track && m.camera == CameraPick::Director {
        m.camera = CameraPick::Track;
    }
}

/// The panel's settings as the engine takes them; the camera is resolved against what this
/// video allows.
/// The movie helper's options: the engine's arguments and where the recorded snap samples are.
fn helper_options(c: &MovieChoice) -> Vec<String> {
    let mut options = movie_arguments(c);
    options.extend(["--recordings".to_owned(), crate::support::snap_recordings().display().to_string()]);
    options
}

pub fn choice(app: &BrickMotionApp, path: &[String]) -> MovieChoice {
    let m = &app.movie;
    let (camera, scene_camera_id) = match &m.camera {
        CameraPick::Director => (MovieCamera::Director, String::new()),
        CameraPick::Track => (if allows_track(app) { MovieCamera::Track } else { MovieCamera::Director }, String::new()),
        CameraPick::Viewport => (MovieCamera::Viewport, String::new()),
        CameraPick::Saved(id) => (if allows_saved(app) { MovieCamera::Saved } else { MovieCamera::Director }, id.clone()),
    };
    let (logo, logo_corner) = crate::logo::stamp(&app.support, &app.prefs)
        .map_or((String::new(), LogoCorner::BottomRight), |(f, c)| (f.to_string_lossy().into_owned(), c));
    MovieChoice {
        source: m.source,
        shape: m.shape,
        resolution: m.resolution,
        quality: m.quality,
        fps: m.fps,
        turntable_seconds: m.turntable_seconds,
        camera,
        scene_camera_id,
        snap_audio: m.include_snap_audio,
        standard_preview: m.standard_preview,
        angles: m.angles,
        model_path: path.to_vec(),
        logo,
        logo_corner,
    }
}

fn library() -> PathBuf {
    bm::ldraw_directory().unwrap_or_default()
}

impl BrickMotionApp {
    /// Continue… / Choose Folder…: asks where the video goes.
    pub fn choose_movie_destination(&mut self) {
        if self.movie.targets.len() > 1 {
            if !self.dialogs_enabled() {
                self.dialog_requests.push(DialogRequest { kind: "movie_folder", suggested: None });
                return;
            }
            if let Some(folder) = rfd::FileDialog::new().set_title("Choose an Export Folder").pick_folder() {
                self.finish_movie(folder);
            }
            return;
        }
        let m = &self.movie;
        let name = m.targets.first().map_or_else(|| m.title.clone(), |t| t.title.clone());
        let suggested = format!("{name} – {}.mp4", m.source.title());
        if !self.dialogs_enabled() {
            self.dialog_requests.push(DialogRequest { kind: "movie", suggested: Some(suggested) });
            return;
        }
        let mut dialog = rfd::FileDialog::new().set_title("Export Video").add_filter("MPEG-4 movie", &["mp4"]).set_file_name(&suggested);
        if let Some(dir) = self.state.path.as_deref().and_then(Path::parent) {
            dialog = dialog.set_directory(dir);
        }
        if let Some(path) = dialog.save_file() {
            self.finish_movie(path);
        }
    }

    /// Queues the video at `path` (a folder for a batch of submodels).
    pub fn finish_movie(&mut self, path: PathBuf) {
        self.prefs.movie_frame_shape = self.movie.shape.title().to_owned();
        let _ = self.prefs.save(&self.support);
        let project = self.doc.session().project_bytes();
        let summary = movie_summary(&choice(self, &[]));
        if self.movie.targets.len() > 1 {
            let movies = self
                .movie
                .targets
                .iter()
                .map(|t| BatchMovie {
                    name: format!("{} – {}", t.title, self.movie.source.title()),
                    options: helper_options(&choice(self, &t.path)),
                    summary: summary.clone(),
                })
                .collect();
            self.queue.enqueue_movies(movies, project, &library(), &path);
            self.movie.open = false;
            self.queue_panel.open = true;
            self.panels.unfold(PanelKind::Queue);
            return;
        }
        // The project remembers which camera films its Build videos, as the web app does.
        if self.movie.targets.is_empty() && self.movie.source != MovieSource::Turntable {
            let remembered = match self.movie.camera {
                CameraPick::Director if allows_track(self) => Some("automatic"),
                CameraPick::Viewport => Some("buildView"),
                CameraPick::Track => Some("track"),
                _ => None,
            };
            if let Some(camera) = remembered
                && self.doc.session().export_camera() != camera
            {
                let c = self.doc.session().set_export_camera(camera);
                self.edited(c);
            }
        }
        let model = self.movie.targets.first().map(|t| t.path.clone()).unwrap_or_default();
        let options = helper_options(&choice(self, &model));
        match self.queue.enqueue(project, Operation::Movie, options, &library(), path, summary, None) {
            Ok(id) => self.movie.job = Some(id),
            Err(e) => self.movie.error = Some(e),
        }
    }

    /// Copies a logo image for every video from now on.
    /// Converts `source` into the logo on its own thread; `poll_logo` takes the result.
    pub fn start_logo(&mut self, source: PathBuf) {
        let dir = crate::logo::folder(&self.support);
        let (tx, rx) = std::sync::mpsc::channel();
        let ctx = self.ctx_handle();
        std::thread::spawn(move || {
            let _ = tx.send(crate::logo::convert(&dir, &source));
            if let Some(ctx) = ctx {
                ctx.request_repaint();
            }
        });
        self.movie.logo_job = Some(rx);
    }

    pub fn logo_pending(&self) -> bool {
        self.movie.logo_job.is_some()
    }

    /// Takes a finished conversion: the new logo, or why it could not be used.
    pub(crate) fn poll_logo(&mut self) {
        let Some(rx) = &self.movie.logo_job else { return };
        let result = match rx.try_recv() {
            Ok(r) => r,
            Err(std::sync::mpsc::TryRecvError::Empty) => return,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => Err(crate::logo::UNREADABLE.to_owned()),
        };
        self.movie.logo_job = None;
        match result {
            Ok(copy) => {
                crate::logo::apply(&mut self.prefs, &copy);
                let _ = self.prefs.save(&self.support);
            }
            Err(detail) => {
                crate::notices::push(&mut self.notices, Notice::Error { title: "Couldn't use the logo".into(), detail });
            }
        }
    }

    pub fn choose_logo(&mut self, source: &Path) -> Result<PathBuf, String> {
        let copy = crate::logo::choose(&self.support, &mut self.prefs, source)?;
        let _ = self.prefs.save(&self.support);
        Ok(copy)
    }
}

/// What the panel shows once a video is queued.
enum Shown {
    Settings,
    Waiting(String),
    Running(String, u32, u32),
    Cancelling(String),
    Complete(PathBuf),
    Failed(String),
}

fn shown(app: &mut BrickMotionApp) -> Shown {
    if let Some(e) = &app.movie.error {
        return Shown::Failed(e.clone());
    }
    let Some(id) = app.movie.job.clone() else { return Shown::Settings };
    let Some(job) = app.queue.jobs().iter().find(|j| j.id == id) else {
        app.movie.job = None;
        return Shown::Settings;
    };
    let name = job.destination.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    match &job.status {
        JobStatus::Queued => Shown::Waiting(name),
        JobStatus::Rendering { done, total } => Shown::Running(name, *done, *total),
        JobStatus::Cancelling => Shown::Cancelling(name),
        JobStatus::Complete => Shown::Complete(job.destination.clone()),
        JobStatus::Cancelled => {
            app.movie.job = None;
            Shown::Settings
        }
        JobStatus::Interrupted => Shown::Failed("The export was interrupted.".into()),
        JobStatus::Failed(reason) => Shown::Failed(reason.clone()),
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: egui::Rect, next_top: &mut f32) {
    if !app.movie.open {
        return;
    }
    let subtitle = match app.movie.targets.len() {
        0 => app.movie.title.clone(),
        1 => app.movie.targets[0].title.clone(),
        n => format!("{n} Submodels"),
    };
    let out = float_panel::show(ui, app, area, next_top, PanelKind::Movie, Head { icon: Icon::Vid, title: "", subtitle: &subtitle }, body);
    if out.close {
        app.movie.open = false;
    }
}

fn body(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;
    match shown(app) {
        Shown::Settings => settings(ui, app, &t),
        Shown::Waiting(name) => result(ui, &t, "Waiting to Render", &name, None),
        Shown::Running(name, done, total) => {
            let phase = if total == 0 {
                "Preparing Video…"
            } else if done == total {
                "Finalizing Video…"
            } else {
                "Rendering Frames"
            };
            let progress = (done > 0 && done < total).then_some((done, total));
            result(ui, &t, phase, &name, progress);
        }
        Shown::Cancelling(name) => result(ui, &t, "Cancelling…", &name, None),
        Shown::Complete(dest) => {
            let name = dest.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
            result(ui, &t, "Video Exported", &name, None);
        }
        Shown::Failed(detail) => result(ui, &t, "Export Failed", &detail, None),
    }
    buttons(ui, app, &t);
}

fn result(ui: &mut Ui, t: &Theme, title: &str, detail: &str, progress: Option<(u32, u32)>) {
    egui::Frame::NONE.inner_margin(egui::Margin::symmetric(16, 14)).show(ui, |ui| {
        ui.spacing_mut().item_spacing.y = 6.0;
        ui.label(egui::RichText::new(title).size(13.0).strong().color(t.text1));
        ui.add(egui::Label::new(egui::RichText::new(detail).size(11.5).color(t.text2)).wrap());
        if let Some((done, total)) = progress {
            let (bar, _) = ui.allocate_exact_size(vec2(ui.available_width(), 4.0), Sense::hover());
            ui.painter().rect_filled(bar, CornerRadius::same(2), Color32::from_white_alpha(18));
            let mut fill = bar;
            fill.set_width(bar.width() * done as f32 / total as f32);
            ui.painter().rect_filled(fill, CornerRadius::same(2), t.accent);
            ui.label(egui::RichText::new(format!("Frame {done} of {total}")).size(10.5).color(t.text3));
        }
    });
}

fn buttons(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme) {
    let state = shown(app);
    page_footer(ui, t, |ui| match state {
        Shown::Settings => {
            let (w, h) = movie_size(app.movie.shape, app.movie.resolution);
            ui.label(egui::RichText::new(format!("{w} × {h} · MP4 (H.264)")).size(11.0).color(t.text3));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let label = if app.movie.targets.len() > 1 { "Choose Folder…" } else { "Continue…" };
                if accent_button(ui, t, label, true).clicked() {
                    app.choose_movie_destination();
                }
            });
        }
        Shown::Waiting(_) | Shown::Running(..) => {
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if secondary_button(ui, t, "Continue in Background", true).clicked() {
                    app.movie.open = false;
                    app.queue_panel.open = true;
                    app.panels.unfold(PanelKind::Queue);
                }
                if secondary_button(ui, t, "Cancel Export", true).clicked()
                    && let Some(id) = app.movie.job.clone()
                {
                    app.queue.cancel(&id);
                }
            });
        }
        Shown::Cancelling(_) => {}
        Shown::Complete(dest) => {
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if accent_button(ui, t, "Done", true).clicked() {
                    app.movie.open = false;
                    app.movie.job = None;
                }
                if secondary_button(ui, t, "Show in Finder", true).clicked() {
                    reveal(app, dest);
                }
            });
        }
        Shown::Failed(_) => {
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if accent_button(ui, t, "Back to Settings", true).clicked() {
                    app.movie.job = None;
                    app.movie.error = None;
                }
            });
        }
    });
}

pub(crate) fn reveal(app: &mut BrickMotionApp, path: PathBuf) {
    if app.dialogs_enabled() {
        let _ = std::process::Command::new("open").arg("-R").arg(&path).spawn();
    } else {
        app.revealed = Some(path);
    }
}

/// The description under the settings (Swift's copy).
fn description(app: &BrickMotionApp) -> String {
    let m = &app.movie;
    match (&m.camera, m.source) {
        (_, MovieSource::Turntable) => "Show the assembled model in one full orbit.".into(),
        (CameraPick::Viewport, _) => "Keep your viewing angle and frame the model for the output shape.".into(),
        (CameraPick::Track, s) => {
            format!("Film the {} with your camera keys and moves.", if s == MovieSource::Keyframes { "timeline" } else { "build" })
        }
        (CameraPick::Saved(_), _) => "Keep the saved position, target, and lens.".into(),
        (_, MovieSource::Keyframes) => "Render the authored scene range, including linked build motion.".into(),
        _ => "Follow the build, including your step holds and motion edits.".into(),
    }
}

/// One frame-shape tile: its outline at the shape's aspect, name and ratio.
pub(crate) fn shape_tile(ui: &mut Ui, t: &Theme, shape: FrameShape, selected: bool, width: f32) -> egui::Response {
    let (r, resp) = ui.allocate_exact_size(vec2(width, 66.0), Sense::click());
    let label = format!("{}, {}", shape.title(), shape.ratio());
    resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, selected, &label));
    let p = ui.painter();
    let fill = if selected { t.accent_bg() } else { Color32::from_white_alpha(9) };
    p.rect_filled(r, CornerRadius::same(8), fill);
    let edge = if selected { Stroke::new(1.5, t.accent) } else { Stroke::new(0.5, Color32::from_white_alpha(30)) };
    p.rect_stroke(r, CornerRadius::same(8), edge, StrokeKind::Inside);
    let (w, h) = movie_size(shape, MovieResolution::Standard);
    let aspect = w as f32 / h as f32;
    let box_size = vec2((26.0 * aspect).min(30.0), (30.0 / aspect).min(26.0));
    let outline = egui::Rect::from_center_size(pos2(r.center().x, r.top() + 19.0), box_size);
    p.rect_stroke(outline, CornerRadius::same(2), Stroke::new(1.5, if selected { t.accent } else { t.text3 }), StrokeKind::Inside);
    p.text(pos2(r.center().x, r.top() + 42.0), egui::Align2::CENTER_CENTER, shape.title(), FontId::proportional(11.0), t.text1);
    p.text(pos2(r.center().x, r.top() + 55.0), egui::Align2::CENTER_CENTER, shape.ratio(), FontId::proportional(10.0), t.text3);
    resp.on_hover_cursor(egui::CursorIcon::PointingHand)
}

fn settings(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme) {
    fix_camera(app);
    egui::Frame::NONE.inner_margin(egui::Margin { left: 12, right: 12, top: 10, bottom: 4 }).show(ui, |ui| {
        let mut i = MovieSource::ALL.iter().position(|s| *s == app.movie.source).unwrap_or(0);
        let titles: Vec<&str> = MovieSource::ALL.iter().map(|s| s.title()).collect();
        if segmented(ui, t, "movie-source", &titles, &mut i, true) {
            app.movie.source = MovieSource::ALL[i];
        }
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            let w = (ui.available_width() - 18.0) / 4.0;
            for &shape in FrameShape::ALL {
                if shape_tile(ui, t, shape, shape == app.movie.shape, w).clicked() {
                    app.movie.shape = shape;
                }
            }
        });
    });
    ui.add_space(6.0);
    let allows_track = allows_track(app);
    let allows_saved = allows_saved(app);
    inset_group(ui, |ui| {
        let m = &mut app.movie;
        let sizes: Vec<String> = MovieResolution::ALL
            .iter()
            .map(|r| {
                let (w, h) = movie_size(m.shape, *r);
                format!("{w} × {h}")
            })
            .collect();
        let refs: Vec<&str> = sizes.iter().map(String::as_str).collect();
        let mut i = MovieResolution::ALL.iter().position(|r| *r == m.resolution).unwrap_or(1);
        if popup_row(ui, t, "movie-res", "Resolution", refs[i], &refs, &mut i, true) {
            m.resolution = MovieResolution::ALL[i];
        }
        hairline(ui);
        let titles: Vec<&str> = MovieQuality::ALL.iter().map(|q| q.title()).collect();
        let mut i = MovieQuality::ALL.iter().position(|q| *q == m.quality).unwrap_or(1);
        if popup_row(ui, t, "movie-quality", "Quality", titles[i], &titles, &mut i, true) {
            m.quality = MovieQuality::ALL[i];
        }
        hairline(ui);
        let rates: Vec<String> = FPS.iter().map(|f| format!("{f} fps")).collect();
        let refs: Vec<&str> = rates.iter().map(String::as_str).collect();
        let mut i = FPS.iter().position(|f| *f == m.fps).unwrap_or(2);
        if popup_row(ui, t, "movie-fps", "Frame Rate", refs[i], &refs, &mut i, true) {
            m.fps = FPS[i];
        }
        hairline(ui);
        // Only the cameras this video can use are offered.
        let mut picks: Vec<(CameraPick, String)> = vec![(CameraPick::Director, "Automatic Camera".into())];
        if (m.has_build_track || m.has_timeline_track) && allows_track {
            picks.push((CameraPick::Track, "Camera Track".into()));
        }
        if m.angles.present {
            picks.push((CameraPick::Viewport, "Viewport Angle".into()));
        }
        if allows_saved {
            picks.extend(m.saved.iter().map(|(id, name)| (CameraPick::Saved(id.clone()), name.clone())));
        }
        let names: Vec<&str> = picks.iter().map(|(_, n)| n.as_str()).collect();
        let mut i = picks.iter().position(|(p, _)| *p == m.camera).unwrap_or(0);
        if popup_row(ui, t, "movie-camera", "Camera", names[i], &names, &mut i, true) {
            m.camera = picks[i].0.clone();
        }
        if m.source == MovieSource::Turntable {
            hairline(ui);
            let secs: Vec<String> = SECONDS.iter().map(|s| format!("{s} seconds")).collect();
            let refs: Vec<&str> = secs.iter().map(String::as_str).collect();
            let mut i = SECONDS.iter().position(|s| *s == m.turntable_seconds).unwrap_or(2);
            if popup_row(ui, t, "movie-seconds", "Duration", refs[i], &refs, &mut i, true) {
                m.turntable_seconds = SECONDS[i];
            }
        }
    });
    ui.add_space(8.0);
    logo_row(ui, app, t);
    if app.movie.source == MovieSource::Build && !app.movie.standard_preview {
        ui.add_space(8.0);
        inset_group(ui, |ui| {
            switch_row(ui, t, "Include Snap Sounds", &mut app.movie.include_snap_audio, true);
        });
    }
    footnote(ui, t, &description(app));
    ui.add_space(8.0);
}

/// The logo: a preview, Off or a corner, and Choose… / Remove Logo.
fn logo_row(ui: &mut Ui, app: &mut BrickMotionApp, t: &Theme) {
    let current = crate::logo::current(&app.support, &app.prefs);
    let mut choose = false;
    let mut remove = false;
    inset_group(ui, |ui| {
        let Some(file) = &current else {
            egui::Frame::NONE.inner_margin(egui::Margin::symmetric(12, 6)).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new("Logo").size(12.5).color(t.text1));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        choose = secondary_button(ui, t, "Choose Logo…", true).clicked();
                    });
                });
            });
            return;
        };
        let mut options = vec!["Off"];
        options.extend(LogoCorner::ALL.iter().map(|c| c.title()));
        let mut i = if app.prefs.video_logo_enabled { 1 + LogoCorner::ALL.iter().position(|c| *c == crate::logo::corner(&app.prefs)).unwrap_or(3) } else { 0 };
        let shown = options[i];
        ui.horizontal(|ui| {
            ui.add_space(8.0);
            if app.movie.logo_texture.as_ref().is_none_or(|(p, _)| p != file) {
                // Once per logo file, a failure included.
                app.movie.logo_reads += 1;
                let tex = crate::logo::thumbnail(file).map(|pixels| ui.ctx().load_texture("video-logo", pixels, egui::TextureOptions::LINEAR));
                app.movie.logo_texture = Some((file.clone(), tex));
            }
            if let Some((_, Some(tex))) = &app.movie.logo_texture {
                let tint = if app.prefs.video_logo_enabled { Color32::WHITE } else { Color32::from_white_alpha(100) };
                ui.add(egui::Image::new(tex).max_size(vec2(34.0, 20.0)).tint(tint));
            }
            if popup_row(ui, t, "movie-logo", "Logo", shown, &options, &mut i, true) {
                app.prefs.video_logo_enabled = i > 0;
                if i > 0 {
                    app.prefs.video_logo_corner = LogoCorner::ALL[i - 1].code().to_owned();
                }
                let _ = app.prefs.save(&app.support);
            }
        });
        hairline(ui);
        egui::Frame::NONE.inner_margin(egui::Margin::symmetric(12, 6)).show(ui, |ui| {
            ui.horizontal(|ui| {
                choose = secondary_button(ui, t, "Replace Logo…", true).clicked();
                remove = secondary_button(ui, t, "Remove Logo", true).clicked();
            });
        });
    });
    if remove {
        crate::logo::remove(&mut app.prefs);
        let _ = app.prefs.save(&app.support);
    }
    if choose && app.dialogs_enabled() {
        let picked = rfd::FileDialog::new()
            .set_title("The logo appears in a corner of every exported video.")
            .add_filter("Image", &crate::logo::EXTENSIONS)
            .pick_file();
        if let Some(src) = picked {
            app.start_logo(src);
        }
    } else if choose {
        app.dialog_requests.push(DialogRequest { kind: "logo", suggested: None });
    }
}
