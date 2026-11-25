//! Build Settings Properties page (m4-rulings.md: v2 page with v3 Pace inset group).
use bm::settings::{BuildOrder, BuildSettings, FlightShape};
use egui::{Align2, Color32, CornerRadius, FontId, Frame, Margin, Rect, RichText, Sense, Stroke, Ui, WidgetInfo, pos2, vec2};

use super::widgets::{
    SliderEvent, disclosure, footnote, hairline, inset_group, page_footer, parse_number, secondary_button,
    section_header, segmented, slider_row, switch_row,
};
use crate::BrickMotionApp;
use crate::theme::Theme;

#[derive(Default)]
pub struct BuildSettingsState {
    draft: BuildSettings,
    synced: Option<(u64, u64)>,
    dragging: bool,
    pub scroll_to_flights: bool,
}

impl BuildSettingsState {
    pub fn reset(&mut self) {
        self.synced = None;
        self.dragging = false;
        self.scroll_to_flights = false;
    }

    fn sync(&mut self, session: &bm::Session) {
        let key = (session.generation(), session.version());
        if !self.dragging && self.synced != Some(key) {
            self.draft = session.build_settings();
            self.synced = Some(key);
        }
    }
}

/// Pace presets per m4-rulings.md:
/// - Standard = bmapp defaults (flight 0.425 s, gap 0.05 s, hold 0.25 s)
/// - Relaxed  = flight ×1.5 (0.6375 s), gap 0.10 s, hold 0.50 s
/// - Quick    = flight ×0.6 clamped to 0.35 s, gap 0.02 s, hold 0.15 s
const STANDARD_FLIGHT: f64 = 0.425;
const RELAXED_FLIGHT: f64 = 0.6375;
const QUICK_FLIGHT: f64 = 0.35;

fn pace_preset(s: &BuildSettings) -> usize {
    let f = s.flight_seconds();
    let near = |a: f64, b: f64| (a - b).abs() < 0.015;
    if near(f, RELAXED_FLIGHT) && near(s.gap, 0.10) && near(s.step_pause, 0.50) {
        0 // Relaxed
    } else if near(f, STANDARD_FLIGHT) && near(s.gap, 0.05) && near(s.step_pause, 0.25) {
        1 // Standard
    } else if near(f, QUICK_FLIGHT) && near(s.gap, 0.02) && near(s.step_pause, 0.15) {
        2 // Quick
    } else {
        3 // Custom
    }
}

fn apply_pace_preset(s: &mut BuildSettings, idx: usize) {
    match idx {
        0 => {
            s.set_flight_seconds(RELAXED_FLIGHT);
            s.gap = 0.10;
            s.step_pause = 0.50;
        }
        1 => {
            let def = BuildSettings::default();
            s.pieces_per_second = def.pieces_per_second;
            s.gap = def.gap;
            s.step_pause = def.step_pause;
        }
        2 => {
            s.set_flight_seconds(QUICK_FLIGHT);
            s.gap = 0.02;
            s.step_pause = 0.15;
        }
        _ => {}
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, body_max_h: f32) {
    let t = app.theme;
    app.build_settings.sync(app.doc.session());
    app.steps.sync(app.doc.session());

    let steps_count = app.steps.len();
    let parts_count = app.piece_count();
    let build_dur = if app.transport.ready() { app.transport.build_duration() } else { 0.0 };

    let mut commit_settings: Option<BuildSettings> = None;
    let mut still_dragging = false;

    let scroll_h = (body_max_h - 48.0).max(120.0);
    egui::ScrollArea::vertical()
        .id_salt("build-settings-scroll")
        .max_height(scroll_h)
        .auto_shrink([false, true])
        .show(ui, |ui| {
            let draft = &mut app.build_settings.draft;

            // 1. Summary card
            ui.add_space(12.0);
            inset_group(ui, |ui| {
                Frame::NONE.inner_margin(Margin::same(12)).show(ui, |ui| {
                    ui.spacing_mut().item_spacing.y = 8.0;
                    ui.horizontal(|ui| {
                        let dur_text = if build_dur > 0.0 {
                            let secs = build_dur.round() as u64;
                            format!("{}:{:02}", secs / 60, secs % 60)
                        } else {
                            "—".into()
                        };
                        ui.label(RichText::new(dur_text).size(22.0).strong().color(t.text1));
                        ui.add_space(4.0);
                        ui.with_layout(egui::Layout::left_to_right(egui::Align::BOTTOM), |ui| {
                            ui.label(
                                RichText::new(format!("build · {steps_count} steps · {parts_count} parts"))
                                    .size(11.5)
                                    .color(t.text3),
                            );
                        });
                    });

                    // Live rhythm bar of one step: 3 flights, 2 gaps, 1 hold.
                    paint_rhythm_bar(ui, &t, draft.flight_seconds(), draft.gap, draft.step_pause);

                    ui.label(
                        RichText::new("Changes below re-time the build.")
                            .size(11.0)
                            .color(t.text3),
                    );
                });
            });

            // 2. Pace (v3 inset group)
            let pace_enabled = draft.video_seconds <= 0.0;
            section_header(ui, &t, "Pace", None);
            inset_group(ui, |ui| {
                let mut preset = pace_preset(draft);
                Frame::NONE.inner_margin(Margin::symmetric(12, 8)).show(ui, |ui| {
                    if segmented(
                        ui,
                        &t,
                        "pace-preset",
                        &["Relaxed", "Standard", "Quick", "Custom"],
                        &mut preset,
                        pace_enabled,
                    ) && preset < 3
                    {
                        apply_pace_preset(draft, preset);
                        commit_settings = Some(*draft);
                    }
                });
                hairline(ui);

                let mut flight_s = draft.flight_seconds();
                match slider_row(
                    ui,
                    &t,
                    "bs-flight",
                    "Each flight",
                    &mut flight_s,
                    0.35..=0.90,
                    0.05,
                    |v| format!("{v:.2} s"),
                    parse_number,
                    pace_enabled,
                ) {
                    SliderEvent::Changing => {
                        draft.set_flight_seconds(flight_s);
                        still_dragging = true;
                    }
                    SliderEvent::Committed(v) => {
                        draft.set_flight_seconds(v);
                        commit_settings = Some(*draft);
                    }
                    SliderEvent::None => {}
                }
                hairline(ui);

                match slider_row(
                    ui,
                    &t,
                    "bs-gap",
                    "Gap between parts",
                    &mut draft.gap,
                    0.0..=2.0,
                    0.05,
                    |v| format!("{v:.2} s"),
                    parse_number,
                    pace_enabled,
                ) {
                    SliderEvent::Changing => still_dragging = true,
                    SliderEvent::Committed(_) => commit_settings = Some(*draft),
                    SliderEvent::None => {}
                }
                hairline(ui);

                match slider_row(
                    ui,
                    &t,
                    "bs-hold",
                    "Hold at each step",
                    &mut draft.step_pause,
                    0.0..=5.0,
                    0.05,
                    |v| format!("{v:.2} s"),
                    parse_number,
                    pace_enabled,
                ) {
                    SliderEvent::Changing => still_dragging = true,
                    SliderEvent::Committed(_) => commit_settings = Some(*draft),
                    SliderEvent::None => {}
                }
            });
            if pace_enabled {
                footnote(ui, &t, "Re-times the build straight away. Motion's flight time scales each flight.");
            } else {
                footnote(
                    ui,
                    &t,
                    &format!("The {:.0} s video length sets each flight and step hold.", draft.video_seconds),
                );
            }

            // 3. How it's planned (tagged "Replans")
            let native_on = !draft.standard_planner;
            section_header(ui, &t, "How it's planned", Some("Replans"));
            inset_group(ui, |ui| {
                // Order cards: Take Apart / Bottom Up
                Frame::NONE.inner_margin(Margin::same(10)).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 8.0;
                        let card_w = (ui.available_width() - 8.0) * 0.5;
                        if order_card(
                            ui,
                            &t,
                            "Take Apart",
                            "Planned by taking it apart",
                            true,
                            draft.order == BuildOrder::TakeApart,
                            native_on,
                            card_w,
                        ) {
                            draft.order = BuildOrder::TakeApart;
                            commit_settings = Some(*draft);
                        }
                        if order_card(
                            ui,
                            &t,
                            "Bottom Up",
                            "Built forward from the base",
                            false,
                            draft.order == BuildOrder::BottomUp,
                            native_on,
                            card_w,
                        ) {
                            draft.order = BuildOrder::BottomUp;
                            commit_settings = Some(*draft);
                        }
                    });
                });
                hairline(ui);

                // Flight path segmented control
                let flight_resp = Frame::NONE.inner_margin(Margin::symmetric(12, 10)).show(ui, |ui| {
                    ui.spacing_mut().item_spacing.y = 7.0;
                    let fg = if native_on { t.text1 } else { t.text3 };
                    ui.label(RichText::new("Flight path").size(12.5).color(fg));
                    let mut fi = match draft.flight {
                        FlightShape::Automatic => 0,
                        FlightShape::Web => 1,
                        FlightShape::Arc => 2,
                    };
                    if segmented(ui, &t, "bs-flight-shape", &["Automatic", "Web", "Arc"], &mut fi, native_on) {
                        draft.flight = match fi {
                            1 => FlightShape::Web,
                            2 => FlightShape::Arc,
                            _ => FlightShape::Automatic,
                        };
                        commit_settings = Some(*draft);
                    }
                    let help = match draft.flight {
                        FlightShape::Automatic => "Picks the cleanest path around already-placed parts.",
                        FlightShape::Web => "Routes around obstacles through clear corridors.",
                        FlightShape::Arc => "Lifts parts over the model in a smooth arc.",
                    };
                    ui.label(RichText::new(help).size(11.0).color(t.text3));
                });
                if app.build_settings.scroll_to_flights {
                    flight_resp.response.scroll_to_me(Some(egui::Align::Center));
                    app.build_settings.scroll_to_flights = false;
                }
            });

            // 4. Advanced (folded)
            disclosure(ui, &t, "bs-advanced", "Advanced", "Planner, clearance, grown units", false, |ui| {
                inset_group(ui, |ui| {
                    Frame::NONE.inner_margin(Margin::symmetric(12, 10)).show(ui, |ui| {
                        ui.spacing_mut().item_spacing.y = 7.0;
                        ui.label(RichText::new("Planner").size(12.5).color(t.text1));
                        let mut pi = usize::from(draft.standard_planner);
                        if segmented(ui, &t, "bs-planner", &["Native", "Standard"], &mut pi, true) {
                            draft.standard_planner = pi == 1;
                            commit_settings = Some(*draft);
                        }
                    });
                    hairline(ui);

                    let native_now = !draft.standard_planner;
                    match slider_row(
                        ui,
                        &t,
                        "bs-clearance",
                        "Clearance",
                        &mut draft.clearance,
                        4.0..=200.0,
                        4.0,
                        |v| format!("{v:.0} LDU"),
                        parse_number,
                        native_now,
                    ) {
                        SliderEvent::Changing => still_dragging = true,
                        SliderEvent::Committed(_) => commit_settings = Some(*draft),
                        SliderEvent::None => {}
                    }
                    hairline(ui);

                    let arc_on = native_now && draft.flight == FlightShape::Arc;
                    match slider_row(
                        ui,
                        &t,
                        "bs-corner",
                        "Corner rounding",
                        &mut draft.corner,
                        0.0..=80.0,
                        2.0,
                        |v| format!("{v:.0} LDU"),
                        parse_number,
                        arc_on,
                    ) {
                        SliderEvent::Changing => still_dragging = true,
                        SliderEvent::Committed(_) => commit_settings = Some(*draft),
                        SliderEvent::None => {}
                    }
                    hairline(ui);

                    if switch_row(ui, &t, "Split grown units", &mut draft.clean_grown_units, native_now) {
                        commit_settings = Some(*draft);
                    }
                });
            });

            ui.add_space(12.0);
        });

    // 5. Footer
    page_footer(ui, &t, |ui| {
        ui.label(RichText::new("Saved with the project").size(11.0).color(t.text3));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            let defaults = BuildSettings {
                video_seconds: app.build_settings.draft.video_seconds,
                ..BuildSettings::default()
            };
            let is_default = (app.build_settings.draft.pieces_per_second - defaults.pieces_per_second).abs() < 1e-4
                && (app.build_settings.draft.gap - defaults.gap).abs() < 1e-4
                && (app.build_settings.draft.step_pause - defaults.step_pause).abs() < 1e-4
                && app.build_settings.draft.order == defaults.order
                && app.build_settings.draft.flight == defaults.flight
                && app.build_settings.draft.standard_planner == defaults.standard_planner
                && (app.build_settings.draft.clearance - defaults.clearance).abs() < 1e-4
                && (app.build_settings.draft.corner - defaults.corner).abs() < 1e-4
                && app.build_settings.draft.clean_grown_units == defaults.clean_grown_units;
            if secondary_button(ui, &t, "Restore Defaults", !is_default).clicked() {
                app.build_settings.draft = defaults;
                commit_settings = Some(defaults);
            }
        });
    });

    app.build_settings.dragging = still_dragging;

    if let Some(next) = commit_settings {
        let c = app.doc.session().set_build_settings(&next);
        app.edited(c);
        app.build_settings.draft = app.doc.session().build_settings();
        app.build_settings.synced = Some((app.doc.session().generation(), app.doc.session().version()));
    }
}

fn paint_rhythm_bar(ui: &mut Ui, t: &Theme, flight_s: f64, gap_s: f64, hold_s: f64) {
    let f = flight_s.max(0.05) as f32;
    let g = gap_s.max(0.0) as f32;
    let h = hold_s.max(0.0) as f32;
    let total = (3.0 * f + 2.0 * g + h).max(0.1);
    let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 12.0), Sense::hover());
    ui.painter().rect_filled(rect, 4.0, Color32::from_white_alpha(12));
    let inner = rect.shrink2(vec2(2.0, 2.0));
    let mut x = inner.left();
    let w = inner.width();
    for i in 0..3 {
        let fw = (f / total) * w;
        let seg = Rect::from_min_size(pos2(x, inner.top()), vec2(fw.max(2.0), inner.height()));
        ui.painter().rect_filled(seg, 2.5, t.accent);
        x += fw;
        if i < 2 {
            x += (g / total) * w;
        }
    }
    if h > 0.001 {
        let hw = ((h / total) * w).min((inner.right() - x).max(0.0));
        if hw >= 1.5 {
            let hold_r = Rect::from_min_size(pos2(x, inner.top()), vec2(hw, inner.height()));
            ui.painter().rect_filled(hold_r, 2.5, Color32::from_rgba_unmultiplied(0xff, 0x9f, 0x43, 160));
        }
    }
    ui.label(
        RichText::new(format!("Flight {flight_s:.2} s · Gap {gap_s:.2} s · Hold {hold_s:.2} s"))
            .size(10.5)
            .color(t.text3),
    );
}

#[allow(clippy::too_many_arguments)]
fn order_card(
    ui: &mut Ui,
    t: &Theme,
    title: &str,
    subtitle: &str,
    take_apart: bool,
    selected: bool,
    enabled: bool,
    width: f32,
) -> bool {
    let (rect, resp) = ui.allocate_exact_size(
        vec2(width, 92.0),
        if enabled { Sense::click() } else { Sense::hover() },
    );
    resp.widget_info(|| WidgetInfo::selected(egui::Role::RadioButton, enabled, selected, title));
    let fill = if selected {
        Color32::from_rgba_unmultiplied(t.accent.r(), t.accent.g(), t.accent.b(), if enabled { 34 } else { 16 })
    } else if enabled && resp.hovered() {
        Color32::from_white_alpha(18)
    } else {
        Color32::from_white_alpha(10)
    };
    let stroke = if selected {
        Stroke::new(1.5, if enabled { t.accent } else { Color32::from_white_alpha(40) })
    } else {
        Stroke::new(0.5, Color32::from_white_alpha(18))
    };
    ui.painter().rect(rect, CornerRadius::same(7), fill, stroke, egui::StrokeKind::Inside);

    // Mini illustration (top 40 px): stacked bricks + direction arrow.
    let cx = rect.center().x;
    let brick_fill = if selected && enabled {
        Color32::from_rgba_unmultiplied(t.accent.r(), t.accent.g(), t.accent.b(), 150)
    } else {
        Color32::from_white_alpha(if enabled { 55 } else { 28 })
    };
    let top_y = rect.top() + 12.0;
    if take_apart {
        // Top brick lifted upward + base bricks below.
        ui.painter().rect_filled(Rect::from_center_size(pos2(cx - 8.0, top_y + 4.0), vec2(26.0, 7.0)), 1.5, brick_fill);
        ui.painter().rect_filled(Rect::from_center_size(pos2(cx - 8.0, top_y + 18.0), vec2(28.0, 7.0)), 1.5, brick_fill);
        ui.painter().rect_filled(Rect::from_center_size(pos2(cx - 8.0, top_y + 27.0), vec2(32.0, 7.0)), 1.5, brick_fill);
        // Up arrow on right.
        let ax = cx + 18.0;
        let line_c = if selected && enabled { t.accent } else { t.text3 };
        ui.painter().line_segment([pos2(ax, top_y + 27.0), pos2(ax, top_y + 4.0)], Stroke::new(1.5, line_c));
        ui.painter().line_segment([pos2(ax - 3.5, top_y + 8.0), pos2(ax, top_y + 4.0)], Stroke::new(1.5, line_c));
        ui.painter().line_segment([pos2(ax + 3.5, top_y + 8.0), pos2(ax, top_y + 4.0)], Stroke::new(1.5, line_c));
    } else {
        // Bottom base solid, middle + top descending from above.
        ui.painter().rect_filled(Rect::from_center_size(pos2(cx - 8.0, top_y + 27.0), vec2(32.0, 7.0)), 1.5, brick_fill);
        ui.painter().rect_filled(Rect::from_center_size(pos2(cx - 8.0, top_y + 18.0), vec2(28.0, 7.0)), 1.5, brick_fill);
        ui.painter().rect_filled(Rect::from_center_size(pos2(cx - 8.0, top_y + 6.0), vec2(22.0, 7.0)), 1.5, brick_fill);
        let ax = cx + 18.0;
        let line_c = if selected && enabled { t.accent } else { t.text3 };
        ui.painter().line_segment([pos2(ax, top_y + 4.0), pos2(ax, top_y + 27.0)], Stroke::new(1.5, line_c));
        ui.painter().line_segment([pos2(ax - 3.5, top_y + 23.0), pos2(ax, top_y + 27.0)], Stroke::new(1.5, line_c));
        ui.painter().line_segment([pos2(ax + 3.5, top_y + 23.0), pos2(ax, top_y + 27.0)], Stroke::new(1.5, line_c));
    }

    let title_fg = if enabled { t.text1 } else { t.text3 };
    ui.painter().text(pos2(rect.left() + 8.0, rect.top() + 54.0), Align2::LEFT_CENTER, title, FontId::proportional(12.0), title_fg);
    ui.painter().text(
        pos2(rect.left() + 8.0, rect.top() + 73.0),
        Align2::LEFT_CENTER,
        subtitle,
        FontId::proportional(10.0),
        t.text3,
    );

    enabled && resp.clicked() && !selected
}
