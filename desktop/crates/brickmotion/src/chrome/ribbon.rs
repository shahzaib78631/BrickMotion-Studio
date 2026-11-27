//! The ribbon, drawn over the viewport as two floating cards (m5-rulings.md): the Workspace
//! card, and one ribbon card with the tabs and Search commands on top and the tool groups and
//! the Build | Animate switch below.
use egui::{
    Align2, Color32, CornerRadius, FontId, Pos2, Rect, RichText, Sense, Stroke, StrokeKind, Ui, UiBuilder, Vec2,
    WidgetInfo, pos2, vec2,
};

use super::{caption, float_frame, hover_card, text};
use crate::commands::{Command, enabled, registry, tabs};
use crate::icons::{self, Icon};
use crate::{BrickMotionApp, Theme, Workspace};

/// Height of both cards.
const CARD_H: f32 = 112.0;
/// Gap above the cards, between them, and to the window's sides.
const TOP: f32 = 6.0;
const SIDE: f32 = 8.0;
const GAP: f32 = 6.0;
const WS_W: f32 = 96.0;
const TABS_H: f32 = 36.0;
const RIGHT_W: f32 = 240.0;
/// Space the ribbon takes from the top of the viewport; floating panels start below it.
pub const SPACE: f32 = TOP + CARD_H;

/// Draws the ribbon over the top of `area` (the viewport).
pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect) {
    let t = app.theme;
    let ws = Rect::from_min_size(area.min + vec2(SIDE, TOP), vec2(WS_W, CARD_H));
    let card = Rect::from_min_max(pos2(ws.right() + GAP, ws.top()), pos2(area.right() - SIDE, ws.bottom()));
    egui::Area::new(egui::Id::unique("ribbon"))
        .fixed_pos(ws.min)
        .order(egui::Order::Middle)
        .constrain(false)
        .show(ui.ctx(), |ui| {
            ui.set_min_size(vec2(card.right() - ws.left(), CARD_H));
            for r in [ws, card] {
                // Absorbs clicks and drags so they never reach the viewport underneath.
                let _ = ui.interact(r, ui.scope_id().with(("ribbon-card", r.left() as i32)), Sense::click_and_drag());
                let frame = float_frame(&t);
                ui.painter().add(frame.shadow.as_shape(r, frame.corner_radius));
                ui.painter().rect(r, frame.corner_radius, frame.fill, frame.stroke, StrokeKind::Inside);
            }
            workspace_button(ui, app, ws);
            let tabs_r = Rect::from_min_size(card.min, vec2(card.width(), TABS_H));
            ui.painter().hline(card.x_range().shrink(1.0), tabs_r.bottom() - 0.5, Stroke::new(1.0, t.border));
            let search = Rect::from_min_max(pos2(card.right() - 10.0 - RIGHT_W, tabs_r.top() + 5.0), pos2(card.right() - 10.0, tabs_r.bottom() - 5.0));
            ui.scope_builder(UiBuilder::new().max_rect(Rect::from_min_max(tabs_r.min, pos2(search.left() - 8.0, tabs_r.bottom()))), |ui| {
                tab_row(ui, app)
            });
            search_box(ui, app, search);
            let tools = Rect::from_min_max(pos2(card.left(), tabs_r.bottom()), card.max);
            let switch = Rect::from_center_size(pos2(card.right() - 10.0 - RIGHT_W / 2.0, tools.center().y), vec2(RIGHT_W, 38.0));
            ui.scope_builder(UiBuilder::new().max_rect(Rect::from_min_max(tools.min, pos2(switch.left() - 8.0, tools.bottom()))), |ui| {
                tool_groups(ui, app)
            });
            workspace_switch(ui, app, switch);
        });
}

/// The big button on the left: shows the workspace and switches to the other one.
fn workspace_button(ui: &mut Ui, app: &mut BrickMotionApp, r: Rect) {
    let t = app.theme;
    let resp = ui.interact(r, ui.scope_id().with("workspace"), Sense::click());
    resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, "Workspace"));
    if resp.hovered() {
        ui.painter().rect_filled(r.shrink(1.0), 9.0, t.bg3);
    }
    let line = Rect::from_min_size(pos2(r.left() + 10.0, r.top()), vec2(r.width() - 20.0, 3.0));
    ui.painter().rect_filled(line, CornerRadius { nw: 0, ne: 0, sw: 3, se: 3 }, t.accent);
    let c = r.center();
    let i = if app.workspace == Workspace::Build { Icon::Brick } else { Icon::Fly };
    icons::paint(ui, i, Rect::from_center_size(c - vec2(0.0, 20.0), Vec2::splat(20.0)), 20.0, t.accent);
    text(ui, c + vec2(0.0, 2.0), Align2::CENTER_CENTER, app.workspace.name(), 13.0, t.text1);
    let small = text(ui, c + vec2(-6.0, 20.0), Align2::CENTER_CENTER, "Workspace", 10.5, t.text3);
    icons::paint(ui, Icon::Down, Rect::from_center_size(pos2(small.right() + 7.0, small.center().y), Vec2::splat(11.0)), 11.0, t.text3);
    let resp = resp.on_hover_text(format!("Switch to {}", app.workspace.other().name()));
    if resp.clicked() {
        app.set_workspace(app.workspace.other());
    }
}

/// The workspace tabs: plain labels, the chosen one in full ink with an accent underline.
fn tab_row(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;
    ui.horizontal_centered(|ui| {
        ui.add_space(8.0);
        ui.spacing_mut().item_spacing.x = 4.0;
        for &tab in tabs(app.workspace) {
            let on = app.ribbon_tab == tab;
            let w = ui.painter().layout_no_wrap(tab.to_owned(), FontId::proportional(12.5), t.text1).size().x;
            let resp = ui.add(
                egui::Button::new(RichText::new(tab).color(if on { t.text1 } else { t.text2 }))
                    .fill(Color32::TRANSPARENT)
                    .stroke(Stroke::NONE)
                    .corner_radius(6)
                    .min_size(vec2(w + 20.0, 26.0)),
            );
            if on {
                let r = resp.rect;
                let line = egui::Rect::from_min_max(pos2(r.center().x - w / 2.0, r.bottom() - 1.0), pos2(r.center().x + w / 2.0, r.bottom() + 1.0));
                ui.painter().rect_filled(line, 1.0, t.accent);
            }
            let resp = resp.on_hover_cursor(egui::CursorIcon::PointingHand);
            if resp.clicked() {
                app.ribbon_tab = tab;
            }
        }
    });
}

/// The tool groups of the chosen tab, each with its caption under it.
fn tool_groups(ui: &mut Ui, app: &mut BrickMotionApp) {
    use super::float_panel::CameraFocus;
    let t = app.theme;
    ui.add_space(4.0);
    let ctx = app.ctx();
    let cmds: Vec<&Command> = registry().iter().filter(|c| c.workspace == app.workspace && c.tab == app.ribbon_tab).collect();
    if cmds.is_empty() {
        ui.add_space(20.0);
        ui.horizontal(|ui| {
            ui.add_space(16.0);
            ui.label(caption("Nothing on this tab yet", &t).size(12.0));
        });
        return;
    }
    ui.horizontal_top(|ui| {
        ui.add_space(4.0);
        ui.spacing_mut().item_spacing.x = 0.0;
        let mut groups: Vec<(&str, Vec<&Command>)> = Vec::new();
        for c in cmds {
            match groups.last_mut() {
                Some((g, list)) if *g == c.group => list.push(c),
                _ => groups.push((c.group, vec![c])),
            }
        }
        let n = groups.len();
        for (i, (group, list)) in groups.into_iter().enumerate() {
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
                let row = ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 3.0;
                    ui.add_space(6.0);
                    for c in &list {
                        let on = enabled(c, &ctx);
                        let active = (c.id == "model.move" && ctx.tool == crate::Tool::Move)
                            || (c.id == "model.rotate_tool" && ctx.tool == crate::Tool::Rotate)
                            || (c.id == "model.look" && app.look.open)
                            || (c.id == "view.orthographic" && ctx.orthographic)
                            || (c.id == "view.look" && app.look.open)
                            || (c.id == "model.build_settings" && app.properties_page == super::properties::Page::BuildSettings)
                            || (c.id == "video.staging" && app.properties_page == super::properties::Page::Staging)
                            || (c.id == "video.snap_sound" && app.properties_page == super::properties::Page::SnapSound)
                            || (c.id == "video.follow" && app.director)
                            || (c.id == "video.auto_direct" && app.director_popup)
                            || (c.id == "video.scene_cameras" && app.panels.camera && app.panels.camera_focus != Some(CameraFocus::Export))
                            || (c.id == "video.export_camera" && app.panels.camera && app.panels.camera_focus == Some(CameraFocus::Export))
                            || (c.id == "motion.build" && app.motion.target.is_some())
                            || (c.id == "view.joints" && app.joints.show)
                            || (c.id == "edit.smart_joints" && app.edit.smart_joints)
                            || (c.id == "inspect.model_checks" && app.checks.open)
                            || (c.id == "model.seat_loose" && app.loose.open)
                            || (c.id == "model.what_fits" && app.fits.open)
                            || (c.id == "video.group" && app.keys.group_rows);
                        let resp = tool(ui, &t, c, on, active);
                        let resp = hover_card(resp, &t, c);
                        if resp.clicked() && on {
                            app.requested.push(c.id);
                        }
                        if c.id == "video.auto_direct" {
                            director_popup(app, &resp);
                        }
                    }
                    ui.add_space(6.0);
                });
                let w = row.response.rect.width();
                ui.allocate_ui_with_layout(vec2(w, 20.0), egui::Layout::top_down(egui::Align::Center), |ui| {
                    ui.add_space(4.0);
                    ui.label(caption(group, &t));
                });
            });
            if i + 1 < n {
                let (r, _) = ui.allocate_exact_size(vec2(1.0, 64.0), Sense::hover());
                ui.painter().vline(r.center().x, r.y_range().shrink(4.0), Stroke::new(1.0, t.border));
            }
        }
    });
}

/// One ribbon tool: a 20-px icon over its name, with clean padding inside its highlight pill.
fn tool(ui: &mut Ui, t: &Theme, c: &Command, on: bool, active: bool) -> egui::Response {
    let color = if active { t.accent } else if on { t.text1 } else { t.text3 };
    let galley = ui.painter().layout_no_wrap(c.title.to_owned(), FontId::proportional(11.5), color);
    let w = (galley.size().x + 14.0).max(58.0);
    let (rect, resp) = ui.allocate_exact_size(vec2(w, 46.0), Sense::click());
    resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, on, active, c.title));
    if active {
        ui.painter().rect(rect, t.radius, t.accent_bg(), Stroke::new(1.0, t.accent.gamma_multiply(0.55)), StrokeKind::Inside);
    } else if on && resp.hovered() {
        ui.painter().rect_filled(rect, t.radius, t.bg3);
    }
    let icon_tint = if active {
        t.accent
    } else if on {
        t.text1
    } else {
        t.text3
    };
    let ir = Rect::from_center_size(pos2(rect.center().x, rect.top() + 15.0), Vec2::splat(20.0));
    icons::paint(ui, c.icon, ir, 20.0, icon_tint);
    let tp = Pos2::new(rect.center().x - galley.size().x / 2.0, ir.bottom() + 4.0);
    ui.painter().galley(tp, galley, color);
    if on { resp.on_hover_cursor(egui::CursorIcon::PointingHand) } else { resp }
}

/// Search commands: opens the palette.
fn search_box(ui: &mut Ui, app: &mut BrickMotionApp, sr: Rect) {
    let t = app.theme;
    let resp = ui.interact(sr, ui.scope_id().with("search"), Sense::click());
    resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, "Search commands"));
    let p = ui.painter();
    p.rect(sr, t.radius, t.bg1, Stroke::new(1.0, if resp.hovered() { t.border2 } else { t.border }), StrokeKind::Inside);
    icons::paint(ui, Icon::Search, Rect::from_center_size(pos2(sr.left() + 18.0, sr.center().y), Vec2::splat(16.0)), 16.0, t.text3);
    text(ui, pos2(sr.left() + 34.0, sr.center().y), Align2::LEFT_CENTER, "Search commands", 12.5, t.text3);
    let k = text(ui, pos2(sr.right() - 10.0, sr.center().y), Align2::RIGHT_CENTER, "⌘K", 11.0, t.text3);
    ui.painter().rect_stroke(k.expand2(vec2(4.0, 1.0)), 4.0, Stroke::new(1.0, t.border2), StrokeKind::Inside);
    if resp.on_hover_text("Find any command by name").clicked() {
        app.requested.push("view.palette");
    }
}

/// The Build | Animate switch.
fn workspace_switch(ui: &mut Ui, app: &mut BrickMotionApp, wr: Rect) {
    let t = app.theme;
    ui.painter().rect(wr, 8.0, t.bg1, Stroke::new(1.0, t.border), StrokeKind::Inside);
    let half = (wr.width() - 9.0) / 2.0;
    for (k, w) in [Workspace::Build, Workspace::Animate].into_iter().enumerate() {
        let seg = Rect::from_min_size(pos2(wr.left() + 3.0 + k as f32 * (half + 3.0), wr.top() + 4.0), vec2(half, 30.0));
        let on = app.workspace == w;
        let resp = ui.interact(seg, ui.scope_id().with(("ws-switch", k)), Sense::click());
        resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, on, w.name()));
        if on {
            ui.painter().rect(seg, CornerRadius::same(6), t.bg3, Stroke::new(1.0, t.border2), StrokeKind::Inside);
        } else if resp.hovered() {
            ui.painter().rect_filled(seg, 6.0, t.bg2);
        }
        let color = if on || resp.hovered() { t.text1 } else { t.text2 };
        let label = ui.painter().layout_no_wrap(w.name().to_owned(), FontId::proportional(12.5), color);
        let total = 16.0 + 7.0 + label.size().x;
        let x0 = seg.center().x - total / 2.0;
        let i = if w == Workspace::Build { Icon::Brick } else { Icon::Fly };
        icons::paint(ui, i, Rect::from_center_size(pos2(x0 + 8.0, seg.center().y), Vec2::splat(16.0)), 16.0, if on { t.accent } else { t.text2 });
        ui.painter().galley(pos2(x0 + 23.0, seg.center().y - label.size().y / 2.0), label, color);
        if resp.clicked() {
            app.set_workspace(w);
        }
    }
}

/// Auto-Direct's styles, under the ribbon button (Swift's toolbar menu).
fn director_popup(app: &mut BrickMotionApp, resp: &egui::Response) {
    let clock = super::camera_lane::camera_clock(app.transport.clock());
    let mut open = app.director_popup;
    let enabled = super::camera_lane::can_auto_direct(app, clock);
    egui::Popup::from_response(resp)
        .open_bool(&mut open)
        .close_behavior(egui::PopupCloseBehavior::CloseOnClickOutside)
        .gap(4.0)
        .show(|ui| {
            if enabled {
                super::camera_lane::director_menu(ui, app, clock);
            } else {
                ui.label(caption(super::camera_lane::auto_direct_reason(app, clock), &app.theme));
            }
        });
    app.director_popup = open && app.director_popup;
}
