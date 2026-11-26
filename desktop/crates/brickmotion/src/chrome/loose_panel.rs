//! Seat Loose Pieces floating panel (Swift `LoosePiecesSheet`): pieces placed a little off their
//! connector, seated exactly in one undo step using the engine's choice rules.
use std::time::Duration;

use bm::Pose;
use bm::motion::{Inspection, LoosePieces};
use egui::{Color32, CornerRadius, Frame, Margin, Rect, RichText, Sense, Stroke, StrokeKind, Ui, WidgetInfo, pos2, vec2};

use super::float_panel::{self, Head, PanelKind};
use super::icon_button_tip;
use super::widgets::{accent_button, footnote, hairline, inset_group, section_header};
use crate::BrickMotionApp;
use crate::icons::Icon;
use crate::theme::Theme;
use crate::viewport::ViewOp;
use crate::workers::{Job, Stale};

type DocKey = (u64, u64);

#[derive(Default)]
pub struct LoosePanel {
    pub open: bool,
    pub chosen: Vec<u32>,
    job: Job<DocKey, LoosePieces>,
    started: Option<DocKey>,
    pub result: Option<(DocKey, LoosePieces)>,
}

impl LoosePanel {
    pub fn reset(&mut self) {
        self.open = false;
        self.chosen.clear();
        self.job.cancel();
        self.started = None;
        self.result = None;
    }

    pub fn busy(&self) -> bool {
        self.job.busy()
    }
}

pub fn is_open(app: &BrickMotionApp) -> bool {
    app.loose.open
}

pub fn toggle(app: &mut BrickMotionApp) {
    app.loose.open = !app.loose.open;
    if app.loose.open {
        app.panels.unfold(PanelKind::Loose);
        app.loose.result = None;
        app.loose.chosen.clear();
        start_check(app);
    } else {
        app.loose.job.cancel();
        app.loose.started = None;
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
    app.loose.job.cancel();
    app.loose.started = None;
    let Some(mut inspection) = Inspection::capture(app.doc.session()) else { return };
    let wake = app.ctx_handle();
    if app.loose.job.start(key, move || {
        let out = inspection.loose_pieces();
        if let Some(ctx) = wake {
            ctx.request_repaint();
        }
        out
    }) {
        app.loose.started = Some(key);
    }
}

/// Polls the loose-piece check. Drops stale in-flight results and restarts; once results are shown,
/// keeps them until Seat is clicked so a stale revision refuses cleanly and then recomputes.
pub fn sync(app: &mut BrickMotionApp, ctx: &egui::Context) {
    if !app.loose.open || !app.has_document {
        app.loose.job.cancel();
        app.loose.started = None;
        return;
    }
    let key = doc_key(app);
    match app.loose.job.poll(&key) {
        Some(Ok(loose)) => {
            app.loose.chosen = loose.initial_choice();
            app.loose.result = Some((key, loose));
            app.loose.started = None;
        }
        Some(Err(Stale)) => {
            app.loose.started = None;
        }
        None => {}
    }
    if app.loose.result.is_none() && app.loose.started.is_some_and(|k| k != key) {
        app.loose.job.cancel();
        app.loose.started = None;
    }
    if app.loose.result.is_none() && !app.loose.job.busy() {
        start_check(app);
    }
    if app.loose.job.busy() {
        ctx.request_repaint_after(Duration::from_millis(30));
    }
}

/// "Red Brick 2 x 4": colour name plus display name, matching Swift `LoosePiecesSheet.name(_:)`.
pub(crate) fn piece_name(app: &mut BrickMotionApp, piece: u32) -> String {
    let m = app.doc.session().part_at(piece);
    let raw = if m.description.is_empty() { &m.name } else { &m.description };
    let part = bm::export::display_name(raw);
    let code = app.doc.session().part_color(piece);
    let colors = app.colors();
    match colors.iter().find(|c| c.code == code) {
        Some(c) if !c.name.is_empty() => format!("{} {}", c.name, part),
        _ => part,
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect, next_top: &mut f32) {
    if !app.loose.open {
        return;
    }
    let out = float_panel::show(
        ui,
        app,
        area,
        next_top,
        PanelKind::Loose,
        Head { icon: Icon::Seat, title: "", subtitle: "" },
        body,
    );
    if out.close {
        app.loose.open = false;
        app.loose.job.cancel();
        app.loose.started = None;
    }
}

fn checkbox(ui: &mut Ui, t: &Theme, label: &str, checked: bool, enabled: bool) -> bool {
    let (rect, resp) = ui.allocate_exact_size(vec2(16.0, 16.0), if enabled { Sense::click() } else { Sense::hover() });
    resp.widget_info(|| WidgetInfo::selected(egui::Role::CheckBox, enabled, checked, label));
    let p = ui.painter();
    let r = CornerRadius::same(4);
    if checked {
        let fill = if enabled {
            t.accent
        } else {
            Color32::from_rgba_unmultiplied(t.accent.r(), t.accent.g(), t.accent.b(), 100)
        };
        p.rect_filled(rect, r, fill);
        let c = rect.center();
        let stroke = Stroke::new(1.8, Color32::WHITE);
        p.line_segment([pos2(c.x - 3.8, c.y + 0.2), pos2(c.x - 1.0, c.y + 3.0)], stroke);
        p.line_segment([pos2(c.x - 1.0, c.y + 3.0), pos2(c.x + 4.0, c.y - 2.8)], stroke);
    } else {
        let border = if enabled {
            if resp.hovered() { t.text2 } else { t.border2 }
        } else {
            t.border
        };
        p.rect(rect, r, t.bg1, Stroke::new(1.2, border), StrokeKind::Inside);
    }
    if enabled {
        resp.on_hover_cursor(egui::CursorIcon::PointingHand).clicked()
    } else {
        false
    }
}

struct RowDisplay {
    piece: u32,
    onto: u32,
    safe: bool,
    name: String,
    subtitle: String,
    waiting: bool,
    checked: bool,
}

fn body(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;
    footnote(ui, &t, "Pieces placed a little off their studs, pins or clips, set exactly in place.");

    if app.loose.result.is_none() {
        Frame::NONE.inner_margin(Margin::symmetric(16, 24)).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.spinner();
                ui.add_space(6.0);
                ui.label(RichText::new("Looking for loose pieces…").size(12.5).color(t.text2));
            });
        });
        return;
    }

    let (res_key, error, row_count) = {
        let (k, l) = app.loose.result.as_ref().unwrap();
        (*k, l.error.clone(), l.rows.len())
    };

    if let Some(err) = error {
        Frame::NONE.inner_margin(Margin::symmetric(16, 20)).show(ui, |ui| {
            ui.label(RichText::new("Couldn’t Check the Model").strong().size(13.0).color(t.text1));
            ui.add_space(4.0);
            ui.label(RichText::new(err).size(11.5).color(t.text3));
        });
        return;
    }

    if row_count == 0 {
        Frame::NONE.inner_margin(Margin::symmetric(16, 22)).show(ui, |ui| {
            ui.label(RichText::new("Every Piece Is Seated").strong().size(13.0).color(t.text1));
            ui.add_space(4.0);
            ui.label(RichText::new("No piece sits off the connector that holds it.").size(11.5).color(t.text3));
        });
        return;
    }

    // Build display data once (piece_name needs &mut app for color cache).
    let raw_rows: Vec<(usize, u32, u32, bool)> = app
        .loose
        .result
        .as_ref()
        .unwrap()
        .1
        .rows
        .iter()
        .enumerate()
        .map(|(i, r)| (i, r.piece, r.onto, r.safe))
        .collect();
    let chosen_snapshot = app.loose.chosen.clone();
    let mut rows = Vec::with_capacity(raw_rows.len());
    for (idx, piece, onto, safe) in raw_rows {
        let name = piece_name(app, piece);
        let waiting_id = app.loose.result.as_ref().unwrap().1.waiting_on(piece, &chosen_snapshot);
        let subtitle = match waiting_id {
            Some(holder) => format!("Seated onto {}: check it first", piece_name(app, holder)),
            None => {
                let onto_name = piece_name(app, onto);
                app.loose.result.as_ref().unwrap().1.detail(idx, &onto_name)
            }
        };
        rows.push(RowDisplay {
            piece,
            onto,
            safe,
            name,
            subtitle,
            waiting: waiting_id.is_some(),
            checked: chosen_snapshot.contains(&piece),
        });
    }

    let count_str = rows.len().to_string();
    section_header(ui, &t, "Loose Pieces", Some(&count_str));

    let mut toggle_piece: Option<(u32, bool)> = None;
    let mut reveal: Option<[u32; 2]> = None;

    inset_group(ui, |ui| {
        for (i, r) in rows.iter().enumerate() {
            if i > 0 {
                hairline(ui);
            }
            Frame::NONE.inner_margin(Margin::symmetric(12, 8)).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 8.0;
                    if checkbox(ui, &t, &format!("Seat {}", r.name), r.checked, !r.waiting) {
                        toggle_piece = Some((r.piece, !r.checked));
                    }
                    let text_w = (ui.available_width() - 32.0).max(100.0);
                    ui.vertical(|ui| {
                        ui.set_max_width(text_w);
                        ui.spacing_mut().item_spacing.y = 2.0;
                        ui.label(
                            RichText::new(&r.name)
                                .size(12.0)
                                .strong()
                                .color(if r.waiting { t.text3 } else { t.text1 }),
                        );
                        let detail_color = if r.safe || r.waiting { t.text3 } else { t.playhead };
                        ui.label(RichText::new(&r.subtitle).size(11.0).color(detail_color));
                    });
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if icon_button_tip(
                            ui,
                            &t,
                            Icon::Fit,
                            &format!("Show {}", r.name),
                            "Select and frame it with what holds it",
                            true,
                            false,
                            24.0,
                        )
                        .clicked()
                        {
                            reveal = Some([r.piece, r.onto]);
                        }
                    });
                });
            });
        }
    });

    if let Some((piece, on)) = toggle_piece {
        if on {
            if !app.loose.chosen.contains(&piece) {
                app.loose.chosen.push(piece);
            }
        } else if let Some((_, loose)) = &app.loose.result {
            app.loose.chosen = loose.uncheck(piece, &app.loose.chosen);
        }
    }

    if let Some(ids) = reveal && doc_key(app) == res_key {
        if let Some(vp) = app.doc.viewport() {
            vp.show_rest();
        }
        let s = app.doc.session();
        s.show(&ids);
        s.select(&ids, bm::SelectMode::Replace);
        app.viewport.queue(ViewOp::FrameSelection);
    }

    // Footer: "n of m selected" + "Seat Piece" / "Seat n Pieces".
    let n_chosen = app.loose.chosen.len();
    let note = format!("{n_chosen} of {row_count} selected");
    let action = if n_chosen == 1 { "Seat Piece".to_owned() } else { format!("Seat {n_chosen} Pieces") };
    let mut do_seat = false;
    ui.add_space(10.0);
    Frame::NONE.inner_margin(Margin::symmetric(16, 0)).show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.label(RichText::new(&note).size(11.5).color(t.text3));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if accent_button(ui, &t, &action, n_chosen > 0).clicked() {
                    do_seat = true;
                }
            });
        });
    });

    if do_seat {
        let moves: Vec<(u32, Pose)> = app
            .loose
            .result
            .as_ref()
            .map(|(_, l)| {
                l.rows
                    .iter()
                    .filter(|r| app.loose.chosen.contains(&r.piece))
                    .map(|r| (r.piece, r.pose))
                    .collect()
            })
            .unwrap_or_default();
        let c = app.doc.session().seat_pieces(&moves, res_key.0, res_key.1);
        let refused = c.refused.is_some();
        app.edited(c);
        if refused {
            app.loose.result = None;
            app.loose.chosen.clear();
            start_check(app);
        } else {
            app.loose.open = false;
            app.loose.result = None;
            app.loose.chosen.clear();
        }
    }
}
