//! The floating view bar at the bottom of the viewport, and the selection chip.
use egui::{Align2, Area, Frame, Id, Margin, Order, Rect, RichText, Sense, Stroke, Ui, vec2};

use super::icon_button;
use crate::BrickMotionApp;
use crate::viewport::DragMode;
use crate::icons::{self, Icon};

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect) {
    let t = app.theme;
    recording_chip(ui, app, area);
    let selected = app.doc.session().selection_len();
    let mut toggle_local = false;
    let mut toggle_collision = false;
    let mut toggle_joints = false;
    let mut toggle_smart = false;
    let mut toggle_auto_plan = false;
    Area::new(Id::unique("viewbar"))
        .order(Order::Middle)
        .anchor(Align2::CENTER_BOTTOM, vec2(0.0, -12.0))
        .constrain_to(area)
        .show(ui.ctx(), |ui| {
            Frame::NONE
                .fill(crate::theme::Theme::alpha(t.bg1, 230))
                .stroke(Stroke::new(1.0, t.border))
                .corner_radius(10)
                .inner_margin(Margin::same(4))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 2.0;
                        let doc_on = app.has_document;
                        for (i, label, tool, cmd) in [
                            (Icon::Cursor, "Select Tool", crate::Tool::Select, "tool.select"),
                            (Icon::Move, "Move Tool", crate::Tool::Move, "model.move"),
                            (Icon::Rotate, "Rotate Tool", crate::Tool::Rotate, "model.rotate_tool"),
                            (Icon::Scale, "Scale Tool", crate::Tool::Scale, "model.scale_tool"),
                        ] {
                            let active = app.edit.tool == tool && app.viewport.nav_mode.is_none();
                            let tip = if !doc_on {
                                "Open a model to edit"
                            } else if active && tool != crate::Tool::Select {
                                "Click again to unselect"
                            } else {
                                label
                            };
                            if super::icon_button_tip(ui, &t, i, label, tip, doc_on, active, 28.0).clicked() {
                                app.viewport.nav_mode = None;
                                if app.edit.tool == tool && tool != crate::Tool::Select {
                                    app.edit.tool = crate::Tool::Select;
                                } else {
                                    app.requested.push(cmd);
                                }
                            }
                        }
                        // Smart Joints toggle pill (joint-based rotations in Build & Animate).
                        {
                            let on = app.edit.smart_joints;
                            let tip = if !doc_on {
                                "Open a model to use Smart Joints"
                            } else if on {
                                "Smart Joints ON: rotate articulated joints about their real axis (click to turn off)"
                            } else {
                                "Smart Joints OFF: click to enable joint-based rotation rings and limits"
                            };
                            let (r, resp) = ui.allocate_exact_size(vec2(54.0, 28.0), if doc_on { Sense::click() } else { Sense::hover() });
                            resp.widget_info(|| egui::WidgetInfo::selected(egui::Role::Button, doc_on, on, "Joints Tool"));
                            if on {
                                ui.painter().rect_filled(r, t.radius, t.accent_bg());
                            } else if doc_on && resp.hovered() {
                                ui.painter().rect_filled(r, t.radius, t.bg3);
                            }
                            let fg = if on {
                                t.accent
                            } else if !doc_on {
                                t.text3
                            } else if resp.hovered() {
                                t.text1
                            } else {
                                t.text2
                            };
                            ui.painter().text(r.center(), Align2::CENTER_CENTER, "Joints", egui::FontId::proportional(11.5), fg);
                            if resp.on_hover_text(tip).clicked() && doc_on {
                                toggle_smart = true;
                            }
                        }
                        sep(ui, &t);
                        for (i, label, mode) in [(Icon::Orbit, "Orbit", DragMode::Orbit), (Icon::Pan, "Pan", DragMode::Pan), (Icon::Search, "Zoom", DragMode::Zoom)] {
                            let active = app.viewport.nav_mode == Some(mode);
                            let tip = if active { format!("{label} — click again to unselect") } else { label.to_owned() };
                            if super::icon_button_tip(ui, &t, i, label, &tip, true, active, 28.0).clicked() {
                                app.viewport.nav_mode = if active { None } else { Some(mode) };
                            }
                        }
                        sep(ui, &t);
                        if icon_button(ui, &t, Icon::Fit, "Fit All", true, false, 28.0).clicked() {
                            app.requested.push("view.fit");
                        }
                        let can_look_at = selected > 0;
                        let look_tip = if can_look_at { "Frame Selection (⌘F)" } else { "Select a piece to frame" };
                        if super::icon_button_tip(ui, &t, Icon::LookAt, "Look At Selection", look_tip, can_look_at, false, 28.0).clicked() {
                            app.requested.push("view.frame_selection");
                        }
                        if icon_button(ui, &t, Icon::Home, "Home", true, false, 28.0).clicked() {
                            app.requested.push("view.home");
                        }
                        sep(ui, &t);
                        let scope_label = match app.edit.pick_scope {
                            crate::edit::PickScope::Submodels => "Submodels",
                            crate::edit::PickScope::Pieces => "Pieces",
                        };
                        let pieces = popover_button(ui, &t, Some(scope_label), Icon::Brick, "Click selects", true);
                        egui::Popup::from_toggle_button_response(&pieces).gap(8.0).show(|ui| {
                            use super::menu;
                            use crate::edit::PickScope;
                            menu::prepare_width(ui, 212.0);
                            menu::section(ui, &t, "Click selects");
                            if menu::item_check_note(
                                ui,
                                &t,
                                "Submodels",
                                (app.edit.pick_scope == PickScope::Pieces).then_some("⌥"),
                                app.edit.pick_scope == PickScope::Submodels,
                                true,
                            ) {
                                app.edit.pick_scope = PickScope::Submodels;
                            }
                            if menu::item_check_note(
                                ui,
                                &t,
                                "Pieces",
                                (app.edit.pick_scope == PickScope::Submodels).then_some("⌥"),
                                app.edit.pick_scope == PickScope::Pieces,
                                true,
                            ) {
                                app.edit.pick_scope = PickScope::Pieces;
                            }
                            menu::separator(ui, &t);
                            for other in ["Whole step", "Connections"] {
                                let _ = menu::item_check_note(ui, &t, other, Some("Soon"), false, false);
                            }
                        });
                        let disp = popover_button(ui, &t, None, Icon::Sliders, "Display", true);
                        egui::Popup::from_toggle_button_response(&disp).gap(8.0).show(|ui| {
                            use super::menu;
                            menu::prepare_width(ui, 232.0);
                            menu::section(ui, &t, "Viewport & editing");
                            if menu::item_toggle(ui, &t, Some(Icon::Target), "Local Axes", Some("L"), app.edit.local_axes, true) {
                                toggle_local = true;
                            }
                            if menu::item_toggle(ui, &t, Some(Icon::Magnet), "Collision Checks", Some("K"), app.edit.collision, true) {
                                toggle_collision = true;
                            }
                            if menu::item_toggle(ui, &t, Some(Icon::Rotate), "Smart Joints", Some("J"), app.edit.smart_joints, true) {
                                toggle_smart = true;
                            }
                            if menu::item_toggle(ui, &t, Some(Icon::Eye), "Joint Markers", None, app.joints.show, true) {
                                toggle_joints = true;
                            }
                            menu::separator(ui, &t);
                            if menu::item_toggle(ui, &t, Some(Icon::Plan), "Plan Automatically", None, app.prefs.auto_plan, true) {
                                toggle_auto_plan = true;
                            }
                        });
                    });
                });
        });
    if toggle_local {
        app.requested.push("view.local_axes");
    }
    if toggle_collision {
        app.requested.push("edit.collision");
    }
    if toggle_joints {
        app.requested.push("view.joints");
    }
    if toggle_smart {
        app.requested.push("edit.smart_joints");
    }
    if toggle_auto_plan {
        app.prefs.auto_plan = !app.prefs.auto_plan;
        let _ = app.prefs.save(&app.support);
        app.apply_viewport_prefs();
    }
    if let Some(p) = &app.edit.placement {
        let short = super::library::short_name(&p.part.name);
        let status = p.status_text();
        let status_color = match p.state {
            bm::placement::PlacementState::Snapped => t.accent,
            bm::placement::PlacementState::Blocked | bm::placement::PlacementState::Unavailable => {
                t.danger
            }
            _ => t.text1,
        };
        let hint = if p.is_moving() {
            "Release to drop · Alt free · R turn · Tab grip · Esc cancel"
        } else {
            "Click to place · Alt free · R turn · Tab grip · Esc cancel"
        };
        Area::new(Id::unique("placement-hud"))
            .order(Order::Middle)
            .anchor(Align2::LEFT_BOTTOM, vec2(12.0, -14.0))
            .constrain_to(area)
            .show(ui.ctx(), |ui| {
                Frame::NONE
                    .fill(t.float_fill())
                    .stroke(Stroke::new(1.0, t.border2))
                    .corner_radius(8)
                    .inner_margin(Margin::symmetric(10, 5))
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.spacing_mut().item_spacing.x = 8.0;
                            ui.label(RichText::new(short).strong().size(11.5).color(t.text1));
                            ui.label(RichText::new(status).strong().size(11.5).color(status_color));
                            ui.label(RichText::new(hint).size(11.0).color(t.text3));
                        });
                    });
            });
    } else if selected > 0 {
        Area::new(Id::unique("selection-chip"))
            .order(Order::Middle)
            .anchor(Align2::LEFT_BOTTOM, vec2(12.0, -14.0))
            .constrain_to(area)
            .show(ui.ctx(), |ui| {
                Frame::NONE
                    .fill(t.float_fill())
                    .stroke(Stroke::new(1.0, t.border))
                    .corner_radius(8)
                    .inner_margin(Margin::symmetric(10, 5))
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            let word = if selected == 1 { "piece" } else { "pieces" };
                            ui.label(RichText::new(format!("{selected} {word}")).strong().size(11.5).color(t.text1));
                            ui.label(RichText::new("selected").size(11.5).color(t.text2));
                        });
                    });
            });
    }
}

fn sep(ui: &mut Ui, t: &crate::Theme) {
    let (r, _) = ui.allocate_exact_size(vec2(7.0, 28.0), Sense::hover());
    ui.painter().vline(r.center().x, r.y_range().shrink(4.0), Stroke::new(1.0, t.border));
}

/// A text-and-chevron button that will open a popover (not yet in this milestone).
fn popover_button(ui: &mut Ui, t: &crate::Theme, label: Option<&str>, i: Icon, name: &str, enabled: bool) -> egui::Response {
    let text_w = label.map(|l| ui.painter().layout_no_wrap(l.to_owned(), egui::FontId::proportional(12.5), t.text3).size().x + 6.0).unwrap_or(0.0);
    let (r, resp) = ui.allocate_exact_size(vec2(16.0 + 6.0 + text_w + 12.0 + 16.0, 28.0), if enabled { Sense::click() } else { Sense::hover() });
    resp.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, enabled, name));
    if enabled && resp.hovered() {
        ui.painter().rect_filled(r, t.radius, t.bg3);
    }
    let tint = if enabled { t.text2 } else { t.text3 };
    let y = r.center().y;
    icons::paint(ui, i, Rect::from_center_size(egui::pos2(r.left() + 16.0, y), vec2(16.0, 16.0)), 16.0, tint);
    if let Some(l) = label {
        ui.painter().text(egui::pos2(r.left() + 30.0, y), Align2::LEFT_CENTER, l, egui::FontId::proportional(12.5), tint);
    }
    icons::paint(ui, Icon::Up, Rect::from_center_size(egui::pos2(r.right() - 12.0, y), vec2(12.0, 12.0)), 12.0, tint);
    resp.on_hover_text(name.to_owned())
}

/// While recording: "● m:ss" and a Stop button, bottom left of the view.
fn recording_chip(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect) {
    let Some(seconds) = app.recording.active.as_ref().map(|r| r.seconds) else { return };
    let t = app.theme;
    let mut stop = false;
    Area::new(Id::unique("recording-chip"))
        .order(Order::Middle)
        .anchor(Align2::LEFT_BOTTOM, vec2(12.0, -12.0))
        .constrain_to(area)
        .show(ui.ctx(), |ui| {
            Frame::NONE
                .fill(t.float_fill())
                .stroke(Stroke::new(1.0, t.border))
                .corner_radius(8)
                .inner_margin(Margin::symmetric(10, 5))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        let (dot, _) = ui.allocate_exact_size(vec2(8.0, 16.0), Sense::hover());
                        ui.painter().circle_filled(dot.center(), 4.0, t.danger);
                        let clock = crate::recording::clock(seconds);
                        ui.label(RichText::new(&clock).monospace().size(11.5).color(t.text1));
                        let r = ui.add(egui::Button::new(RichText::new("Stop").size(11.5).color(t.text1)).corner_radius(5));
                        r.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, true, "Stop recording"));
                        stop = r.on_hover_text("Stop Recording Viewport").clicked();
                    });
                });
        });
    if stop {
        app.requested.push("view.record");
    }
}
