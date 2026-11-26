//! Model Checks floating panel (Swift `ModelChecksSheet`): geometry, stability, connection and
//! load-report findings grouped by kind, plus the last refused edit with Dismiss.
use std::time::Duration;

use bm::motion::{CheckKind, Inspection, ModelChecks};
use egui::{Frame, Margin, Rect, RichText, Ui};

use super::float_panel::{self, Head, PanelKind};
use super::icon_button_tip;
use super::widgets::{hairline, inset_group, secondary_button, section_header};
use crate::BrickMotionApp;
use crate::icons::Icon;
use crate::viewport::ViewOp;
use crate::workers::{Job, Stale};

type DocKey = (u64, u64);

#[derive(Default)]
pub struct ChecksPanel {
    pub open: bool,
    job: Job<DocKey, ModelChecks>,
    started: Option<DocKey>,
    pub result: Option<(DocKey, ModelChecks)>,
}

impl ChecksPanel {
    pub fn reset(&mut self) {
        self.open = false;
        self.job.cancel();
        self.started = None;
        self.result = None;
    }

    pub fn busy(&self) -> bool {
        self.job.busy()
    }
}

pub fn is_open(app: &BrickMotionApp) -> bool {
    app.checks.open
}

pub fn toggle(app: &mut BrickMotionApp) {
    app.checks.open = !app.checks.open;
    if app.checks.open {
        app.panels.unfold(PanelKind::Checks);
        start_check(app);
    } else {
        app.checks.job.cancel();
        app.checks.started = None;
    }
}

fn doc_key(app: &BrickMotionApp) -> DocKey {
    let s = app.doc.session();
    (s.generation(), s.version())
}

fn start_check(app: &mut BrickMotionApp) {
    if !app.has_document {
        return;
    }
    let key = doc_key(app);
    if app.checks.result.as_ref().is_some_and(|(k, _)| *k == key) || app.checks.started == Some(key) {
        return;
    }
    app.checks.job.cancel();
    app.checks.started = None;
    let Some(mut inspection) = Inspection::capture(app.doc.session()) else { return };
    let wake = app.ctx_handle();
    if app.checks.job.start(key, move || {
        let out = inspection.check_model();
        if let Some(ctx) = wake {
            ctx.request_repaint();
        }
        out
    }) {
        app.checks.started = Some(key);
    }
}

/// Polls the background model check and restarts it whenever the document changes.
pub fn sync(app: &mut BrickMotionApp, ctx: &egui::Context) {
    if !app.checks.open || !app.has_document {
        app.checks.job.cancel();
        app.checks.started = None;
        return;
    }
    let key = doc_key(app);
    match app.checks.job.poll(&key) {
        Some(Ok(checks)) => {
            app.checks.result = Some((key, checks));
            app.checks.started = None;
        }
        Some(Err(Stale)) => {
            app.checks.started = None;
        }
        None => {}
    }
    if app.checks.result.as_ref().is_some_and(|(k, _)| *k != key) {
        app.checks.result = None;
    }
    if app.checks.started.is_some_and(|k| k != key) {
        app.checks.job.cancel();
        app.checks.started = None;
    }
    if app.checks.result.is_none() && !app.checks.job.busy() {
        start_check(app);
    }
    if app.checks.job.busy() {
        ctx.request_repaint_after(Duration::from_millis(30));
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect, next_top: &mut f32) {
    if !app.checks.open {
        return;
    }
    let subtitle = app.title();
    let out = float_panel::show(
        ui,
        app,
        area,
        next_top,
        PanelKind::Checks,
        Head { icon: Icon::Checks, title: "", subtitle: &subtitle },
        body,
    );
    if out.close {
        app.checks.open = false;
        app.checks.job.cancel();
        app.checks.started = None;
    }
}

fn body(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;
    let key = doc_key(app);
    let current = app.checks.result.as_ref().filter(|(k, _)| *k == key).map(|(_, c)| c.clone());
    let Some(report) = current else {
        Frame::NONE.inner_margin(Margin::symmetric(16, 28)).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.spinner();
                ui.add_space(6.0);
                ui.label(RichText::new("Checking the model…").size(12.5).color(t.text2));
            });
        });
        return;
    };

    if let Some(err) = &report.error {
        Frame::NONE.inner_margin(Margin::symmetric(16, 20)).show(ui, |ui| {
            ui.label(RichText::new("Couldn’t Check the Model").strong().size(13.0).color(t.text1));
            ui.add_space(4.0);
            ui.label(RichText::new(err).size(11.5).color(t.text3));
        });
        return;
    }

    if report.findings.is_empty() && app.last_refusal.is_none() {
        Frame::NONE.inner_margin(Margin::symmetric(16, 22)).show(ui, |ui| {
            ui.label(RichText::new("No Findings").strong().size(13.0).color(t.text1));
            ui.add_space(4.0);
            ui.label(
                RichText::new("The model passed the available geometry and connection checks.")
                    .size(11.5)
                    .color(t.text3),
            );
        });
        return;
    }

    let mut dismiss_refusal = false;
    if let Some(reason) = app.last_refusal.clone() {
        section_header(ui, &t, "Last Refused Edit", None);
        inset_group(ui, |ui| {
            Frame::NONE.inner_margin(Margin::symmetric(12, 8)).show(ui, |ui| {
                ui.label(RichText::new(reason).size(12.0).color(t.text1));
                ui.add_space(6.0);
                if secondary_button(ui, &t, "Dismiss", true).clicked() {
                    dismiss_refusal = true;
                }
            });
        });
    }
    if dismiss_refusal {
        app.last_refusal = None;
    }

    let mut reveal: Option<Vec<u32>> = None;
    for kind in CheckKind::ALL {
        let items: Vec<_> = report.findings.iter().filter(|f| f.kind == kind).collect();
        if items.is_empty() {
            continue;
        }
        let count = items.len().to_string();
        section_header(ui, &t, kind.title(), Some(&count));
        inset_group(ui, |ui| {
            for (idx, finding) in items.iter().enumerate() {
                if idx > 0 {
                    hairline(ui);
                }
                Frame::NONE.inner_margin(Margin::symmetric(12, 8)).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        let text_w = (ui.available_width() - if finding.pieces.is_empty() { 0.0 } else { 32.0 }).max(100.0);
                        ui.vertical(|ui| {
                            ui.set_max_width(text_w);
                            ui.spacing_mut().item_spacing.y = 2.0;
                            ui.label(RichText::new(&finding.title).size(12.0).strong().color(t.text1));
                            ui.label(RichText::new(&finding.detail).size(11.0).color(t.text3));
                        });
                        if !finding.pieces.is_empty() {
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                let label = format!("Frame {}", finding.title);
                                if icon_button_tip(ui, &t, Icon::Fit, &label, "Select and frame these parts", true, false, 24.0).clicked() {
                                    reveal = Some(finding.pieces.clone());
                                }
                            });
                        }
                    });
                });
            }
        });
    }

    if let Some(pieces) = reveal && doc_key(app) == key {
        if let Some(vp) = app.doc.viewport() {
            vp.show_rest();
        }
        let s = app.doc.session();
        s.show(&pieces);
        s.select(&pieces, bm::SelectMode::Replace);
        app.viewport.queue(ViewOp::FrameSelection);
    }
}
