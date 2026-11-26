//! The Build timeline's Parts lane (v3 approved look from `m4-rulings.md`):
//! - Zoomed out (flight < 52 px): 32-px lane of 8-px coloured seat dots with hairline rings.
//! - Zoomed in (flight >= 52 px): 20-px soft clips packed into rows by `bm::timeline::pack_lane`.
//! - Click / ⌘⇧-click selection, double-click frame, arrival drag with ⌥ force & edge pan,
//!   right-click context menu (`TimelinePartMenu`), and Library tile drag-and-drop insertion.
use std::collections::HashSet;
use std::time::{Duration, Instant};

use bm::timeline::{ArrivalTarget, BuildTimeline, TimelineView, pack_lane};
use egui::{
    Align2, Color32, CornerRadius, CursorIcon, FontId, Frame, Margin, Pos2, Rect, RichText, Sense, Stroke, StrokeKind,
    Ui, WidgetInfo, pos2, vec2,
};

use crate::BrickMotionApp;
use crate::chrome::library::{LibraryDrag, short_name};
use crate::chrome::timeline::{TimelineDrag, format_ruler};
use crate::icons::{self, Icon};
use crate::viewport::ViewOp;

const DOT_LANE_H: f32 = 32.0;
const CLIP_H: f32 = 20.0;
const ROW_PITCH: f32 = 23.0;
const LANE_INSET: f32 = 5.0;
const MIN_CLIP_W: f32 = 40.0;
const MAX_CLIP_W: f32 = 124.0;

#[derive(Clone, Debug)]
pub struct Clip {
    pub flight: usize,
    pub piece: u32,
    pub step: i32,
    pub color: i32,
    pub start: f64,
    pub end: f64,
    /// Content-space coordinates (relative to `lead_inset`, before `- offset`).
    pub x: f32,
    pub width: f32,
    pub row: u32,
    pub seat_x: f32,
}

impl Clip {
    /// The part's file name, from the timeline the clip was laid out from.
    pub fn part_name<'a>(&self, timeline: &'a BuildTimeline) -> &'a str {
        timeline.flights.get(self.flight).map_or("", |f| f.name.as_str())
    }

    /// The name shown on the clip (no `.dat`).
    pub fn label<'a>(&self, timeline: &'a BuildTimeline) -> &'a str {
        short_name(self.part_name(timeline))
    }

    pub fn rect_in(&self, lane: Rect, lead_inset: f64, offset: f64) -> Rect {
        let sx = lane.left() + (self.x as f64 + lead_inset - offset) as f32;
        let sy = lane.top() + LANE_INSET + self.row as f32 * ROW_PITCH;
        Rect::from_min_size(pos2(sx, sy), vec2(self.width, CLIP_H))
    }

    pub fn dot_center_in(&self, lane: Rect, lead_inset: f64, offset: f64) -> Pos2 {
        let sx = lane.left() + (self.seat_x as f64 + lead_inset - offset) as f32;
        pos2(sx, lane.center().y)
    }
}

#[derive(Default)]
pub struct PartsLane {
    layout_for: Option<(u64, u32, u32)>,
    pub clips: Vec<Clip>,
    pub rows: u32,
    pub zoomed_in: bool,
    pub last_layout_time: Duration,
    pub last_show_time: Duration,
    pub last_visited: usize,
    /// The widest clip, so culling never drops a long clip that starts left of the view.
    max_clip_width: f32,
    /// The dot whose context menu is open: it stays interactive while the pointer is in the menu.
    menu_piece: Option<u32>,
}

impl PartsLane {
    pub fn clear(&mut self) {
        self.layout_for = None;
        self.clips.clear();
        self.rows = 0;
        self.zoomed_in = false;
        self.max_clip_width = 0.0;
        self.menu_piece = None;
        self.last_visited = 0;
    }

    /// Rebuilds the cached clip layout only when plan version, viewport width, or zoom changes.
    pub fn ensure_layout(&mut self, timeline: &BuildTimeline, view: &TimelineView, pins: &HashSet<u32>) {
        let key = (
            timeline.version,
            view.viewport_width.round().max(1.0) as u32,
            (view.zoom * 1000.0).round().max(1.0) as u32,
        );
        if self.layout_for == Some(key) {
            return;
        }
        let t0 = Instant::now();
        let dur = timeline.duration.max(0.001);
        let lw = view.logical_width().max(1.0);
        let px_per_sec = lw / dur;

        // Check both typical flight duration width AND consecutive seat spacing so labeled
        // part pills appear as soon as there is clean room to show part names (not only at extreme zoom).
        let sample_n = timeline.flights.len().min(64);
        let (avg_dur, avg_pitch) = if let Some(step) = timeline.flights.len().checked_div(sample_n) {
            let step = step.max(1);
            let mut sum_dur = 0.0;
            let mut cnt_dur = 0usize;
            let mut sum_pitch = 0.0;
            let mut cnt_pitch = 0usize;
            for idx in (0..timeline.flights.len()).step_by(step).take(sample_n) {
                let f = &timeline.flights[idx];
                sum_dur += (f.end - f.start).max(0.0);
                cnt_dur += 1;
                if let Some(next) = timeline.flights.get(idx + 1) {
                    let gap = (next.end - f.end).abs();
                    if gap > 1e-4 {
                        sum_pitch += gap;
                        cnt_pitch += 1;
                    }
                }
            }
            (
                if cnt_dur > 0 { sum_dur / cnt_dur as f64 } else { 0.0 },
                if cnt_pitch > 0 { sum_pitch / cnt_pitch as f64 } else { 0.0 },
            )
        } else {
            (0.0, 0.0)
        };
        let zoomed_in = avg_dur * px_per_sec >= 32.0 || avg_pitch * px_per_sec >= 44.0;

        let mut clips: Vec<Clip> = Vec::with_capacity(timeline.flights.len());
        for (idx, f) in timeline.flights.iter().enumerate() {
            let label = short_name(&f.name);
            let start_x = (f.start * px_per_sec) as f32;
            let seat_x = (f.end * px_per_sec) as f32;
            let dur_w = ((f.end - f.start).max(0.0) * px_per_sec) as f32;
            let pin_extra = if pins.contains(&f.piece) { 12.0 } else { 0.0 };
            let text_w = (label.len() as f32 * 6.4 + 18.0 + pin_extra).clamp(MIN_CLIP_W, MAX_CLIP_W);
            let width = dur_w.sub_clamped(3.0).max(text_w);
            let max_x = (lw as f32 - width).max(0.0);
            let x = start_x.clamp(0.0, max_x);
            clips.push(Clip {
                flight: idx,
                piece: f.piece,
                step: f.step,
                color: f.color,
                start: f.start,
                end: f.end,
                x,
                width,
                row: 0,
                seat_x,
            });
        }

        let rows = if zoomed_in {
            clips.sort_by(|a, b| a.x.total_cmp(&b.x).then_with(|| a.flight.cmp(&b.flight)));
            let spans: Vec<(f64, f64)> = clips.iter().map(|c| (c.x as f64, c.width as f64)).collect();
            let (rows, count) = pack_lane(&spans);
            for (c, r) in clips.iter_mut().zip(rows) {
                c.row = r;
            }
            count as u32
        } else {
            clips.sort_by(|a, b| a.seat_x.total_cmp(&b.seat_x).then_with(|| a.flight.cmp(&b.flight)));
            1
        };

        self.set_clips(clips, zoomed_in, rows);
        self.layout_for = Some(key);
        self.last_layout_time = t0.elapsed();
    }

    /// Takes a laid-out clip list: sorted by `x` when zoomed in, by `seat_x` otherwise.
    pub fn set_clips(&mut self, clips: Vec<Clip>, zoomed_in: bool, rows: u32) {
        self.max_clip_width = clips.iter().fold(0.0, |m, c| m.max(c.width));
        self.clips = clips;
        self.zoomed_in = zoomed_in;
        self.rows = rows;
    }

    pub fn height(&self) -> f32 {
        if !self.zoomed_in || self.clips.is_empty() {
            DOT_LANE_H
        } else {
            (self.rows.max(1) as f32 * ROW_PITCH + 2.0 * LANE_INSET).max(DOT_LANE_H)
        }
    }

    /// Index slice of clips whose horizontal span can intersect the visible content window.
    pub fn visible_range(&self, view: &TimelineView) -> std::ops::Range<usize> {
        if self.clips.is_empty() {
            return 0..0;
        }
        let vis_left = (view.offset - view.lead_inset) as f32;
        let vis_right = (view.offset + view.viewport_width - view.lead_inset) as f32;
        if self.zoomed_in {
            // Sorted by x: a clip left of the view can still reach into it by up to the widest clip.
            let margin = self.max_clip_width.max(MAX_CLIP_W);
            let start = self.clips.partition_point(|c| c.x + margin < vis_left);
            let end = self.clips.partition_point(|c| c.x <= vis_right + 8.0);
            start..end
        } else {
            let start = self.clips.partition_point(|c| c.seat_x < vis_left - 8.0);
            let end = self.clips.partition_point(|c| c.seat_x <= vis_right + 8.0);
            start..end
        }
    }
}

trait SubClamped {
    fn sub_clamped(self, rhs: f32) -> f32;
}
impl SubClamped for f32 {
    fn sub_clamped(self, rhs: f32) -> f32 {
        (self - rhs).max(0.0)
    }
}

fn contrast_ink(c: Color32) -> Color32 {
    let luma = 0.299 * f32::from(c.r()) + 0.587 * f32::from(c.g()) + 0.114 * f32::from(c.b());
    if luma > 138.0 {
        Color32::from_rgba_unmultiplied(18, 20, 24, 224)
    } else {
        Color32::from_rgb(0xf2, 0xf3, 0xf5)
    }
}

/// Calms very bright or very dark brick colours slightly so they read cleanly on the dark timeline.
fn clip_tint(c: Color32, hovered: bool, selected: bool) -> Color32 {
    if selected || hovered {
        return c;
    }
    let mix = |v: u8, bg: u8| (f32::from(v) * 0.86 + f32::from(bg) * 0.14).round() as u8;
    Color32::from_rgb(mix(c.r(), 0x1a), mix(c.g(), 0x1b), mix(c.b(), 0x1f))
}

/// Draws the Parts lane and handles clicks, double-clicks, arrival drags, context menu, and Library drops.
pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, r: Rect, dur: f64) {
    let t0 = Instant::now();
    let Some(timeline) = app.transport.timeline.clone() else { return };
    let Some(lanes) = app.transport.lanes.clone() else { return };
    if dur <= 0.0 {
        return;
    }

    let t = app.theme;
    let view = app.timeline.view;
    app.timeline.parts_lane.ensure_layout(&timeline, &view, &app.transport.pins);

    // Paint the chosen-step accent 7% backdrop band behind the lane.
    let clip_p = ui.painter_at(r);
    if let Some(step) = app.transport.current_step()
        && let Some(ls) = lanes.steps.iter().find(|s| s.step == step as i32)
    {
        let bx0 = r.left() + view.screen_x(ls.start, dur) as f32;
        let bx1 = r.left() + view.screen_x(ls.end, dur) as f32;
        if bx1 >= r.left() && bx0 <= r.right() {
            let band = Rect::from_min_max(pos2(bx0, r.top()), pos2(bx1.max(bx0 + 2.0), r.bottom()));
            clip_p.rect_filled(band, 0.0, Color32::from_rgba_unmultiplied(0x4f, 0x8c, 0xff, 18));
            let edge = Stroke::new(0.5, Color32::from_rgba_unmultiplied(0x4f, 0x8c, 0xff, 90));
            clip_p.vline(band.left(), band.y_range(), edge);
            clip_p.vline(band.right(), band.y_range(), edge);
        }
    }

    // Build fast colour lookup for part dots.
    let colors = app.colors();
    let color_of = |code: i32| -> Color32 {
        colors
            .iter()
            .find(|c| c.code == code)
            .map(|c| Color32::from_rgb(c.rgb[0], c.rgb[1], c.rgb[2]))
            .unwrap_or(Color32::from_rgb(0x9b, 0xa1, 0xaa))
    };

    let sel_vec = app.doc.session().selection();
    let sel_set: HashSet<u32> = sel_vec.iter().copied().collect();
    let pins = &app.transport.pins;
    let zoomed_in = app.timeline.parts_lane.zoomed_in;
    let vis = app.timeline.parts_lane.visible_range(&view);
    app.timeline.parts_lane.last_visited = vis.len();

    let (hover_pos, primary_down, mods) = ui.input(|i| (i.pointer.hover_pos(), i.pointer.primary_down(), i.modifiers));
    let dragging_arrival = matches!(app.timeline.drag, Some(TimelineDrag::Arrival { .. }));

    // Paint and interact only with clips in `vis`.
    let mut clicked: Option<(usize, u32, f64, egui::Modifiers)> = None;
    let mut dbl_clicked: Option<(u32, f64)> = None;
    let mut drag_started: Option<(Vec<u32>, f32)> = None;
    let mut hovered_clip: Option<(usize, Rect)> = None;
    let mut menu_action: Option<PartMenuAction> = None;

    let lane_resp = ui.interact(r, ui.scope_id().with("tl-parts-bg"), Sense::hover());

    if zoomed_in {
        for clip_idx in vis.clone() {
            let clip = &app.timeline.parts_lane.clips[clip_idx];
            let rect = clip.rect_in(r, view.lead_inset, view.offset);
            if rect.right() < r.left() || rect.left() > r.right() {
                continue;
            }
            let hit_rect = rect.intersect(r);
            let resp = ui.interact(
                hit_rect,
                ui.scope_id().with(("tl-part", clip.piece)),
                Sense::click_and_drag(),
            );
            let is_sel = sel_set.contains(&clip.piece);
            let is_pin = pins.contains(&clip.piece);
            let is_hov = resp.hovered() && !dragging_arrival;
            let label = clip.label(&timeline);
            resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, is_sel, label));

            // Rounded pill in the part's own brick colour (m6-controls.html / m5-rulings.md).
            let raw_brick = color_of(clip.color);
            let fill = clip_tint(raw_brick, is_hov, is_sel);
            let ink = contrast_ink(fill);
            let r_clip = CornerRadius::same(7);
            clip_p.rect_filled(rect, r_clip, fill);
            if is_sel {
                clip_p.rect_stroke(rect, r_clip, Stroke::new(1.5, Color32::WHITE), StrokeKind::Inside);
                clip_p.rect_stroke(rect.expand(1.5), CornerRadius::same(8), Stroke::new(1.5, t.accent), StrokeKind::Outside);
            } else if is_hov {
                clip_p.rect_stroke(rect, r_clip, Stroke::new(1.0, Color32::from_white_alpha(140)), StrokeKind::Inside);
            } else {
                clip_p.rect_stroke(rect, r_clip, Stroke::new(0.5, Color32::from_black_alpha(60)), StrokeKind::Inside);
            }

            // Optional pin glyph on right.
            let text_right = if is_pin && rect.width() > 30.0 {
                let pr = Rect::from_center_size(pos2(rect.right() - 10.0, rect.center().y), vec2(11.0, 11.0));
                if pr.left() >= r.left() && pr.right() <= r.right() {
                    icons::paint(ui, Icon::Pin, pr, 10.0, ink);
                }
                rect.right() - 18.0
            } else {
                rect.right() - 7.0
            };

            // 11-pt proportional part name with auto-contrast ink over the brick colour.
            let text_left = rect.left() + 8.0;
            let text_clip = Rect::from_min_max(pos2(text_left, rect.top()), pos2(text_right, rect.bottom())).intersect(r);
            if text_clip.width() > 4.0 {
                ui.painter().with_clip_rect(text_clip).text(
                    pos2(text_left, rect.center().y),
                    Align2::LEFT_CENTER,
                    label,
                    FontId::proportional(11.0),
                    ink,
                );
            }

            if is_hov {
                hovered_clip = Some((clip_idx, rect));
            }
            if resp.drag_started()
                && let Some(pos) = ui.input(|i| i.pointer.press_origin()).or_else(|| resp.interact_pointer_pos())
            {
                let dragged = if is_sel && !sel_vec.is_empty() {
                    sel_vec.clone()
                } else {
                    vec![clip.piece]
                };
                drag_started = Some((dragged, pos.x));
            } else if resp.double_clicked() {
                dbl_clicked = Some((clip.piece, clip.start));
            } else if resp.clicked() {
                clicked = Some((clip_idx, clip.piece, clip.end, mods));
            }

            let _ = part_context_menu(app, &resp, clip, label, &sel_vec, is_pin, &mut menu_action);
        }
    } else {
        // Zoomed-out mode: sleek rounded brick-colour mini-pills (m6-controls.html).
        // Deduplicate non-selected/non-pinned pixels on massive models (9,720 Titanic flights)
        // while keeping selected, pinned, and hovered pills crisp and always interactive.
        let mut last_plain_px = i32::MIN;
        let mut top_dots: Vec<usize> = Vec::new();
        let mut hit_candidate: Option<(f32, usize, Pos2)> = None;
        let ptr_in_lane = hover_pos.filter(|p| r.contains(*p));
        let px_per_sec = (view.logical_width() / dur.max(0.001)) as f32;

        for clip_idx in vis.clone() {
            let clip = &app.timeline.parts_lane.clips[clip_idx];
            let center = clip.dot_center_in(r, view.lead_inset, view.offset);
            if center.x < r.left() - 6.0 || center.x > r.right() + 6.0 {
                continue;
            }
            let is_sel = sel_set.contains(&clip.piece);
            let is_pin = pins.contains(&clip.piece);

            if let Some(p) = ptr_in_lane {
                let d = (p.x - center.x).abs();
                if d <= 7.0 && hit_candidate.is_none_or(|(best, _, _)| d < best) {
                    hit_candidate = Some((d, clip_idx, center));
                }
            }

            if is_sel || is_pin {
                top_dots.push(clip_idx);
                continue;
            }
            let px = (center.x / 3.0).round() as i32;
            if px == last_plain_px {
                continue;
            }
            last_plain_px = px;
            let pill_w = (((clip.end - clip.start).max(0.0) as f32) * px_per_sec).clamp(6.0, 30.0);
            let pill = Rect::from_center_size(center, vec2(pill_w, 15.0));
            clip_p.rect_filled(pill, CornerRadius::same(4), clip_tint(color_of(clip.color), false, false));
            clip_p.rect_stroke(pill, CornerRadius::same(4), Stroke::new(0.8, Color32::from_rgba_unmultiplied(23, 24, 27, 190)), StrokeKind::Inside);
        }

        // Paint pinned & selected pills on top with crisp rings.
        for clip_idx in top_dots {
            let clip = &app.timeline.parts_lane.clips[clip_idx];
            let center = clip.dot_center_in(r, view.lead_inset, view.offset);
            let is_sel = sel_set.contains(&clip.piece);
            let is_pin = pins.contains(&clip.piece);
            let pill_w = (((clip.end - clip.start).max(0.0) as f32) * px_per_sec).clamp(8.0, 24.0);
            let pill = Rect::from_center_size(center, vec2(pill_w, 16.0));
            clip_p.rect_filled(pill, CornerRadius::same(5), color_of(clip.color));
            if is_sel {
                clip_p.rect_stroke(pill, CornerRadius::same(5), Stroke::new(1.2, t.bg1), StrokeKind::Inside);
                clip_p.rect_stroke(pill.expand(1.5), CornerRadius::same(6), Stroke::new(2.0, t.accent), StrokeKind::Outside);
            } else if is_pin {
                clip_p.rect_stroke(pill, CornerRadius::same(5), Stroke::new(1.2, t.bg1), StrokeKind::Inside);
                clip_p.rect_stroke(pill.expand(1.2), CornerRadius::same(6), Stroke::new(1.2, Color32::from_rgba_unmultiplied(232, 234, 237, 220)), StrokeKind::Outside);
            }
        }

        // Interactive hit target: the dot whose menu is open, else the nearest dot under the pointer.
        let lane = &app.timeline.parts_lane;
        let menu_idx = lane.menu_piece.and_then(|p| vis.clone().find(|&i| lane.clips[i].piece == p));
        let interact_idx = menu_idx.or(hit_candidate.map(|(_, idx, _)| idx));
        let mut menu_open_for = None;
        if let Some(clip_idx) = interact_idx {
            let clip = &app.timeline.parts_lane.clips[clip_idx];
            let center = clip.dot_center_in(r, view.lead_inset, view.offset);
            let dot_rect = Rect::from_center_size(center, vec2(14.0, 14.0)).intersect(r);
            let resp = ui
                .interact(dot_rect, ui.scope_id().with(("tl-dot", clip.piece)), Sense::click_and_drag())
                .on_hover_cursor(CursorIcon::PointingHand);
            let is_sel = sel_set.contains(&clip.piece);
            let is_pin = pins.contains(&clip.piece);
            if !dragging_arrival && menu_idx.is_none() {
                hovered_clip = Some((clip_idx, dot_rect));
            }
            if resp.drag_started()
                && let Some(pos) = ui.input(|i| i.pointer.press_origin()).or_else(|| resp.interact_pointer_pos())
            {
                let dragged = if is_sel && !sel_vec.is_empty() {
                    sel_vec.clone()
                } else {
                    vec![clip.piece]
                };
                drag_started = Some((dragged, pos.x));
            } else if resp.double_clicked() {
                dbl_clicked = Some((clip.piece, clip.start));
            } else if resp.clicked() {
                clicked = Some((clip_idx, clip.piece, clip.end, mods));
            }
            if part_context_menu(app, &resp, clip, clip.label(&timeline), &sel_vec, is_pin, &mut menu_action) {
                menu_open_for = Some(clip.piece);
            }
        }
        app.timeline.parts_lane.menu_piece = menu_open_for;
    }

    // Apply started arrival drag.
    if let Some((pieces, start_x)) = drag_started {
        app.timeline.drag = Some(TimelineDrag::Arrival {
            pieces,
            start_x,
            target: None,
        });
    }

    // Paint live insertion marker during Arrival drag.
    if let Some(TimelineDrag::Arrival { target: Some(tgt), .. }) = &app.timeline.drag {
        paint_insertion_marker(ui, &t, r, &view, dur, tgt, mods.alt);
    }

    // Handle Library tile drag-and-drop onto the Parts lane.
    if let Some(lib_drag) = egui::DragAndDrop::payload::<LibraryDrag>(ui.ctx()) {
        let over_lane = hover_pos.is_some_and(|p| r.contains(p)) || lane_resp.hovered();
        if over_lane && let Some(pos) = hover_pos {
            let local_x = (pos.x - r.left()) as f64;
            let time = view.time_at(local_x, dur);
            if let Some(tgt) = lanes.arrival_target(&timeline, Some(app.doc.session()), time, &[]) {
                paint_insertion_marker(ui, &t, r, &view, dur, &tgt, false);
                if !primary_down {
                    let part = lib_drag.0.clone();
                    egui::DragAndDrop::clear_payload(ui.ctx());
                    app.begin_placement_at(part, Some(tgt.step as usize), Some(tgt.before));
                }
            }
        }
    }

    // Rich hover card anchored cleanly ABOVE the Parts lane with a downward caret pointing at
    // the hovered clip. Hidden immediately while pressing, dragging, or while any context menu is open.
    let any_popup_open = egui::Popup::is_any_open(ui.ctx()) || app.timeline.parts_lane.menu_piece.is_some();
    if let Some((clip_idx, clip_rect)) = hovered_clip
        && !primary_down
        && !any_popup_open
        && app.timeline.drag.is_none()
        && egui::DragAndDrop::payload::<LibraryDrag>(ui.ctx()).is_none()
    {
        let clip = app.timeline.parts_lane.clips[clip_idx].clone();
        let part_name = clip.part_name(&timeline).to_owned();
        let total_steps = app.steps.len().max(1);
        let sw = color_of(clip.color);
        let card_w = 240.0;
        let card_x = (clip_rect.center().x - card_w * 0.5).clamp(r.left() + 4.0, (r.right() - card_w - 4.0).max(r.left() + 4.0));
        let card_bottom = (r.top() - 10.0).max(160.0);
        let card_fill = Color32::from_rgba_unmultiplied(36, 38, 43, 252);
        let card_stroke = Color32::from_rgba_unmultiplied(255, 255, 255, 32);
        let area_resp = egui::Area::new(egui::Id::unique("tl-part-hover-card"))
            .order(egui::Order::Tooltip)
            .interactable(false)
            .pivot(Align2::LEFT_BOTTOM)
            .fixed_pos(pos2(card_x, card_bottom))
            .show(ui.ctx(), |ui| {
                Frame::NONE
                    .fill(card_fill)
                    .stroke(Stroke::new(0.75, card_stroke))
                    .corner_radius(CornerRadius::same(9))
                    .inner_margin(Margin::symmetric(12, 10))
                    .shadow(egui::Shadow {
                        offset: [0, 8],
                        blur: 20,
                        spread: 0,
                        color: Color32::from_black_alpha(110),
                    })
                    .show(ui, |ui| {
                        ui.set_width(card_w - 24.0);
                        ui.spacing_mut().item_spacing.y = 3.0;
                        ui.horizontal(|ui| {
                            let (dr, _) = ui.allocate_exact_size(vec2(9.0, 14.0), Sense::hover());
                            ui.painter().circle_filled(dr.center(), 4.5, sw);
                            ui.painter().circle_stroke(
                                dr.center(),
                                4.5,
                                Stroke::new(0.5, Color32::from_rgba_unmultiplied(255, 255, 255, 100)),
                            );
                            ui.label(RichText::new(clip.label(&timeline)).strong().size(12.5).color(t.text1));
                        });
                        egui::Grid::new("part-hc-grid")
                            .num_columns(2)
                            .spacing(vec2(10.0, 2.0))
                            .show(ui, |ui| {
                                ui.label(RichText::new("Part").size(11.0).color(t.text3));
                                ui.label(RichText::new(&part_name).size(11.0).color(t.text2))
                                    .widget_info(|| WidgetInfo::labeled(egui::Role::Label, true, format!("Part name {part_name}")));
                                ui.end_row();
                                ui.label(RichText::new("Step").size(11.0).color(t.text3));
                                ui.label(
                                    RichText::new(format!("{} of {}", clip.step + 1, total_steps))
                                        .size(11.0)
                                        .color(t.text2),
                                );
                                ui.end_row();
                                ui.label(RichText::new("Flies").size(11.0).color(t.text3));
                                ui.label(
                                    RichText::new(format!("{} – {}", format_ruler(clip.start), format_ruler(clip.end)))
                                        .size(11.0)
                                        .color(t.text2),
                                );
                                ui.end_row();
                            });
                        ui.add_space(3.0);
                        let hr = ui.available_rect_before_wrap();
                        ui.painter().hline(
                            hr.x_range(),
                            hr.top(),
                            Stroke::new(0.5, Color32::from_rgba_unmultiplied(255, 255, 255, 20)),
                        );
                        ui.add_space(4.0);
                        ui.label(
                            RichText::new("Drag to retime · ⌥ drag to pin · Double-click to edit flight")
                                .size(10.5)
                                .color(t.text3),
                        );
                    });
            });
        // Crisp downward caret tail pointing directly at the hovered pill.
        let cr = area_resp.response.rect;
        let tip_x = clip_rect.center().x.clamp(cr.left() + 14.0, cr.right() - 14.0);
        let base_y = cr.bottom() - 0.5;
        let tip = pos2(tip_x, base_y + 6.5);
        let left_pt = pos2(tip_x - 6.0, base_y);
        let right_pt = pos2(tip_x + 6.0, base_y);
        let tp = ui.ctx().layer_painter(area_resp.response.layer_id);
        tp.add(egui::Shape::convex_polygon(vec![left_pt, right_pt, tip], card_fill, Stroke::NONE));
        tp.line_segment([left_pt, tip], Stroke::new(0.75, card_stroke));
        tp.line_segment([tip, right_pt], Stroke::new(0.75, card_stroke));
    }

    // Apply click / double-click / context menu actions.
    if let Some((piece, start)) = dbl_clicked {
        crate::flights::edit_flight(app, piece, start);
    } else if let Some((_idx, piece, end, m)) = clicked {
        if m.command || m.shift {
            app.doc.session().select(&[piece], bm::SelectMode::Toggle);
        } else {
            app.doc.session().select(&[piece], bm::SelectMode::Replace);
            if let Some(vp) = app.doc.viewport() {
                app.transport.seek(vp, end);
            }
        }
    } else if let Some(act) = menu_action {
        apply_part_menu(app, act);
    }

    app.timeline.parts_lane.last_show_time = t0.elapsed();
}

/// Updates an active `TimelineDrag::Arrival` on each frame and commits or cancels on release.
pub fn tick_arrival_drag(
    ui: &Ui,
    app: &mut BrickMotionApp,
    lanes_rect: Rect,
    dur: f64,
    primary_down: bool,
    latest_pos: Option<Pos2>,
    alt_held: bool,
) {
    let Some(TimelineDrag::Arrival { pieces, start_x, target }) = app.timeline.drag.clone() else {
        return;
    };
    let parts_rect = app.timeline.last_parts_rect;
    if primary_down {
        if let Some(pos) = latest_pos {
            let local_x = (pos.x - lanes_rect.left()) as f64;
            if app.timeline.view.pan_at_edge(local_x) {
                ui.ctx().request_repaint();
            }
            let over_parts = parts_rect.is_some_and(|pr| pr.contains(pos));
            let next_target = if over_parts && let (Some(tl), Some(ln)) = (&app.transport.timeline, &app.transport.lanes) {
                let time = app.timeline.view.time_at(local_x, dur);
                ln.arrival_target(tl, Some(app.doc.session()), time, &pieces)
            } else {
                None
            };
            app.timeline.drag = Some(TimelineDrag::Arrival {
                pieces,
                start_x,
                target: next_target,
            });
        }
    } else {
        app.timeline.drag = None;
        let release_alt = ui.input(|i| {
            i.events.iter().any(|e| {
                matches!(e, egui::Event::PointerButton { button: egui::PointerButton::Primary, pressed: false, modifiers, .. } if modifiers.alt)
            })
        });
        let force = alt_held || release_alt;
        let over_parts = latest_pos.is_some_and(|p| parts_rect.is_some_and(|pr| pr.contains(p)));
        if over_parts
            && let Some(tgt) = target
            && let Ok(step) = usize::try_from(tgt.step)
        {
            let c = app.doc.session().move_arrival(&pieces, step, tgt.before, force);
            app.edited(c);
        }
    }
}

fn paint_insertion_marker(
    ui: &Ui,
    t: &crate::Theme,
    r: Rect,
    view: &TimelineView,
    dur: f64,
    tgt: &ArrivalTarget,
    force: bool,
) {
    let sx = r.left() + view.screen_x(tgt.time, dur) as f32;
    if sx < r.left() - 2.0 || sx > r.right() + 2.0 {
        return;
    }
    let p = ui.painter_at(r);
    p.vline(sx, r.y_range(), Stroke::new(2.0, t.accent));
    p.circle_filled(pos2(sx, r.top() + 3.0), 3.0, t.accent);
    if force {
        let pill = Rect::from_min_size(pos2((sx + 5.0).min(r.right() - 42.0), r.top() + 2.0), vec2(38.0, 15.0));
        p.rect_filled(pill, 4.0, t.accent);
        p.text(pill.center(), Align2::CENTER_CENTER, "Pin", FontId::proportional(10.0), Color32::WHITE);
    }
}

enum PartMenuAction {
    Frame { pieces: Vec<u32>, end: f64 },
    SetPinned { pieces: Vec<u32>, pinned: bool },
    MoveToStep { pieces: Vec<u32>, step: usize },
    MoveToNewStep { pieces: Vec<u32>, index: usize },
    SplitAtItem { step: usize, pieces: Vec<u32> },
    ReorderArrival { step: usize, from: usize, to: usize },
    SplitSelected { step: usize, pieces: Vec<u32>, same_step: bool },
    Delete { pieces: Vec<u32> },
    EditFlight { piece: u32, start: f64 },
    Motion { pieces: Vec<u32>, step: usize },
    UseEditedFlight { piece: u32 },
    ReturnFlight { piece: u32 },
}

fn part_context_menu(
    app: &BrickMotionApp,
    resp: &egui::Response,
    clip: &Clip,
    label: &str,
    sel: &[u32],
    clip_pinned: bool,
    out: &mut Option<PartMenuAction>,
) -> bool {
    let step_idx = usize::try_from(clip.step).ok();

    // Built only while the menu is open: this runs for every visible clip each frame.
    let t = app.theme;
    resp.context_menu(|ui| {
        use super::menu;
        menu::prepare_width(ui, 240.0);
        let ids: Vec<u32> = if sel.contains(&clip.piece) {
            sel.to_vec()
        } else {
            vec![clip.piece]
        };
        let single = ids.len() == 1;
        let session = app.doc.session();
        let items = step_idx.map(|s| session.step_items(s)).unwrap_or_default();
        let item_index = items
            .iter()
            .position(|it| !it.submodel && it.pieces.contains(&clip.piece));
        let own_step: HashSet<u32> = items.iter().flat_map(|it| it.pieces.iter().copied()).collect();
        let same_step = ids.iter().all(|p| own_step.contains(p));
        let step_count = app.steps.len();

        let header = if single {
            label.to_owned()
        } else {
            format!("{} Parts", ids.len())
        };
        let sub = step_idx.and_then(|s| {
            if single && let Some(i) = item_index {
                Some(format!("Step {} · Arrival {} of {}", s + 1, i + 1, items.len()))
            } else if same_step {
                Some(format!("Step {}", s + 1))
            } else {
                None
            }
        });
        menu::header(ui, &t, &header, sub.as_deref());
        menu::separator(ui, &t);

        if menu::item(ui, &t, Some(Icon::LookAt), "Frame in View", None, true) {
            *out = Some(PartMenuAction::Frame { pieces: ids.clone(), end: clip.end });
        }
        if menu::item(ui, &t, Some(Icon::Fly), "Motion…", None, true) {
            *out = Some(PartMenuAction::Motion { pieces: ids.clone(), step: step_idx.unwrap_or(0) });
        }
        if single {
            menu::separator(ui, &t);
            menu::section(ui, &t, "Flight");
            if menu::item(ui, &t, Some(Icon::Keys), "Edit Flight as Keys", None, true) {
                *out = Some(PartMenuAction::EditFlight { piece: clip.piece, start: clip.start });
            }
            if session.has_editable_flight_keys(clip.piece) {
                // Only a part of this model (not inside a submodel) can take a route back to Build.
                if item_index.is_some() && menu::item(ui, &t, Some(Icon::Plan), "Use Edited Flight in Build", None, true) {
                    *out = Some(PartMenuAction::UseEditedFlight { piece: clip.piece });
                }
                if menu::item(ui, &t, Some(Icon::Undo), "Return Flight to Planner", None, true) {
                    *out = Some(PartMenuAction::ReturnFlight { piece: clip.piece });
                }
            }
        }

        if let (Some(step), Some(index)) = (step_idx, item_index) {
            menu::separator(ui, &t);
            menu::section(ui, &t, "Order");
            let pinned = if single {
                clip_pinned
            } else {
                ids.iter().all(|p| app.transport.pins.contains(p))
            };
            let pin_label = if pinned {
                "Release Arrival Pins"
            } else if single {
                "Pin This Arrival"
            } else {
                "Pin Selected Arrivals"
            };
            if menu::item(ui, &t, Some(Icon::Pin), pin_label, None, true) {
                *out = Some(PartMenuAction::SetPinned { pieces: ids.clone(), pinned: !pinned });
            }

            if step_count > 1 {
                menu::submenu(ui, &t, Some(Icon::Step), "Move to Step", |ui| {
                    for s in 0..step_count {
                        let title = app
                            .steps
                            .row(s)
                            .map(|r| {
                                if r.title.is_empty() {
                                    format!("Step {}", s + 1)
                                } else {
                                    format!("Step {} · {}", s + 1, r.title)
                                }
                            })
                            .unwrap_or_else(|| format!("Step {}", s + 1));
                        let en = s != step || !same_step;
                        if menu::item(ui, &t, None, &title, None, en) {
                            *out = Some(PartMenuAction::MoveToStep { pieces: ids.clone(), step: s });
                        }
                    }
                });
            }

            menu::submenu(ui, &t, Some(Icon::Plus), "Move to a New Step", |ui| {
                for (label, dest) in [
                    (format!("Before Step {}", step + 1), step),
                    (format!("After Step {}", step + 1), step + 1),
                ] {
                    if menu::item(ui, &t, None, &label, None, true) {
                        *out = Some(PartMenuAction::MoveToNewStep { pieces: ids.clone(), index: dest });
                    }
                }
                menu::separator(ui, &t);
                for (label, dest) in [("At the Start", 0), ("At the End", step_count)] {
                    if menu::item(ui, &t, None, label, None, true) {
                        *out = Some(PartMenuAction::MoveToNewStep { pieces: ids.clone(), index: dest });
                    }
                }
            });

            if single {
                menu::separator(ui, &t);
                let can_split = index > 0;
                if menu::item(ui, &t, Some(Icon::Razor), "Split Step at This Part", None, can_split) {
                    let suffix: Vec<u32> = items[index..].iter().flat_map(|it| it.pieces.iter().copied()).collect();
                    *out = Some(PartMenuAction::SplitAtItem { step, pieces: suffix });
                }
                let last = items.len().saturating_sub(1);
                for (ic, label, dest) in [
                    (Icon::Back, "Arrive Earlier", index.saturating_sub(1)),
                    (Icon::Chevron, "Arrive Later", (index + 1).min(last)),
                    (Icon::Prev, "Arrive First", 0),
                    (Icon::Next, "Arrive Last", last),
                ] {
                    let en = dest < items.len() && dest != index;
                    if menu::item(ui, &t, Some(ic), label, None, en) {
                        *out = Some(PartMenuAction::ReorderArrival { step, from: index, to: dest });
                    }
                }
            } else {
                menu::separator(ui, &t);
                let can_split = !same_step || ids.len() < own_step.len();
                if menu::item(ui, &t, Some(Icon::Razor), "Split Selected Parts into New Step", None, can_split) {
                    *out = Some(PartMenuAction::SplitSelected { step, pieces: ids.clone(), same_step });
                }
            }
        }

        menu::separator(ui, &t);
        let del_label = if single {
            "Delete Part".to_owned()
        } else {
            format!("Delete {} Parts", ids.len())
        };
        if menu::item_destructive(ui, &t, Some(Icon::Close), &del_label, true) {
            *out = Some(PartMenuAction::Delete { pieces: ids });
        }
    })
    .is_some()
}

fn apply_part_menu(app: &mut BrickMotionApp, action: PartMenuAction) {
    match action {
        PartMenuAction::EditFlight { piece, start } => crate::flights::edit_flight(app, piece, start),
        PartMenuAction::Motion { pieces, step } => {
            let target = super::motion_panel::MotionTarget { scope: bm::motion::MotionScope::Parts, step, pieces };
            super::motion_panel::open(app, target);
        }
        PartMenuAction::UseEditedFlight { piece } => crate::flights::use_edited_flight(app, piece),
        PartMenuAction::ReturnFlight { piece } => crate::flights::return_to_planner(app, piece),
        PartMenuAction::Frame { pieces, end } => {
            app.doc.session().select(&pieces, bm::SelectMode::Replace);
            if let Some(vp) = app.doc.viewport() {
                app.transport.seek(vp, end);
            }
            app.viewport.queue(ViewOp::FrameSelection);
        }
        PartMenuAction::SetPinned { pieces, pinned } => {
            let c = app.doc.session().set_arrival_pinned(&pieces, pinned);
            app.edited(c);
        }
        PartMenuAction::MoveToStep { pieces, step } => {
            let c = app.doc.session().move_to_step(&pieces, step);
            app.edited(c);
        }
        PartMenuAction::MoveToNewStep { pieces, index } => {
            let c = app.doc.session().move_to_new_step(&pieces, index);
            app.edited(c);
        }
        PartMenuAction::SplitAtItem { step, pieces } => {
            let c = app.doc.session().split_step(step, &pieces);
            app.edited(c);
        }
        PartMenuAction::ReorderArrival { step, from, to } => {
            let c = app.doc.session().reorder_arrival(step, from, to);
            app.edited(c);
        }
        PartMenuAction::SplitSelected { step, pieces, same_step } => {
            let c = if same_step {
                app.doc.session().split_step(step, &pieces)
            } else {
                app.doc.session().move_to_new_step(&pieces, step + 1)
            };
            app.edited(c);
        }
        PartMenuAction::Delete { pieces } => {
            let c = app.doc.session().remove(&pieces);
            app.edited(c);
        }
    }
}
