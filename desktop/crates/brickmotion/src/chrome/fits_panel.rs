//! Compatible Parts ("What Fits") floating panel (Swift `CompatibleParts`): BrickNet "What
//! Builders Put Here" suggestions placed at their surveyed pose, and library parts that fit a
//! free connection on the selected piece.
use std::collections::HashMap;
use std::time::{Duration, Instant};

use bm::library::{PartMatch, common_parts, library_parts};
use bm::motion::{HabitFit, Inspection};
use bm::Vec3;
use egui::{Color32, CornerRadius, Frame, Margin, Pos2, Rect, RichText, Sense, Stroke, StrokeKind, Ui, WidgetInfo, pos2, vec2};

use super::float_panel::{self, Head, PanelKind};
use super::library::short_name;
use super::widgets::{accent_button, hairline, inset_group, section_header};
use crate::BrickMotionApp;
use crate::icons::{self, Icon};
use crate::previews::Preview;
use crate::workers::{Job, Stale};

type DocKey = (u64, u64);
type JobKey = (DocKey, u32, String);

const DEBOUNCE: Duration = Duration::from_millis(140);
const HABIT_LIMIT: usize = 8;
const CANDIDATE_LIMIT: usize = 160;
const FITTING_LIMIT: usize = 30;
const PREVIEW_COLOUR: i32 = 71; // Light Bluish Gray (matches Swift CompatibleParts)

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FitSelection {
    Habit(String),
    Part(String),
}

#[derive(Clone, Debug)]
pub struct FitMatch {
    pub part: PartMatch,
    pub contact: Vec3,
}

#[derive(Clone, Debug, Default)]
pub struct FitsResult {
    pub habits: Vec<HabitFit>,
    pub matches: Vec<FitMatch>,
}

#[derive(Default)]
pub struct FitsPanel {
    pub open: bool,
    pub piece: Option<u32>,
    pub target_name: String,
    pub query: String,
    last_query: String,
    pending_query: Option<(String, Instant)>,
    cached_habits: Option<(DocKey, u32, Vec<HabitFit>)>,
    job: Job<JobKey, FitsResult>,
    started: Option<JobKey>,
    pub result: Option<(DocKey, u32, String, FitsResult)>,
    pub selection: Option<FitSelection>,
    focus_search: bool,
}

impl FitsPanel {
    pub fn reset(&mut self) {
        self.open = false;
        self.piece = None;
        self.target_name.clear();
        self.query.clear();
        self.last_query.clear();
        self.pending_query = None;
        self.cached_habits = None;
        self.job.cancel();
        self.started = None;
        self.result = None;
        self.selection = None;
        self.focus_search = false;
    }

    pub fn busy(&self) -> bool {
        self.job.busy() || self.pending_query.is_some()
    }
}

pub fn is_open(app: &BrickMotionApp) -> bool {
    app.fits.open
}

fn doc_key(app: &BrickMotionApp) -> DocKey {
    let s = app.doc.session();
    (s.generation(), s.version())
}

pub fn toggle(app: &mut BrickMotionApp) {
    let sel = app.doc.session().selection();
    let Some(&piece) = (sel.len() == 1).then(|| sel.first()).flatten() else {
        app.fits.open = false;
        app.fits.job.cancel();
        return;
    };
    if app.fits.open && app.fits.piece == Some(piece) {
        app.fits.open = false;
        app.fits.job.cancel();
        app.fits.started = None;
        return;
    }
    let m = app.doc.session().part_at(piece);
    let raw = if m.description.is_empty() { &m.name } else { &m.description };
    app.fits.reset();
    app.fits.open = true;
    app.fits.piece = Some(piece);
    app.fits.target_name = bm::export::display_name(raw);
    app.fits.focus_search = true;
    app.panels.unfold(PanelKind::Fits);
    start_search(app, String::new());
}

fn start_search(app: &mut BrickMotionApp, query: String) {
    let Some(piece) = app.fits.piece else { return };
    if !app.has_document {
        return;
    }
    let dkey = doc_key(app);
    let key = (dkey, piece, query.clone());
    app.fits.job.cancel();
    app.fits.started = None;
    let Some(mut inspection) = Inspection::capture(app.doc.session()) else { return };
    let cached_habits = app
        .fits
        .cached_habits
        .as_ref()
        .filter(|(k, p, _)| *k == dkey && *p == piece)
        .map(|(_, _, h)| h.clone());
    let wake = app.ctx_handle();
    if app.fits.job.start(key.clone(), move || {
        let habits = cached_habits.unwrap_or_else(|| inspection.habit_fits(piece, HABIT_LIMIT));
        let candidates = if query.is_empty() {
            common_parts()
        } else {
            library_parts(&query, "", CANDIDATE_LIMIT)
        };
        let mut by_name: HashMap<String, PartMatch> = HashMap::with_capacity(candidates.len());
        let mut names: Vec<String> = Vec::with_capacity(candidates.len());
        for c in candidates {
            names.push(c.name.clone());
            by_name.entry(c.name.clone()).or_insert(c);
        }
        let matches = inspection
            .fitting_parts(piece, &names, FITTING_LIMIT)
            .into_iter()
            .filter_map(|fp| {
                let part = by_name.get(&fp.name)?.clone();
                Some(FitMatch { part, contact: fp.contact })
            })
            .collect();
        if let Some(ctx) = wake {
            ctx.request_repaint();
        }
        FitsResult { habits, matches }
    }) {
        app.fits.started = Some(key);
    }
}

pub fn sync(app: &mut BrickMotionApp, ctx: &egui::Context) {
    if !app.fits.open || !app.has_document {
        app.fits.job.cancel();
        app.fits.started = None;
        return;
    }

    // Handle 140 ms search debounce.
    if let Some((q, at)) = app.fits.pending_query.clone() {
        if q.is_empty() || at.elapsed() >= DEBOUNCE {
            app.fits.pending_query = None;
            start_search(app, q);
        } else {
            ctx.request_repaint_after(Duration::from_millis(20));
        }
    }

    if let Some(key) = app.fits.started.clone() {
        match app.fits.job.poll(&key) {
            Some(Ok(res)) => {
                let (dkey, piece, query) = key;
                app.fits.cached_habits = Some((dkey, piece, res.habits.clone()));
                app.fits.selection = if query.is_empty() && !res.habits.is_empty() {
                    Some(FitSelection::Habit(res.habits[0].name.clone()))
                } else if !res.matches.is_empty() {
                    Some(FitSelection::Part(res.matches[0].part.name.clone()))
                } else {
                    None
                };
                app.fits.result = Some((dkey, piece, query, res));
                app.fits.started = None;
            }
            Some(Err(Stale)) => {
                app.fits.started = None;
            }
            None => {}
        }
    }

    if app.fits.job.busy() {
        ctx.request_repaint_after(Duration::from_millis(30));
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect, next_top: &mut f32) {
    if !app.fits.open {
        return;
    }
    let subtitle = app.fits.target_name.clone();
    let out = float_panel::show(
        ui,
        app,
        area,
        next_top,
        PanelKind::Fits,
        Head { icon: Icon::Search, title: "", subtitle: &subtitle },
        body,
    );
    if out.close {
        app.fits.open = false;
        app.fits.job.cancel();
        app.fits.started = None;
    }
}

fn part_row(
    ui: &mut Ui,
    app: &mut BrickMotionApp,
    part_name: &str,
    color: i32,
    title: &str,
    detail: &str,
    selected: bool,
    id_salt: &str,
) -> bool {
    let t = app.theme;
    let fill = if selected { t.accent_bg() } else { Color32::TRANSPARENT };
    let inner = Frame::NONE
        .fill(fill)
        .inner_margin(Margin::symmetric(10, 6))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 8.0;
                let (thumb_rect, _) = ui.allocate_exact_size(vec2(36.0, 36.0), Sense::hover());
                ui.painter().rect(thumb_rect, 6.0, t.bg1, Stroke::new(1.0, t.border), StrokeKind::Inside);
                match app.previews.get(ui.ctx(), part_name, color) {
                    Preview::Ready(tex) => {
                        let uv = Rect::from_min_max(Pos2::ZERO, pos2(1.0, 1.0));
                        ui.painter().image(tex.id(), thumb_rect.shrink(2.0), uv, Color32::WHITE);
                    }
                    Preview::Pending => {
                        icons::paint(ui, Icon::Brick, thumb_rect.shrink(10.0), 16.0, t.text3);
                    }
                    Preview::Missing => {
                        icons::paint(ui, Icon::Brick, thumb_rect.shrink(10.0), 16.0, t.border2);
                    }
                }
                ui.vertical(|ui| {
                    ui.spacing_mut().item_spacing.y = 2.0;
                    ui.label(RichText::new(title).size(12.0).strong().color(t.text1));
                    ui.label(RichText::new(detail).size(11.0).color(t.text3));
                });
            });
        });
    let resp = ui.interact(inner.response.rect, ui.make_persistent_id(id_salt), Sense::click());
    resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, selected, format!("{title} — {detail}")));
    if !selected && resp.hovered() {
        ui.painter().rect_filled(inner.response.rect, CornerRadius::ZERO, Color32::from_white_alpha(8));
    }
    resp.on_hover_cursor(egui::CursorIcon::PointingHand).clicked()
}

fn body(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;

    // Search field.
    Frame::NONE.inner_margin(Margin { left: 12, right: 12, top: 8, bottom: 4 }).show(ui, |ui| {
        let edit = ui.add_sized(
            vec2(ui.available_width(), 26.0),
            egui::TextEdit::singleline(&mut app.fits.query)
                .hint_text("Search by part name or number"),
        );
        edit.widget_info(|| {
            let mut info = WidgetInfo::labeled(egui::Role::TextInput, true, "Search by part name or number");
            info.current_text_value = Some(app.fits.query.clone());
            info
        });
        if app.fits.focus_search {
            edit.request_focus();
            app.fits.focus_search = false;
        }
    });

    let trimmed = app.fits.query.trim().to_owned();
    if trimmed != app.fits.last_query {
        app.fits.last_query = trimmed.clone();
        app.fits.selection = None;
        app.fits.pending_query = Some((trimmed.clone(), Instant::now()));
    }

    let loading = app.fits.job.busy() || app.fits.pending_query.is_some() || app.fits.result.is_none();
    if loading {
        Frame::NONE.inner_margin(Margin::symmetric(16, 24)).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.spinner();
                ui.add_space(6.0);
                ui.label(RichText::new("Checking free connections…").size(12.5).color(t.text2));
            });
        });
        return;
    }

    let (res_key, res_query, res) = {
        let (k, _, q, r) = app.fits.result.as_ref().unwrap();
        (*k, q.clone(), r.clone())
    };
    let shown_habits: &[HabitFit] = if res_query.is_empty() { &res.habits } else { &[] };

    if shown_habits.is_empty() && res.matches.is_empty() {
        Frame::NONE.inner_margin(Margin::symmetric(16, 22)).show(ui, |ui| {
            ui.label(RichText::new("No Matching Parts").strong().size(13.0).color(t.text1));
            ui.add_space(4.0);
            let hint = if res_query.is_empty() {
                "Search the library for other parts."
            } else {
                "Try a different name or part number."
            };
            ui.label(RichText::new(hint).size(11.5).color(t.text3));
        });
        return;
    }

    let mut next_sel = app.fits.selection.clone();

    egui::ScrollArea::vertical()
        .id_salt("fits-list")
        .max_height(340.0)
        .auto_shrink([false, true])
        .show(ui, |ui| {
            if !shown_habits.is_empty() {
                let count = shown_habits.len().to_string();
                section_header(ui, &t, "What Builders Put Here", Some(&count));
                inset_group(ui, |ui| {
                    for (idx, h) in shown_habits.iter().enumerate() {
                        if idx > 0 {
                            hairline(ui);
                        }
                        let title = bm::export::display_name(if h.description.is_empty() { &h.name } else { &h.description });
                        let is_sel = matches!(&next_sel, Some(FitSelection::Habit(n)) if n == &h.name);
                        if part_row(ui, app, &h.name, h.color, &title, &h.why, is_sel, &format!("habit:{}", h.name)) {
                            next_sel = Some(FitSelection::Habit(h.name.clone()));
                        }
                    }
                });
            }

            if !res.matches.is_empty() {
                let count = res.matches.len().to_string();
                section_header(ui, &t, "Fits a Free Connection", Some(&count));
                inset_group(ui, |ui| {
                    for (idx, m) in res.matches.iter().enumerate() {
                        if idx > 0 {
                            hairline(ui);
                        }
                        let title = bm::export::display_name(if m.part.description.is_empty() { &m.part.name } else { &m.part.description });
                        let is_sel = matches!(&next_sel, Some(FitSelection::Part(n)) if n == &m.part.name);
                        if part_row(
                            ui,
                            app,
                            &m.part.name,
                            PREVIEW_COLOUR,
                            &title,
                            short_name(&m.part.name),
                            is_sel,
                            &format!("part:{}", m.part.name),
                        ) {
                            next_sel = Some(FitSelection::Part(m.part.name.clone()));
                        }
                    }
                });
            }
        });

    app.fits.selection = next_sel.clone();

    let selected_habit = match &next_sel {
        Some(FitSelection::Habit(name)) => shown_habits.iter().find(|h| &h.name == name).cloned(),
        _ => None,
    };
    let selected_part = match &next_sel {
        Some(FitSelection::Part(name)) => res.matches.iter().find(|m| &m.part.name == name).cloned(),
        _ => None,
    };

    let btn_label = if selected_habit.is_some() { "Add Part" } else { "Preview Placement" };
    let can_act = selected_habit.is_some() || selected_part.is_some();
    let mut act = false;
    ui.add_space(10.0);
    Frame::NONE.inner_margin(Margin::symmetric(16, 0)).show(ui, |ui| {
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if accent_button(ui, &t, btn_label, can_act).clicked() {
                act = true;
            }
        });
    });

    if act {
        if let Some(h) = selected_habit {
            if let Some(vp) = app.doc.viewport() {
                vp.show_rest();
            }
            let c = app
                .doc
                .session()
                .place_part(&h.name, h.color, &h.pose, app.edit.step, None, res_key.0, res_key.1);
            let ok = c.refused.is_none();
            app.edited(c);
            if ok {
                app.history.record_part(&h.name, &h.description, "");
                let _ = app.history.save(&app.support);
                app.fits.open = false;
            }
        } else if let Some(m) = selected_part {
            if doc_key(app) != res_key {
                crate::notices::push(
                    &mut app.notices,
                    crate::notices::Notice::Warning {
                        title: "Couldn't place part".into(),
                        detail: "The model changed while compatible parts were open.".into(),
                    },
                );
                return;
            }
            let at = app.viewport.last_rect.and_then(|rect| {
                let cam = app.doc.viewport()?.camera();
                let view = bm::Vec2::new(f64::from(rect.width()), f64::from(rect.height()));
                bm::gizmo::project(&cam, view, m.contact)
                    .filter(|p| p.x.is_finite() && p.y.is_finite() && p.x >= 0.0 && p.x <= view.x && p.y >= 0.0 && p.y <= view.y)
            });
            app.fits.open = false;
            app.begin_placement_from(m.part, at);
        }
    }
}
