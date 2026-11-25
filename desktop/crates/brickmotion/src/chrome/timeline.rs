//! The live Build timeline: transport header, ruler with scrubbing and orange playhead,
//! Sequence trim strip, Step runs, editable Pause holds, Submodel lanes, and Snaps ticks.
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use bm::playback::{PlanState, Segment};
use bm::steps::StepFields;
use bm::timeline::{TimelineView, tick_interval};
use egui::{
    Align, Align2, Color32, CornerRadius, CursorIcon, FontId, Frame, Id, Key, Layout, Margin, Order, Panel,
    Rect, RichText, Sense, Stroke, StrokeKind, Ui, UiBuilder, WidgetInfo, pos2, vec2,
};

use super::{float_frame, icon_button, icon_button_tip};
use crate::BrickMotionApp;
use crate::commands::{enabled, find};
use crate::icons::{self, Icon};
use crate::theme::Theme;

const HEAD_W: f32 = 248.0;
const HEADER_H: f32 = 40.0;
const RULER_H: f32 = 26.0;
const TRACK_H: f32 = 32.0;
const SEQ_H: f32 = 28.0;
const STEPS_H: f32 = 34.0;
const PAUSE_H: f32 = 26.0;
const SUB_H: f32 = 26.0;
const PARTS_PLACEHOLDER_H: f32 = 32.0;
const RATES: [f64; 6] = [0.25, 0.5, 1.0, 1.5, 2.0, 4.0];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Track {
    Camera,
    Build,
    Keys,
    Snaps,
}

#[derive(Clone, Debug)]
pub enum TimelineDrag {
    Scrub,
    Hold {
        run: usize,
        step: usize,
        start_x: f32,
        original: f64,
        seconds: f64,
    },
    Trim {
        segment: Segment,
        start_x: f32,
        original: f64,
        seconds: f64,
    },
}

pub struct TimelineState {
    pub view: TimelineView,
    pub open: HashSet<Track>,
    pub scrubbing: bool,
    pub follows_playhead: bool,
    pub drag: Option<TimelineDrag>,
    pub height: f32,
    pub show_diagnostics: bool,
    focused_hold: Option<(usize, usize)>,
    pub last_lanes_rect: Option<Rect>,
    pub last_ruler_rect: Option<Rect>,
    pub last_parts_rect: Option<Rect>,
    pub last_frame_time: Duration,
}

impl Default for TimelineState {
    fn default() -> Self {
        let mut open = HashSet::new();
        open.insert(Track::Build);
        Self {
            view: TimelineView::default(),
            open,
            scrubbing: false,
            follows_playhead: true,
            drag: None,
            height: 300.0,
            show_diagnostics: false,
            focused_hold: None,
            last_lanes_rect: None,
            last_ruler_rect: None,
            last_parts_rect: None,
            last_frame_time: Duration::ZERO,
        }
    }
}

pub fn format_timecode(seconds: f64, fps: f64) -> String {
    let fps = fps.max(1.0);
    let total_frames = (seconds.max(0.0) * fps).round() as u64;
    let f_per_s = fps.round().max(1.0) as u64;
    let frames = total_frames % f_per_s;
    let total_secs = total_frames / f_per_s;
    let secs = total_secs % 60;
    let mins = total_secs / 60;
    format!("{mins:02}:{secs:02}:{frames:02}")
}

pub fn format_ruler(seconds: f64) -> String {
    let total = seconds.max(0.0).round() as u64;
    let mins = total / 60;
    let secs = total % 60;
    format!("{mins}:{secs:02}")
}

fn format_rate(r: f64) -> String {
    if (r - r.round()).abs() < 1e-6 {
        format!("{}×", r.round() as i32)
    } else if ((r * 10.0) - (r * 10.0).round()).abs() < 1e-6 {
        format!("{r:.1}×")
    } else {
        format!("{r:.2}×")
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp) {
    let frame_t0 = Instant::now();
    let t = app.theme;

    Panel::bottom("timeline")
        .exact_size(app.timeline.height)
        .resizable(false)
        .show_separator_line(false)
        .frame(Frame::NONE.fill(t.bg1))
        .show(ui, |ui| {
            let full = ui.max_rect();
            let line = Stroke::new(1.0, t.border);
            ui.painter().hline(full.x_range(), full.top() + 0.5, line);

            // Top-edge vertical resize grip.
            let grip = Rect::from_min_size(full.min, vec2(full.width(), 5.0));
            let grip_resp = ui
                .interact(grip, ui.scope_id().with("tl-resize"), Sense::drag())
                .on_hover_cursor(CursorIcon::ResizeVertical);
            if grip_resp.dragged() {
                app.timeline.height = (app.timeline.height - grip_resp.drag_delta().y).clamp(180.0, 520.0);
            }

            let header = Rect::from_min_size(full.min, vec2(full.width(), HEADER_H));
            ui.painter().hline(full.x_range(), header.bottom() - 0.5, line);
            header_row(ui, app, header);

            let body = Rect::from_min_max(pos2(full.left(), header.bottom()), full.max);
            let heads = Rect::from_min_max(body.min, pos2(body.left() + HEAD_W, body.bottom()));
            ui.painter().vline(heads.right() - 0.5, body.y_range(), line);
            let lanes = Rect::from_min_max(pos2(heads.right(), body.top()), body.max);
            app.timeline.last_lanes_rect = Some(lanes);
            app.timeline.view.viewport_width = lanes.width().max(1.0) as f64;

            timeline_body(ui, app, heads, lanes);
        });

    if app.timeline.show_diagnostics {
        diagnostics_popover(ui, app);
    }

    app.timeline.last_frame_time = frame_t0.elapsed();
}

fn header_row(ui: &mut Ui, app: &mut BrickMotionApp, r: Rect) {
    let t = app.theme;
    let has_pieces = app.piece_count() > 0;
    let ready = app.transport.ready();
    let can_nav = ready || app.transport.stale_shown();
    let dur = app.transport.duration();
    let cur = app.transport.time();
    let fps = app.transport.fps();

    // Left: disabled M8 editing tools.
    let left_r = Rect::from_min_size(r.min + vec2(10.0, 6.0), vec2(HEAD_W - 14.0, 28.0));
    ui.scope_builder(UiBuilder::new().max_rect(left_r), |ui| {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            icon_button(ui, &t, Icon::Cursor, "Select", false, false, 28.0);
            icon_button(ui, &t, Icon::Razor, "Split", false, false, 28.0);
            icon_button(ui, &t, Icon::Magnet, "Snapping", false, false, 28.0);
            icon_button(ui, &t, Icon::Marker, "Add Marker", false, false, 28.0);
        });
    });

    // Centre: timecode, Start / Play-Pause / End, duration.
    let c = r.center();
    let mono = FontId::monospace(13.0);
    ui.painter().text(
        pos2(c.x - 68.0, c.y),
        Align2::RIGHT_CENTER,
        format_timecode(cur, fps),
        mono,
        t.text1,
    );

    // Jump to Start
    let prev_r = Rect::from_center_size(c + vec2(-36.0, 0.0), vec2(28.0, 28.0));
    ui.scope_builder(UiBuilder::new().max_rect(prev_r), |ui| {
        if icon_button_tip(ui, &t, Icon::Prev, "Jump to Start", "Jump to Start (Home)", ready, false, 28.0).clicked() {
            app.requested.push("transport.start");
        }
    });

    // Play / Pause circle
    let playing = app.transport.state.playing || app.transport.state.waiting_to_play;
    let play_r = Rect::from_center_size(c, vec2(32.0, 32.0));
    let play_resp = ui.interact(
        play_r,
        ui.scope_id().with("tl-play"),
        if has_pieces { Sense::click() } else { Sense::hover() },
    );
    let play_label = if playing { "Pause" } else { "Play" };
    play_resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, has_pieces, play_label));
    let circle_fill = if !has_pieces {
        t.bg3
    } else if play_resp.hovered() {
        Color32::WHITE
    } else {
        t.text1
    };
    ui.painter().circle_filled(play_r.center(), 15.0, circle_fill);
    icons::paint(
        ui,
        if playing { Icon::Pause } else { Icon::Play },
        play_r,
        14.0,
        if has_pieces { t.bg0 } else { t.text3 },
    );
    if play_resp
        .on_hover_text(format!("{play_label} (Space)"))
        .clicked()
        && has_pieces
    {
        app.requested.push("transport.play");
    }

    // Jump to End
    let next_r = Rect::from_center_size(c + vec2(36.0, 0.0), vec2(28.0, 28.0));
    ui.scope_builder(UiBuilder::new().max_rect(next_r), |ui| {
        if icon_button_tip(ui, &t, Icon::Next, "Jump to End", "Jump to End (End)", ready, false, 28.0).clicked() {
            app.requested.push("transport.end");
        }
    });

    ui.painter().text(
        pos2(c.x + 68.0, c.y),
        Align2::LEFT_CENTER,
        format_timecode(dur, fps),
        FontId::monospace(12.0),
        t.text3,
    );

    // Right: rate menu, Loop, Fit, zoom - / slider / +, overflow ⋯ menu.
    let right_r = Rect::from_min_max(pos2(c.x + 150.0, r.top() + 4.0), pos2(r.right() - 8.0, r.bottom() - 4.0));
    ui.scope_builder(
        UiBuilder::new()
            .max_rect(right_r)
            .layout(Layout::right_to_left(Align::Center)),
        |ui| {
            ui.spacing_mut().item_spacing.x = 4.0;

            // ⋯ overflow menu
            ui.menu_button(RichText::new("⋯").size(15.0).color(t.text2), |ui| {
                timeline_overflow_menu(ui, app);
            });

            // Zoom +
            let can_zoom_in = can_nav && app.timeline.view.zoom < 64.0 - 1e-3;
            if icon_button_tip(ui, &t, Icon::Plus, "Zoom In", "Zoom Timeline In", can_zoom_in, false, 24.0).clicked() {
                app.timeline.view.zoom_by(1.6, cur, dur);
            }

            // Zoom slider (log scale 1..=64)
            let (trk_slot, trk_resp) = ui.allocate_exact_size(
                vec2(64.0, 20.0),
                if can_nav { Sense::click_and_drag() } else { Sense::hover() },
            );
            let trk = Rect::from_center_size(trk_slot.center(), vec2(58.0, 3.0));
            ui.painter().rect_filled(trk, 1.5, t.border2);
            let frac = (app.timeline.view.zoom.max(1.0).ln() / 64.0_f64.ln()).clamp(0.0, 1.0) as f32;
            let kx = trk.left() + frac * trk.width();
            ui.painter().rect_filled(
                Rect::from_min_max(trk.min, pos2(kx, trk.bottom())),
                1.5,
                if can_nav { t.accent } else { t.text3 },
            );
            ui.painter()
                .circle_filled(pos2(kx, trk.center().y), 5.0, if can_nav { t.text1 } else { t.text3 });
            if can_nav
                && (trk_resp.dragged() || trk_resp.clicked())
                && let Some(pos) = trk_resp.interact_pointer_pos()
            {
                let f = ((pos.x - trk.left()) / trk.width().max(1.0)).clamp(0.0, 1.0) as f64;
                let target_zoom = 64.0_f64.powf(f);
                let factor = target_zoom / app.timeline.view.zoom.max(1e-6);
                app.timeline.view.zoom_by(factor, cur, dur);
            }

            // Zoom −
            let can_zoom_out = can_nav && app.timeline.view.zoom > 1.0 + 1e-3;
            if icon_button_tip(ui, &t, Icon::Minus, "Zoom Out", "Zoom Timeline Out", can_zoom_out, false, 24.0).clicked()
            {
                app.timeline.view.zoom_by(1.0 / 1.6, cur, dur);
            }

            // Fit button
            let fit_label = if (app.timeline.view.zoom - 1.0).abs() < 0.01 {
                "Fit".to_owned()
            } else {
                format!("{}%", (app.timeline.view.zoom * 100.0).round() as i32)
            };
            let fit_btn = ui.add_enabled(
                can_nav,
                egui::Button::new(RichText::new(fit_label).size(11.5).color(if can_nav { t.text2 } else { t.text3 }))
                    .frame(false)
                    .min_size(vec2(34.0, 24.0)),
            );
            fit_btn.widget_info(|| WidgetInfo::labeled(egui::Role::Button, can_nav, "Fit Timeline"));
            if fit_btn.on_hover_text("Fit the entire timeline").clicked() {
                app.timeline.view.fit();
            }

            // Loop toggle
            let loop_on = app.transport.looping;
            if icon_button_tip(ui, &t, Icon::Loop, "Loop Playback", "Loop Playback", true, loop_on, 26.0).clicked()
                && let Some(vp) = app.doc.viewport()
            {
                app.transport.set_looping(vp, !loop_on);
            }

            // Playback rate menu
            let rate_txt = format_rate(app.transport.rate);
            ui.menu_button(RichText::new(rate_txt).size(11.5).color(t.text2), |ui| {
                for r in RATES {
                    let chosen = (app.transport.rate - r).abs() < 1e-6;
                    if ui.selectable_label(chosen, format_rate(r)).clicked() {
                        if let Some(vp) = app.doc.viewport() {
                            app.transport.set_rate(vp, r);
                        }
                        ui.close();
                    }
                }
            });
        },
    );
}

fn timeline_overflow_menu(ui: &mut Ui, app: &mut BrickMotionApp) {
    let ctx = app.ctx();
    for (id, label) in [
        ("video.plan_build", "Plan Build"),
        ("video.regenerate", "Rebuild"),
        ("video.standard_preview", "Try Standard Preview"),
        ("video.order", "Regenerate Build Steps"),
    ] {
        let on = find(id).is_some_and(|c| enabled(c, &ctx));
        if ui.add_enabled(on, egui::Button::new(label)).clicked() {
            app.requested.push(id);
            ui.close();
        }
    }
    ui.separator();
    if ui.checkbox(&mut app.prefs.play_snap_sounds, "Play snap sounds").changed() {
        let _ = app.prefs.save(&app.support);
    }
    if ui.checkbox(&mut app.prefs.auto_plan, "Plan automatically").changed() {
        let _ = app.prefs.save(&app.support);
        app.apply_viewport_prefs();
    }
    ui.checkbox(&mut app.timeline.follows_playhead, "Follow playhead");
}

/// Which row heights appear under the ruler for both the track heads and the lanes.
struct RowLayout {
    build_open: bool,
    submodel_depths: Vec<i32>,
    parts_h: f32,
}

impl RowLayout {
    fn from_app(app: &BrickMotionApp) -> Self {
        let build_open = app.timeline.open.contains(&Track::Build) && app.transport.lanes.is_some();
        let mut depths: Vec<i32> = app
            .transport
            .lanes
            .as_ref()
            .map(|l| {
                let mut ds: Vec<i32> = l.submodels.iter().map(|s| s.depth).collect();
                ds.sort_unstable();
                ds.dedup();
                ds
            })
            .unwrap_or_default();
        if !build_open {
            depths.clear();
        }
        Self {
            build_open,
            submodel_depths: depths,
            parts_h: PARTS_PLACEHOLDER_H,
        }
    }
}

fn timeline_body(ui: &mut Ui, app: &mut BrickMotionApp, heads: Rect, lanes: Rect) {
    let t = app.theme;
    let row_sep = Stroke::new(1.0, Color32::from_rgb(0x20, 0x22, 0x28));

    // Top ruler row (26 px), fixed above the scrollable tracks.
    let head_ruler = Rect::from_min_size(heads.min, vec2(heads.width(), RULER_H));
    let lane_ruler = Rect::from_min_size(lanes.min, vec2(lanes.width(), RULER_H));
    app.timeline.last_ruler_rect = Some(lane_ruler);
    ui.painter()
        .hline(head_ruler.x_range(), head_ruler.bottom() - 0.5, Stroke::new(1.0, t.border));
    ui.painter()
        .hline(lane_ruler.x_range(), lane_ruler.bottom() - 0.5, Stroke::new(1.0, t.border));

    // Handle ruler zoom/pan, scrub, follow playhead, and global drag release (Review Focus 5).
    let dur = app.transport.duration();
    let can_nav = (app.transport.ready() || app.transport.stale_shown()) && dur > 0.0;
    handle_navigation_and_drags(ui, app, lanes, lane_ruler, dur, can_nav);
    paint_ruler(ui, app, lane_ruler, dur, can_nav);

    // Below the ruler: Failed state replaces lanes with the single error row (m4-rulings.md).
    let tracks_body = Rect::from_min_max(pos2(heads.left(), head_ruler.bottom()), lanes.max);
    let tracks_lanes = Rect::from_min_max(pos2(lanes.left(), lane_ruler.bottom()), lanes.max);

    if app.transport.state.plan == PlanState::Failed {
        draw_collapsed_heads(ui, app, Rect::from_min_max(pos2(heads.left(), head_ruler.bottom()), heads.max), row_sep);
        failed_row(ui, app, tracks_lanes);
        return;
    }

    if app.transport.lanes.is_none() {
        draw_collapsed_heads(ui, app, Rect::from_min_max(pos2(heads.left(), head_ruler.bottom()), heads.max), row_sep);
        empty_placeholder(ui, app, tracks_lanes);
        return;
    }

    let layout = RowLayout::from_app(app);

    // Synchronized vertical scroll for track heads + lanes together.
    ui.scope_builder(UiBuilder::new().max_rect(tracks_body), |ui| {
        egui::ScrollArea::vertical()
            .id_salt("tl-tracks-scroll")
            .auto_shrink([false, false])
            .show(ui, |ui| {
                ui.spacing_mut().item_spacing = vec2(0.0, 0.0);

                // 1. Camera (collapsed)
                split_row(
                    ui,
                    heads.width(),
                    lanes.width(),
                    TRACK_H,
                    row_sep,
                    |ui, hr| {
                        track_head(ui, &t, hr, Icon::Cam, "Camera", false, false, None);
                    },
                    |ui, lr| empty_lane(ui, &t, lr, "No keys yet"),
                );

                // 2. Build header row
                let has_diag = app.transport.standard_preview()
                    || !app.transport.notes().is_empty()
                    || app.transport.lanes.as_ref().is_some_and(|l| !l.diagnostics.is_empty());
                let diag_count = app.transport.lanes.as_ref().map_or(0, |l| l.diagnostics.len());
                let diag_badge = if has_diag {
                    Some(if app.transport.standard_preview() {
                        "Standard Preview".to_owned()
                    } else if diag_count > 0 {
                        format!("{diag_count} flagged")
                    } else {
                        "Build Notes".to_owned()
                    })
                } else {
                    None
                };
                let mut toggle_build = false;
                let mut toggle_diag = false;
                split_row(
                    ui,
                    heads.width(),
                    lanes.width(),
                    TRACK_H,
                    row_sep,
                    |ui, hr| {
                        let (toggled, diag_clicked) =
                            track_head(ui, &t, hr, Icon::Layers, "Build", true, layout.build_open, diag_badge.as_deref());
                        toggle_build = toggled;
                        toggle_diag = diag_clicked;
                    },
                    |_ui, _lr| {},
                );
                if toggle_build && !app.timeline.open.remove(&Track::Build) {
                    app.timeline.open.insert(Track::Build);
                }
                if toggle_diag {
                    app.timeline.show_diagnostics = !app.timeline.show_diagnostics;
                }

                // Build sub-lanes when open
                if layout.build_open {
                    let sub_bg = Color32::from_rgb(0x17, 0x18, 0x1b);

                    // 2a. Sequence
                    split_row(
                        ui,
                        heads.width(),
                        lanes.width(),
                        SEQ_H,
                        row_sep,
                        |ui, hr| sub_head(ui, &t, hr, sub_bg, "Sequence"),
                        |ui, lr| {
                            ui.painter().rect_filled(lr, 0.0, sub_bg);
                            sequence_lane(ui, app, lr, dur);
                        },
                    );

                    // 2b. Steps
                    split_row(
                        ui,
                        heads.width(),
                        lanes.width(),
                        STEPS_H,
                        row_sep,
                        |ui, hr| sub_head(ui, &t, hr, sub_bg, "Steps"),
                        |ui, lr| {
                            ui.painter().rect_filled(lr, 0.0, sub_bg);
                            steps_lane(ui, app, lr, dur);
                        },
                    );

                    // 2c. Pauses
                    split_row(
                        ui,
                        heads.width(),
                        lanes.width(),
                        PAUSE_H,
                        row_sep,
                        |ui, hr| sub_head(ui, &t, hr, sub_bg, "Pauses"),
                        |ui, lr| {
                            ui.painter().rect_filled(lr, 0.0, sub_bg);
                            pauses_lane(ui, app, lr, dur);
                        },
                    );

                    // 2d. Submodel lanes (one per depth level)
                    for &depth in &layout.submodel_depths {
                        let head_label = if depth == 0 {
                            "Submodels".to_owned()
                        } else {
                            format!("Submodels ({})", depth + 1)
                        };
                        split_row(
                            ui,
                            heads.width(),
                            lanes.width(),
                            SUB_H,
                            row_sep,
                            |ui, hr| sub_head(ui, &t, hr, sub_bg, &head_label),
                            |ui, lr| {
                                ui.painter().rect_filled(lr, 0.0, sub_bg);
                                submodels_lane(ui, app, lr, dur, depth);
                            },
                        );
                    }

                    // 2e. Parts (populated in Task 7)
                    split_row(
                        ui,
                        heads.width(),
                        lanes.width(),
                        layout.parts_h,
                        row_sep,
                        |ui, hr| sub_head(ui, &t, hr, sub_bg, "Parts"),
                        |ui, lr| {
                            ui.painter().rect_filled(lr, 0.0, sub_bg);
                            app.timeline.last_parts_rect = Some(lr);
                        },
                    );
                }

                // 3. Keys (collapsed)
                split_row(
                    ui,
                    heads.width(),
                    lanes.width(),
                    TRACK_H,
                    row_sep,
                    |ui, hr| {
                        track_head(ui, &t, hr, Icon::Keys, "Keys", false, false, None);
                    },
                    |ui, lr| empty_lane(ui, &t, lr, "No keys yet"),
                );

                // 4. Snaps (seat ticks only)
                split_row(
                    ui,
                    heads.width(),
                    lanes.width(),
                    TRACK_H,
                    row_sep,
                    |ui, hr| {
                        track_head(ui, &t, hr, Icon::Wave, "Snaps", false, false, None);
                    },
                    |ui, lr| snaps_lane(ui, app, lr, dur),
                );
            });
    });

    // Grey out lanes while replanning (keep last Ready build visible underneath).
    if app.transport.busy() {
        ui.painter()
            .rect_filled(tracks_lanes, 0.0, Color32::from_rgba_unmultiplied(0x1a, 0x1b, 0x1f, 130));
    }

    // Orange playhead line + timecode cap drawn over ruler and all lanes.
    if dur > 0.0 {
        paint_playhead(ui, app, lanes, dur);
    }
}

fn split_row(
    ui: &mut Ui,
    head_w: f32,
    lane_w: f32,
    height: f32,
    sep: Stroke,
    head: impl FnOnce(&mut Ui, Rect),
    lane: impl FnOnce(&mut Ui, Rect),
) {
    let (row, _) = ui.allocate_exact_size(vec2(head_w + lane_w, height), Sense::hover());
    let hr = Rect::from_min_size(row.min, vec2(head_w, height));
    let lr = Rect::from_min_size(pos2(row.left() + head_w, row.top()), vec2(lane_w, height));
    head(ui, hr);
    lane(ui, lr);
    ui.painter().hline(row.x_range(), row.bottom() - 0.5, sep);
    ui.painter().vline(hr.right() - 0.5, row.y_range(), Stroke::new(1.0, Color32::from_rgb(0x2c, 0x2f, 0x36)));
}

fn draw_collapsed_heads(ui: &mut Ui, app: &BrickMotionApp, heads: Rect, sep: Stroke) {
    let t = app.theme;
    let mut y = heads.top();
    for (name, icon) in [
        ("Camera", Icon::Cam),
        ("Build", Icon::Layers),
        ("Keys", Icon::Keys),
        ("Snaps", Icon::Wave),
    ] {
        let hr = Rect::from_min_size(pos2(heads.left(), y), vec2(heads.width(), TRACK_H));
        track_head(ui, &t, hr, icon, name, false, false, None);
        ui.painter().hline(hr.x_range(), hr.bottom() - 0.5, sep);
        y += TRACK_H;
    }
}

#[allow(clippy::too_many_arguments)]
fn track_head(
    ui: &mut Ui,
    t: &Theme,
    r: Rect,
    icon: Icon,
    name: &str,
    expandable: bool,
    open: bool,
    badge: Option<&str>,
) -> (bool, bool) {
    let y = r.center().y;
    let mut toggled = false;
    let mut badge_clicked = false;
    let chev_r = Rect::from_center_size(pos2(r.left() + 16.0, y), vec2(16.0, 16.0));
    if expandable {
        let resp = ui.interact(chev_r, ui.scope_id().with(("tl-chev", name)), Sense::click());
        resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, open, format!("Toggle {name}")));
        if resp.clicked() {
            toggled = true;
        }
    }
    icons::paint(
        ui,
        if open { Icon::Down } else { Icon::Chevron },
        chev_r,
        12.0,
        t.text3,
    );
    icons::paint(ui, icon, Rect::from_center_size(pos2(r.left() + 36.0, y), vec2(16.0, 16.0)), 16.0, t.text3);
    let lr = Rect::from_min_max(pos2(r.left() + 52.0, r.top()), r.max);
    ui.scope_builder(UiBuilder::new().max_rect(lr).layout(Layout::left_to_right(Align::Center)), |ui| {
        ui.label(RichText::new(name).color(t.text1));
        if let Some(b) = badge {
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.add_space(8.0);
                let resp = ui
                    .add(
                        egui::Button::new(RichText::new(b).size(11.0).color(t.playhead))
                            .fill(Color32::from_rgba_unmultiplied(0xff, 0x9f, 0x43, 28))
                            .stroke(Stroke::NONE)
                            .corner_radius(4),
                    )
                    .on_hover_text("Show planner diagnostics");
                if resp.clicked() {
                    badge_clicked = true;
                }
            });
        }
    });
    (toggled, badge_clicked)
}

fn sub_head(ui: &mut Ui, t: &Theme, r: Rect, bg: Color32, name: &str) {
    ui.painter().rect_filled(r, 0.0, bg);
    let lr = Rect::from_min_max(pos2(r.left() + 34.0, r.top()), r.max);
    ui.scope_builder(UiBuilder::new().max_rect(lr).layout(Layout::left_to_right(Align::Center)), |ui| {
        ui.label(RichText::new(name).size(11.5).color(t.text3));
    });
}

fn empty_lane(ui: &Ui, t: &Theme, r: Rect, text: &str) {
    ui.painter().text(
        pos2(r.left() + 12.0, r.center().y),
        Align2::LEFT_CENTER,
        text,
        FontId::proportional(11.5),
        t.text3,
    );
}

fn empty_placeholder(ui: &mut Ui, app: &mut BrickMotionApp, r: Rect) {
    let t = app.theme;
    ui.scope_builder(UiBuilder::new().max_rect(r), |ui| {
        ui.vertical_centered(|ui| {
            ui.add_space((r.height() * 0.32).max(16.0));
            if app.transport.busy() {
                ui.label(RichText::new(app.transport.stage_label()).size(13.0).color(t.text1));
                ui.add_space(6.0);
                let (slot, _) = ui.allocate_exact_size(vec2(120.0, 4.0), Sense::hover());
                ui.painter().rect_filled(slot, 2.0, t.bg3);
                let phase = (ui.input(|i| i.time) * 0.9).fract() as f32;
                let w = 40.0;
                let x0 = (slot.left() - w + phase * (slot.width() + w)).max(slot.left());
                let x1 = (slot.left() - w + phase * (slot.width() + w) + w).min(slot.right());
                if x1 > x0 {
                    ui.painter().rect_filled(
                        Rect::from_min_max(pos2(x0, slot.top()), pos2(x1, slot.bottom())),
                        2.0,
                        t.accent,
                    );
                }
            } else if app.piece_count() == 0 {
                ui.label(RichText::new("Add parts to animate").size(12.5).color(t.text3));
            } else {
                ui.label(RichText::new("The build hasn't been planned yet.").size(12.5).color(t.text2));
                ui.add_space(8.0);
                let btn = egui::Button::new(RichText::new("Plan Build").color(Color32::WHITE))
                    .fill(t.accent)
                    .stroke(Stroke::NONE)
                    .corner_radius(6);
                if ui.add(btn).clicked() {
                    app.requested.push("video.plan_build");
                }
            }
        });
    });
}

fn failed_row(ui: &mut Ui, app: &mut BrickMotionApp, r: Rect) {
    let t = app.theme;
    let card = Rect::from_min_size(r.min + vec2(12.0, 10.0), vec2((r.width() - 24.0).max(200.0), 44.0));
    ui.painter()
        .rect(card, CornerRadius::same(8), t.bg2, Stroke::new(1.0, t.border2), StrokeKind::Inside);
    ui.scope_builder(UiBuilder::new().max_rect(card.shrink2(vec2(12.0, 6.0))), |ui| {
        ui.horizontal_centered(|ui| {
            ui.spacing_mut().item_spacing.x = 8.0;
            icons::icon(ui, Icon::Help, 16.0, t.playhead);
            ui.label(RichText::new("The build could not be planned.").strong().color(t.text1));
            if !app.transport.failure.is_empty() {
                ui.label(RichText::new(&app.transport.failure).color(t.text2));
            }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.spacing_mut().item_spacing.x = 8.0;
                let again = egui::Button::new(RichText::new("Try Again").color(Color32::WHITE))
                    .fill(t.accent)
                    .stroke(Stroke::NONE)
                    .corner_radius(6);
                if ui.add(again).clicked() {
                    app.requested.push("video.regenerate");
                }
                let std_btn = egui::Button::new(RichText::new("Try Standard Preview").color(t.text1))
                    .fill(t.bg3)
                    .stroke(Stroke::new(1.0, t.border2))
                    .corner_radius(6);
                if ui.add(std_btn).clicked() {
                    app.requested.push("video.standard_preview");
                }
            });
        });
    });
}

fn handle_navigation_and_drags(
    ui: &mut Ui,
    app: &mut BrickMotionApp,
    lanes: Rect,
    ruler: Rect,
    dur: f64,
    can_nav: bool,
) {
    // Follow playhead while playing.
    if can_nav && app.transport.state.playing && app.timeline.follows_playhead && !app.timeline.scrubbing {
        app.timeline.view.reveal(app.transport.time(), dur, false);
    }

    // Pinch / ⌘-scroll zoom and horizontal pan anywhere over the lanes area.
    let (primary_down, latest_pos, hover_pos, scroll, zoom_delta, mods, esc) = ui.input(|i| {
        (
            i.pointer.primary_down(),
            i.pointer.latest_pos(),
            i.pointer.hover_pos(),
            i.smooth_scroll_delta(),
            i.zoom_delta(),
            i.modifiers,
            i.key_pressed(Key::Escape),
        )
    });

    if can_nav && hover_pos.is_some_and(|p| lanes.contains(p)) {
        let local_x = hover_pos.map_or(lanes.width() * 0.5, |p| p.x - lanes.left()) as f64;
        if (zoom_delta - 1.0).abs() > 1e-4 {
            app.timeline.view.magnify(zoom_delta as f64, local_x);
        } else if mods.command && scroll.y.abs() > 0.1 {
            let factor = 1.003_f64.powf(scroll.y as f64);
            app.timeline.view.magnify(factor, local_x);
        } else {
            let pan_dx = if scroll.x.abs() > 0.1 {
                scroll.x
            } else if mods.shift && scroll.y.abs() > 0.1 {
                scroll.y
            } else {
                0.0
            };
            if pan_dx.abs() > 0.1 {
                let max_off = app.timeline.view.maximum_offset();
                app.timeline.view.offset = (app.timeline.view.offset - pan_dx as f64).clamp(0.0, max_off);
            }
        }
    }

    // Ruler press starts scrubbing.
    let ruler_resp = ui.interact(
        ruler,
        ui.scope_id().with("tl-ruler"),
        if can_nav { Sense::click_and_drag() } else { Sense::hover() },
    );
    ruler_resp.widget_info(|| WidgetInfo::labeled(egui::Role::Slider, can_nav, "Timeline Ruler"));
    if can_nav && (ruler_resp.is_pointer_button_down_on() || ruler_resp.clicked() || ruler_resp.drag_started()) {
        app.timeline.scrubbing = true;
        app.timeline.drag = Some(TimelineDrag::Scrub);
        if let Some(pos) = ruler_resp.interact_pointer_pos().or(latest_pos) {
            let t = app.timeline.view.time_at((pos.x - lanes.left()) as f64, dur);
            if let Some(vp) = app.doc.viewport() {
                app.transport.seek(vp, t);
            }
        }
    }

    // Escape cancels Hold / Trim drag without committing.
    if esc && matches!(app.timeline.drag, Some(TimelineDrag::Hold { .. } | TimelineDrag::Trim { .. })) {
        app.timeline.drag = None;
    }

    // Active drag continuation & global release (even outside the window — Review Focus 5).
    if let Some(drag) = app.timeline.drag.clone() {
        if primary_down {
            if let Some(pos) = latest_pos {
                let local_x = (pos.x - lanes.left()) as f64;
                if app.timeline.view.pan_at_edge(local_x) {
                    ui.ctx().request_repaint();
                }
                match drag {
                    TimelineDrag::Scrub => {
                        let t = app.timeline.view.time_at(local_x, dur);
                        if let Some(vp) = app.doc.viewport() {
                            app.transport.seek(vp, t);
                        }
                    }
                    TimelineDrag::Hold { run, step, start_x, original, .. } => {
                        let lw = app.timeline.view.logical_width().max(1.0);
                        let dx = (pos.x - start_x) as f64;
                        let raw = original + dx / lw * dur;
                        let seconds = ((raw * 10.0).round() / 10.0).clamp(0.0, 10.0);
                        app.timeline.drag = Some(TimelineDrag::Hold { run, step, start_x, original, seconds });
                    }
                    TimelineDrag::Trim { segment, start_x, original, .. } => {
                        let lw = app.timeline.view.logical_width().max(1.0);
                        let dx = (pos.x - start_x) as f64;
                        let raw = original + dx / lw * dur;
                        let (lo, hi) = if segment == Segment::Build { (1.0, 1800.0) } else { (0.2, 120.0) };
                        let seconds = ((raw * 10.0).round() / 10.0).clamp(lo, hi);
                        app.timeline.drag = Some(TimelineDrag::Trim { segment, start_x, original, seconds });
                    }
                }
            }
        } else {
            // Pointer released anywhere -> commit once and clear drag.
            app.timeline.drag = None;
            app.timeline.scrubbing = false;
            match drag {
                TimelineDrag::Scrub => {}
                TimelineDrag::Hold { step, original, seconds, .. } => {
                    if (seconds - original).abs() >= 0.05 {
                        commit_hold(app, step, seconds);
                    }
                }
                TimelineDrag::Trim { segment, original, seconds, .. } => {
                    if (seconds - original).abs() >= 0.05 {
                        let c = app.doc.session().set_sequence_duration(segment, seconds);
                        app.edited(c);
                    }
                }
            }
        }
    } else if app.timeline.scrubbing && !primary_down {
        app.timeline.scrubbing = false;
    }

    // Keyboard ← / → on a focused hold handle adjust hold by ±0.1 s.
    if let Some((_run_id, step)) = app.timeline.focused_hold
        && !app.text_focus
        && app.timeline.drag.is_none()
    {
        let left = ui.input_mut(|i| i.consume_key(egui::Modifiers::NONE, Key::ArrowLeft));
        let right = ui.input_mut(|i| i.consume_key(egui::Modifiers::NONE, Key::ArrowRight));
        if left || right {
            let cur = app.steps.row(step).map_or(0.0, |r| r.pause_after);
            let next = ((cur + if right { 0.1 } else { -0.1 }) * 10.0).round() / 10.0;
            commit_hold(app, step, next.clamp(0.0, 10.0));
        }
    }
}

fn commit_hold(app: &mut BrickMotionApp, step: usize, seconds: f64) {
    let Some(row) = app.steps.row(step) else { return };
    let fields = StepFields {
        title: row.title.clone(),
        notes: row.notes.clone(),
        pause_after: seconds.clamp(0.0, 10.0),
        pin_order: row.pin_order,
    };
    let c = app.doc.session().set_step_fields(step, &fields, false);
    app.edited(c);
}

fn paint_ruler(ui: &Ui, app: &BrickMotionApp, r: Rect, dur: f64, can_nav: bool) {
    let t = app.theme;
    let p = ui.painter_at(r);
    if !can_nav || dur <= 0.0 {
        return;
    }
    let view = app.timeline.view;
    let lw = view.logical_width();
    let major = tick_interval(dur, lw).max(0.01);
    let minor = major / 5.0;

    let v0 = (view.visible_start() * dur - major).max(0.0);
    let v1 = (view.visible_end() * dur + major).min(dur);
    let first_tick = (v0 / minor).floor() as i64;
    let last_tick = (v1 / minor).ceil() as i64;

    for k in first_tick..=last_tick {
        let time = k as f64 * minor;
        if time < -1e-6 || time > dur + 1e-6 {
            continue;
        }
        let sx = r.left() + view.screen_x(time.clamp(0.0, dur), dur) as f32;
        if sx < r.left() - 2.0 || sx > r.right() + 2.0 {
            continue;
        }
        let big = k.rem_euclid(5) == 0;
        let h = if big { 9.0 } else { 5.0 };
        p.vline(
            sx,
            (r.bottom() - h)..=r.bottom(),
            Stroke::new(1.0, if big { t.text3 } else { t.border2 }),
        );
        if big {
            p.text(
                pos2(sx + 4.0, r.top() + 5.0),
                Align2::LEFT_TOP,
                format_ruler(time),
                FontId::monospace(10.5),
                t.text3,
            );
        }
    }
}

fn paint_playhead(ui: &Ui, app: &BrickMotionApp, lanes: Rect, dur: f64) {
    let t = app.theme;
    let cur = app.transport.time();
    let sx = lanes.left() + app.timeline.view.screen_x(cur, dur) as f32;
    if sx < lanes.left() - 20.0 || sx > lanes.right() + 20.0 {
        return;
    }
    let p = ui.painter_at(lanes);
    p.vline(sx, lanes.y_range(), Stroke::new(1.5, t.playhead));
    let cap = Rect::from_min_size(pos2(sx - 5.5, lanes.top()), vec2(11.0, 11.0));
    p.rect_filled(cap, CornerRadius { nw: 2, ne: 2, sw: 6, se: 6 }, t.playhead);
}

fn sequence_lane(ui: &mut Ui, app: &mut BrickMotionApp, r: Rect, dur: f64) {
    if dur <= 0.0 {
        return;
    }
    let t = app.theme;
    let view = app.timeline.view;
    let authored = [
        (Segment::Intro, "Intro", app.transport.build_start()),
        (Segment::Build, "Build", (app.transport.build_end() - app.transport.build_start()).max(0.0)),
        (Segment::Hero, "Hero", (dur - app.transport.build_end()).max(0.0)),
    ];
    let shown = |seg: Segment, def: f64| match &app.timeline.drag {
        Some(TimelineDrag::Trim { segment, seconds, .. }) if *segment == seg => *seconds,
        _ => def,
    };
    let d_intro = shown(Segment::Intro, authored[0].2);
    let d_build = shown(Segment::Build, authored[1].2);
    let d_hero = shown(Segment::Hero, authored[2].2);
    let items = [
        (Segment::Intro, "Intro", 0.0, d_intro, authored[0].2, None),
        (Segment::Build, "Build", d_intro, d_build, authored[1].2, Some((Segment::Intro, authored[0].2))),
        (Segment::Hero, "Hero", d_intro + d_build, d_hero, authored[2].2, Some((Segment::Build, authored[1].2))),
    ];

    let clip_p = ui.painter_at(r);
    let mut seek_to: Option<f64> = None;
    let mut start_trim: Option<(Segment, f32, f64)> = None;

    for (seg, title, from, len, orig, _prec) in items {
        let x0 = r.left() + view.screen_x(from, dur) as f32;
        let x1 = r.left() + view.screen_x(from + len, dur) as f32;
        let w = (x1 - x0 - 2.0).max(0.0);
        if w < 3.0 || x1 < r.left() || x0 > r.right() {
            continue;
        }
        let rect = Rect::from_min_size(pos2(x0 + 1.0, r.top() + 4.0), vec2(w, r.height() - 8.0));
        let dragging_this = matches!(&app.timeline.drag, Some(TimelineDrag::Trim { segment, .. }) if *segment == seg);
        let fill = if dragging_this {
            t.accent_bg()
        } else {
            Color32::from_rgba_unmultiplied(255, 255, 255, 19)
        };
        clip_p.rect_filled(rect, 4.0, fill);
        if dragging_this {
            clip_p.rect_stroke(rect, 4.0, Stroke::new(1.0, t.accent), StrokeKind::Inside);
        }

        // Trailing trim handle (also registered with accessible label for tests).
        let handle_w = w.min(10.0);
        let handle_r = Rect::from_min_max(pos2(rect.right() - handle_w, rect.top()), rect.max);
        let body_r = Rect::from_min_max(rect.min, pos2(handle_r.left().max(rect.left()), rect.bottom()));

        let h_resp = ui
            .interact(handle_r, ui.scope_id().with(("seq-trim", title)), Sense::drag())
            .on_hover_cursor(CursorIcon::ResizeHorizontal);
        h_resp.widget_info(|| WidgetInfo::labeled(egui::Role::Slider, true, format!("Trim {title}")));
        if h_resp.hovered() || dragging_this {
            clip_p.rect_filled(
                Rect::from_center_size(pos2(rect.right() - 3.0, rect.center().y), vec2(2.0, 10.0)),
                1.0,
                t.text2,
            );
        }
        if h_resp.drag_started()
            && let Some(pos) = ui.input(|i| i.pointer.press_origin()).or_else(|| h_resp.interact_pointer_pos())
        {
            start_trim = Some((seg, pos.x, orig));
        }

        if body_r.width() > 2.0 {
            let b_resp = ui.interact(body_r, ui.scope_id().with(("seq-body", title)), Sense::click());
            b_resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, title));
            if b_resp.clicked() {
                seek_to = Some(from);
            }
        }

        if w > 36.0 {
            let label = if dragging_this {
                format!("{len:.1} s")
            } else {
                title.to_owned()
            };
            clip_p.text(rect.center(), Align2::CENTER_CENTER, label, FontId::proportional(11.0), t.text2);
        }
    }

    if let Some((segment, start_x, original)) = start_trim {
        app.timeline.drag = Some(TimelineDrag::Trim {
            segment,
            start_x,
            original,
            seconds: original,
        });
    } else if let Some(s) = seek_to
        && let Some(vp) = app.doc.viewport()
    {
        app.transport.seek(vp, s);
    }
}

fn steps_lane(ui: &mut Ui, app: &mut BrickMotionApp, r: Rect, dur: f64) {
    let Some(lanes) = app.transport.lanes.clone() else { return };
    if dur <= 0.0 || lanes.runs.is_empty() {
        return;
    }
    let t = app.theme;
    let view = app.timeline.view;
    let margin = 96.0 * dur / view.logical_width().max(1.0);
    let vis0 = view.visible_start() * dur - margin;
    let vis1 = view.visible_end() * dur + margin;
    let active_run = app.transport.playhead_run;
    let active_step = app.transport.current_step();

    let clip_p = ui.painter_at(r);
    let mut clicked_run: Option<(usize, usize)> = None;
    let mut double_clicked_step: Option<usize> = None;
    let mut menu_action: Option<(usize, StepMenuAction)> = None;

    for run in &lanes.runs {
        if run.next < vis0 || run.start > vis1 {
            continue;
        }
        let Ok(step) = usize::try_from(run.step) else { continue };
        let x0 = r.left() + view.screen_x(run.start, dur) as f32;
        let x1 = r.left() + view.screen_x(run.end, dur) as f32;
        let w = (x1 - x0 - 2.0).max(2.0);
        let rect = Rect::from_min_size(pos2(x0 + 1.0, r.top() + 5.0), vec2(w, r.height() - 10.0));
        if rect.right() < r.left() || rect.left() > r.right() {
            continue;
        }
        let visible_rect = rect.intersect(r);
        let selected = active_run == Some(run.id) || active_step == Some(step);

        let resp = ui.interact(visible_rect, ui.scope_id().with(("tl-run", run.id)), Sense::click());
        let label_name = format!("Step {}", step + 1);
        resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, selected, &label_name));

        let fill = if selected {
            t.accent_bg()
        } else if resp.hovered() {
            Color32::from_rgb(0x2d, 0x31, 0x38)
        } else {
            t.bg3
        };
        let stroke = Stroke::new(1.0, if selected { t.accent } else { t.border2 });
        clip_p.rect(rect, CornerRadius::same(5), fill, stroke, StrokeKind::Inside);

        if w >= 22.0 {
            let title = app.steps.row(step).map(|s| s.title.as_str()).unwrap_or("");
            let text = if w > 88.0 && !title.is_empty() {
                format!("Step {} · {title}", step + 1)
            } else if w > 48.0 {
                format!("Step {}", step + 1)
            } else {
                format!("{}", step + 1)
            };
            let text_clip = rect.shrink2(vec2(6.0, 0.0)).intersect(r);
            if text_clip.width() > 2.0 {
                ui.painter().with_clip_rect(text_clip).text(
                    pos2(rect.left() + 7.0, rect.center().y),
                    Align2::LEFT_CENTER,
                    text,
                    FontId::proportional(11.0),
                    if selected { t.text1 } else { t.text2 },
                );
            }
        }

        if resp.double_clicked() {
            double_clicked_step = Some(step);
        } else if resp.clicked() {
            clicked_run = Some((run.id, step));
        }

        let mut ctx_for_step = app.ctx();
        ctx_for_step.step = Some(step);
        resp.context_menu(|ui| {
            if ui.button("Play Step").clicked() {
                menu_action = Some((step, StepMenuAction::PlayStep));
                ui.close();
            }
            if ui.button("Play to End").clicked() {
                menu_action = Some((step, StepMenuAction::PlayToEnd));
                ui.close();
            }
            if ui.button("Select Pieces").clicked() {
                menu_action = Some((step, StepMenuAction::SelectPieces));
                ui.close();
            }
            ui.separator();
            let entries: &[(&str, &str)] = &[
                ("step.edit", "Edit Step…"),
                ("step.insert_before", "Insert Step Before"),
                ("step.insert_after", "Insert Step After"),
                ("step.split", "Split at Selection"),
                ("step.merge", "Merge with Next"),
                ("model.to_step", "Gather Selection Here"),
                ("step.move_up", "Move Step Up"),
                ("step.move_down", "Move Step Down"),
                ("step.delete", "Delete Step"),
            ];
            for (k, &(cmd_id, label)) in entries.iter().enumerate() {
                if matches!(k, 1 | 3 | 6 | 8) {
                    ui.separator();
                }
                let on = find(cmd_id).is_some_and(|c| enabled(c, &ctx_for_step));
                if ui.add_enabled(on, egui::Button::new(label)).clicked() {
                    menu_action = Some((step, StepMenuAction::Command(cmd_id)));
                    ui.close();
                }
            }
        });
    }

    if let Some(step) = double_clicked_step {
        app.edit.step = Some(step);
        let (session, vp) = app.doc.parts();
        if let Some(vp) = vp {
            app.transport.play_step(vp, session, step, false);
        }
    } else if let Some((run_id, step)) = clicked_run {
        app.edit.step = Some(step);
        if let Some(vp) = app.doc.viewport() {
            app.transport.select_run(vp, run_id);
        }
    } else if let Some((step, action)) = menu_action {
        app.edit.step = Some(step);
        match action {
            StepMenuAction::PlayStep => {
                let (session, vp) = app.doc.parts();
                if let Some(vp) = vp {
                    app.transport.play_step(vp, session, step, false);
                }
            }
            StepMenuAction::PlayToEnd => {
                let (session, vp) = app.doc.parts();
                if let Some(vp) = vp {
                    app.transport.play_step(vp, session, step, true);
                }
            }
            StepMenuAction::SelectPieces => {
                let pieces = app.doc.session().pieces_of_step(step);
                app.doc.session().select(&pieces, bm::SelectMode::Replace);
            }
            StepMenuAction::Command(id) => {
                app.requested.push(id);
            }
        }
    }
}

enum StepMenuAction {
    PlayStep,
    PlayToEnd,
    SelectPieces,
    Command(&'static str),
}

fn pauses_lane(ui: &mut Ui, app: &mut BrickMotionApp, r: Rect, dur: f64) {
    let Some(lanes) = app.transport.lanes.clone() else { return };
    if dur <= 0.0 || lanes.runs.is_empty() {
        return;
    }
    let t = app.theme;
    let view = app.timeline.view;
    let margin = 96.0 * dur / view.logical_width().max(1.0);
    let vis0 = view.visible_start() * dur - margin;
    let vis1 = view.visible_end() * dur + margin;

    // Only the last run of each step owns that step's editable hold.
    let mut last_run: HashMap<i32, usize> = HashMap::new();
    for run in &lanes.runs {
        last_run.insert(run.step, run.id);
    }

    let clip_p = ui.painter_at(r);
    let mut start_hold: Option<(usize, usize, f32, f64)> = None;
    let mut focus_hold: Option<(usize, usize)> = None;

    for run in &lanes.runs {
        let dragging_this = matches!(&app.timeline.drag, Some(TimelineDrag::Hold { run: rid, .. }) if *rid == run.id);
        if !dragging_this && (run.next < vis0 || run.end > vis1) {
            continue;
        }
        let gap = run.next - run.end;
        if !dragging_this && gap < 0.12 {
            continue;
        }
        let step_opt = usize::try_from(run.step).ok().filter(|&s| app.steps.row(s).is_some());
        let editable = step_opt.is_some() && last_run.get(&run.step) == Some(&run.id);

        let shown_secs = match &app.timeline.drag {
            Some(TimelineDrag::Hold { run: rid, seconds, .. }) if *rid == run.id => *seconds,
            _ => gap,
        };
        let x0 = r.left() + view.screen_x(run.end, dur) as f32;
        let x1 = r.left() + view.screen_x(run.end + shown_secs, dur) as f32;
        let w = (x1 - x0).max(4.0);
        let strip = Rect::from_min_size(pos2(x0, r.center().y - 6.0), vec2(w, 12.0));
        if strip.right() < r.left() || strip.left() > r.right() {
            continue;
        }
        let focused = app.timeline.focused_hold.is_some_and(|(rid, _)| rid == run.id);
        let fill = if dragging_this || focused {
            Color32::from_rgba_unmultiplied(0x4f, 0x8c, 0xff, 110)
        } else {
            Color32::from_rgba_unmultiplied(164, 169, 177, 68)
        };
        clip_p.rect_filled(strip, 2.0, fill);

        if editable && let Some(step) = step_opt {
            let orig = app.steps.row(step).map_or(0.0, |row| row.pause_after);
            let hit = Rect::from_min_size(pos2(strip.left(), r.top() + 2.0), vec2(w.max(12.0), r.height() - 4.0))
                .intersect(r);
            let resp = ui
                .interact(hit, ui.scope_id().with(("tl-hold", run.id)), Sense::click_and_drag())
                .on_hover_cursor(CursorIcon::ResizeHorizontal);
            resp.widget_info(|| WidgetInfo::labeled(egui::Role::Slider, true, format!("Hold after Step {}", step + 1)));
            if w >= 6.0 {
                clip_p.rect_filled(
                    Rect::from_center_size(pos2(strip.right() - 2.5, strip.center().y), vec2(2.0, 8.0)),
                    1.0,
                    Color32::from_rgba_unmultiplied(232, 234, 237, 90),
                );
            }
            if resp.clicked() {
                focus_hold = Some((run.id, step));
            }
            if resp.drag_started()
                && let Some(pos) = ui.input(|i| i.pointer.press_origin()).or_else(|| resp.interact_pointer_pos())
            {
                start_hold = Some((run.id, step, pos.x, orig));
            }
            if dragging_this {
                let badge = format!("{shown_secs:.1} s");
                let bg = Rect::from_center_size(pos2(strip.right().min(r.right() - 20.0), r.center().y), vec2(36.0, 16.0));
                clip_p.rect_filled(bg, 4.0, t.bg2);
                clip_p.rect_stroke(bg, 4.0, Stroke::new(1.0, t.accent), StrokeKind::Inside);
                clip_p.text(bg.center(), Align2::CENTER_CENTER, badge, FontId::monospace(10.0), t.text1);
            }
        }
    }

    if let Some((run, step, start_x, original)) = start_hold {
        app.timeline.focused_hold = Some((run, step));
        app.timeline.drag = Some(TimelineDrag::Hold {
            run,
            step,
            start_x,
            original,
            seconds: original,
        });
    } else if let Some(fh) = focus_hold {
        app.timeline.focused_hold = Some(fh);
    }
}

fn submodels_lane(ui: &mut Ui, app: &mut BrickMotionApp, r: Rect, dur: f64, depth: i32) {
    let Some(lanes) = app.transport.lanes.clone() else { return };
    if dur <= 0.0 {
        return;
    }
    let t = app.theme;
    let view = app.timeline.view;
    let margin = 96.0 * dur / view.logical_width().max(1.0);
    let vis0 = view.visible_start() * dur - margin;
    let vis1 = view.visible_end() * dur + margin;
    let clip_p = ui.painter_at(r);

    let mut picked: Option<(Vec<u32>, f64)> = None;
    for (idx, sm) in lanes.submodels.iter().enumerate() {
        if sm.depth != depth || sm.end < vis0 || sm.start > vis1 {
            continue;
        }
        let x0 = r.left() + view.screen_x(sm.start, dur) as f32;
        let x1 = r.left() + view.screen_x(sm.end, dur) as f32;
        let w = (x1 - x0 - 2.0).max(4.0);
        let rect = Rect::from_min_size(pos2(x0 + 1.0, r.top() + 4.0), vec2(w, r.height() - 8.0));
        if rect.right() < r.left() || rect.left() > r.right() {
            continue;
        }
        let resp = ui.interact(rect.intersect(r), ui.scope_id().with(("tl-sub", idx)), Sense::click());
        resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, &sm.name));
        clip_p.rect(
            rect,
            CornerRadius::same(4),
            if resp.hovered() {
                Color32::from_rgba_unmultiplied(0x4f, 0x8c, 0xff, 55)
            } else {
                t.bg3
            },
            Stroke::new(1.0, t.border2),
            StrokeKind::Inside,
        );
        if let Some(att) = sm.attach {
            let ax = r.left() + view.screen_x(att, dur) as f32;
            if ax >= rect.left() && ax <= rect.right() {
                clip_p.rect_filled(
                    Rect::from_min_max(pos2(ax, rect.top() + 2.0), pos2(rect.right() - 1.0, rect.bottom() - 2.0)),
                    2.0,
                    Color32::from_rgba_unmultiplied(0x4f, 0x8c, 0xff, 90),
                );
            }
        }
        if w > 36.0 && !sm.name.is_empty() {
            let tc = rect.shrink2(vec2(6.0, 0.0)).intersect(r);
            if tc.width() > 2.0 {
                ui.painter().with_clip_rect(tc).text(
                    pos2(rect.left() + 6.0, rect.center().y),
                    Align2::LEFT_CENTER,
                    &sm.name,
                    FontId::proportional(11.0),
                    t.text2,
                );
            }
        }
        if resp.clicked() {
            picked = Some((sm.pieces.clone(), sm.end));
        }
    }

    if let Some((pieces, end)) = picked {
        app.doc.session().select(&pieces, bm::SelectMode::Replace);
        if let Some(vp) = app.doc.viewport() {
            app.transport.seek(vp, end);
        }
    }
}

/// Snaps track: one thin vertical tick at each flight's seat time (`end`), drawn only for visible times.
fn snaps_lane(ui: &Ui, app: &BrickMotionApp, r: Rect, dur: f64) {
    let flights = app.transport.flights();
    if dur <= 0.0 || flights.is_empty() {
        return;
    }
    let view = app.timeline.view;
    let vis0 = view.visible_start() * dur;
    let vis1 = view.visible_end() * dur;
    let p = ui.painter_at(r);
    let alpha = if app.prefs.play_snap_sounds { 95 } else { 32 };
    let stroke = Stroke::new(1.0, Color32::from_rgba_unmultiplied(232, 234, 237, alpha));
    let y0 = r.center().y - 7.0;
    let y1 = r.center().y + 7.0;
    // Track last painted pixel so 9,720 flights zoomed out never overdraw thousands of lines on one pixel.
    let mut last_px = i32::MIN;
    for f in flights {
        if f.end < vis0 || f.end > vis1 {
            continue;
        }
        let sx = r.left() + view.screen_x(f.end, dur) as f32;
        if sx < r.left() || sx > r.right() {
            continue;
        }
        let px = sx.round() as i32;
        if px == last_px {
            continue;
        }
        last_px = px;
        p.vline(sx, y0..=y1, stroke);
    }
}

fn diagnostics_popover(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;
    let mut close = false;
    let mut pick: Option<(u32, f64)> = None;
    let diag_rows: Vec<(u32, f64, String, String, String, i32)> = app
        .transport
        .lanes
        .as_ref()
        .map(|l| {
            let flights = app.transport.flights();
            l.diagnostics
                .iter()
                .filter_map(|&idx| flights.get(idx))
                .map(|f| (f.piece, f.start, f.name.clone(), f.flag.clone(), f.blocker.clone(), f.step))
                .collect()
        })
        .unwrap_or_default();
    let notes: Vec<String> = app.transport.notes().to_vec();

    let area = egui::Area::new(Id::unique("tl-diagnostics"))
        .order(Order::Foreground)
        .anchor(Align2::LEFT_BOTTOM, vec2(12.0, -(app.timeline.height + 10.0)))
        .show(ui.ctx(), |ui| {
            float_frame(&t).inner_margin(Margin::same(12)).show(ui, |ui| {
                ui.set_width(320.0);
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Planner Diagnostics").strong().color(t.text1));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if icon_button_tip(ui, &t, Icon::Close, "Close", "Close", true, false, 22.0).clicked() {
                            close = true;
                        }
                    });
                });
                ui.add_space(6.0);
                for n in &notes {
                    ui.label(RichText::new(n).size(11.5).color(t.text2));
                }
                if !diag_rows.is_empty() {
                    ui.add_space(4.0);
                    egui::ScrollArea::vertical()
                        .max_height(220.0)
                        .auto_shrink([false, true])
                        .show(ui, |ui| {
                            for (piece, start, name, flag, blocker, step) in &diag_rows {
                                let detail = if blocker.is_empty() {
                                    flag.clone()
                                } else {
                                    format!("{flag} · {blocker}")
                                };
                                let label = format!("Step {} · {name} — {detail}", step + 1);
                                if ui.add(egui::Button::new(RichText::new(label).size(11.5).color(t.text2)).frame(false)).clicked() {
                                    pick = Some((*piece, *start));
                                    close = true;
                                }
                            }
                        });
                }
            });
        });

    if area.response.clicked_elsewhere() {
        close = true;
    }
    if let Some((piece, start)) = pick {
        app.doc.session().select(&[piece], bm::SelectMode::Replace);
        if let Some(vp) = app.doc.viewport() {
            app.transport.seek(vp, start);
        }
    }
    if close {
        app.timeline.show_diagnostics = false;
    }
}
