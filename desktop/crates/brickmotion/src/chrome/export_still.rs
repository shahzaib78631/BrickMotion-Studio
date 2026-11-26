//! The Export Still panel (Swift `StillExportSheet`): a path-traced picture in a video frame
//! shape, rendered in the background by the Render Queue's `bmexport` helper. With the video
//! logo on, the logo is drawn over the picture before it reaches the destination.
use std::path::{Path, PathBuf};

use bm::export::{FrameShape, StillChoice, StillQuality, ViewAngles, still_arguments, still_size, still_summary};
use egui::Ui;

use super::export_movie::shape_tile;
use super::float_panel::{self, Head, PanelKind};
use super::widgets::{accent_button, footnote, hairline, inset_group, page_footer, popup_row, switch_row};
use crate::BrickMotionApp;
use crate::app::DialogRequest;
use crate::icons::Icon;
use crate::render_queue::{Finish, Operation};
use crate::theme::Theme;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StillCamera {
    Viewport,
    Automatic,
}

pub struct StillPanel {
    pub open: bool,
    pub shape: FrameShape,
    pub large: bool,
    pub quality: StillQuality,
    pub camera: StillCamera,
    pub show_logo: bool,
    pub angles: ViewAngles,
    pub error: Option<String>,
    title: String,
}

impl Default for StillPanel {
    fn default() -> Self {
        StillPanel {
            open: false,
            shape: FrameShape::Landscape,
            large: false,
            quality: StillQuality::Standard,
            camera: StillCamera::Automatic,
            show_logo: false,
            angles: ViewAngles::default(),
            error: None,
            title: String::new(),
        }
    }
}

pub fn toggle(app: &mut BrickMotionApp) {
    if app.still.open {
        app.still.open = false;
        return;
    }
    let angles = app.doc.viewport().map(|vp| bm::export::view_angles(vp.camera())).unwrap_or_default();
    let title = crate::export_files::display_name(&app.doc.session().title());
    let show_logo = crate::logo::stamp(&app.support, &app.prefs).is_some();
    let s = &mut app.still;
    s.title = title;
    s.angles = angles;
    s.camera = if angles.present { StillCamera::Viewport } else { StillCamera::Automatic };
    s.show_logo = show_logo;
    s.error = None;
    s.open = true;
    app.panels.unfold(PanelKind::Still);
}

pub fn is_open(app: &BrickMotionApp) -> bool {
    app.still.open
}

pub fn choice(app: &BrickMotionApp) -> StillChoice {
    let s = &app.still;
    StillChoice { shape: s.shape, large: s.large, quality: s.quality, viewport_angle: s.camera == StillCamera::Viewport, angles: s.angles }
}

impl BrickMotionApp {
    /// Continue…: asks where the picture goes.
    pub fn choose_still_destination(&mut self) {
        let suggested = format!("{} – {}.png", self.still.title, self.still.shape.title());
        if !self.dialogs_enabled() {
            self.dialog_requests.push(DialogRequest { kind: "still", suggested: Some(suggested) });
            return;
        }
        let mut dialog = rfd::FileDialog::new().set_title("Export Still").add_filter("PNG image", &["png"]).set_file_name(&suggested);
        if let Some(dir) = self.state.path.as_deref().and_then(Path::parent) {
            dialog = dialog.set_directory(dir);
        }
        if let Some(path) = dialog.save_file() {
            self.finish_still(path);
        }
    }

    /// Queues the picture at `path` and shows the Render Queue.
    pub fn finish_still(&mut self, path: PathBuf) {
        let choice = choice(self);
        let stamp = if self.still.show_logo { crate::logo::stamp(&self.support, &self.prefs) } else { None };
        let summary = still_summary(&choice, stamp.is_some());
        let options = still_arguments(&choice, &self.doc.session().render_look());
        let finish: Option<Finish> =
            stamp.map(|(logo, corner)| Box::new(move |png: &Path| bm::export::stamp_logo(png, &logo, corner)) as Finish);
        let project = self.doc.session().project_bytes();
        let library = bm::ldraw_directory().unwrap_or_default();
        match self.queue.enqueue(project, Operation::Still, options, &library, path, summary, finish) {
            Ok(_) => {
                self.still.open = false;
                self.queue_panel.open = true;
                self.panels.unfold(PanelKind::Queue);
            }
            Err(e) => self.still.error = Some(e),
        }
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: egui::Rect, next_top: &mut f32) {
    if !app.still.open {
        return;
    }
    let subtitle = app.still.title.clone();
    let out = float_panel::show(ui, app, area, next_top, PanelKind::Still, Head { icon: Icon::Cam, title: "", subtitle: &subtitle }, body);
    if out.close {
        app.still.open = false;
    }
}

fn body(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t: Theme = app.theme;
    egui::Frame::NONE.inner_margin(egui::Margin { left: 12, right: 12, top: 10, bottom: 4 }).show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            let w = (ui.available_width() - 18.0) / 4.0;
            for &shape in FrameShape::ALL {
                if shape_tile(ui, &t, shape, shape == app.still.shape, w).clicked() {
                    app.still.shape = shape;
                }
            }
        });
    });
    ui.add_space(6.0);
    let has_logo = crate::logo::current(&app.support, &app.prefs).is_some();
    inset_group(ui, |ui| {
        let s = &mut app.still;
        let sizes: Vec<String> = [false, true]
            .iter()
            .map(|&large| {
                let (w, h) = still_size(s.shape, large);
                format!("{w} × {h}")
            })
            .collect();
        let refs: Vec<&str> = sizes.iter().map(String::as_str).collect();
        let mut i = usize::from(s.large);
        if popup_row(ui, &t, "still-size", "Size", refs[i], &refs, &mut i, true) {
            s.large = i == 1;
        }
        hairline(ui);
        let qualities: Vec<String> = StillQuality::ALL.iter().map(|q| format!("{} · {} samples", q.title(), q.samples())).collect();
        let refs: Vec<&str> = qualities.iter().map(String::as_str).collect();
        let mut i = StillQuality::ALL.iter().position(|q| *q == s.quality).unwrap_or(1);
        if popup_row(ui, &t, "still-quality", "Quality", refs[i], &refs, &mut i, true) {
            s.quality = StillQuality::ALL[i];
        }
        hairline(ui);
        // Only the cameras this picture can use are offered.
        let mut cameras = Vec::new();
        if s.angles.present {
            cameras.push((StillCamera::Viewport, "Viewport Angle"));
        }
        cameras.push((StillCamera::Automatic, "Automatic Framing"));
        let names: Vec<&str> = cameras.iter().map(|(_, n)| *n).collect();
        let mut i = cameras.iter().position(|(c, _)| *c == s.camera).unwrap_or(0);
        if popup_row(ui, &t, "still-camera", "Camera", names[i], &names, &mut i, true) {
            s.camera = cameras[i].0;
        }
        if has_logo {
            hairline(ui);
            switch_row(ui, &t, "Show the Video Logo", &mut s.show_logo, true);
        }
    });
    let note = if app.still.shape == FrameShape::Landscape {
        "Path traced in the background. The Render Queue shows its progress."
    } else {
        "Vertical, portrait and square shapes make covers for social posts."
    };
    footnote(ui, &t, note);
    if let Some(e) = &app.still.error {
        footnote(ui, &t, e);
    }
    ui.add_space(8.0);
    page_footer(ui, &t, |ui| {
        let (w, h) = still_size(app.still.shape, app.still.large);
        ui.label(egui::RichText::new(format!("{w} × {h} · PNG")).size(11.0).color(t.text3));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if accent_button(ui, &t, "Continue…", true).clicked() {
                app.choose_still_destination();
            }
        });
    });
}
