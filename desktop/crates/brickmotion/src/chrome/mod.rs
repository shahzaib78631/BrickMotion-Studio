//! The window around the viewport: title bar, ribbon, floating panels and the timeline.
pub mod browser;
pub mod build_settings;
pub mod camera_lane;
pub mod camera_panel;
pub mod callout;
pub mod checks_panel;
pub mod confirm;
pub mod dope_sheet;
pub mod float_panel;
pub mod joints;
pub mod keys_panel;
pub mod motion_panel;
pub mod keys_track;
pub mod library;
pub mod export_movie;
pub mod export_still;
pub mod fits_panel;
pub mod look_panel;
pub mod loose_panel;
pub mod queue_panel;
pub mod navigator;
pub mod notices;
pub mod parts;
pub mod parts_lane;
pub mod properties;
pub mod replace;
pub mod ribbon;
pub mod sound;
pub mod staging;
pub mod steps;
pub mod swatches;
pub mod timeline;
pub mod titlebar;
pub mod tree;
pub mod viewbar;
pub mod widgets;

use egui::{
    Align2, Color32, CornerRadius, FontId, Frame, Margin, Rect, Response, Sense, Shadow, Stroke, Ui, Vec2, WidgetInfo,
};

use crate::BrickMotionApp;
use crate::commands::Command;
use crate::icons::{self, Icon};
use crate::theme::{SMALL, Theme};

/// The area between the title bar and the timeline: viewport, ribbon and floating panels.
pub fn central(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;
    egui::CentralPanel::no_frame().show(ui, |ui| {
        let rect = ui.max_rect();
        ui.painter().rect_filled(rect, 0.0, t.bg1);
        let playing = app.transport.state.playing;
        let planning = app.transport.busy() || app.transport.state.waiting_to_play;
        app.viewport.auto_key = (app.keys.auto_key && app.transport.clock() == crate::transport::Clock::Keyframes).then(|| {
            crate::viewport::AutoKey {
                frame: app.transport.key_frame(&app.transport.key_scene),
                key_submodel: app.keys.target().filter(|id| id.1).map(|id| id.0),
            }
        });
        let path = crate::flight_path::handle_pointer(ui, app);
        app.viewport.block_primary = path || joints::handle_pointer(ui, app);
        app.viewport.suppress_rotate_gizmo = joints::owns_rotate_gizmo(app);
        app.viewport.suppress_auto_plan = app.joints.dragging();
        app.viewport.show(ui, &mut app.doc, &mut app.edit, &t, app.prefs.auto_plan, playing, planning);
        if let Some(piece) = app.viewport.double_clicked_piece.take() {
            if app.workspace == crate::Workspace::Animate {
                let start = app
                    .transport
                    .flights()
                    .iter()
                    .find(|f| f.piece == piece)
                    .map_or(0.0, |f| f.start);
                crate::flights::edit_flight(app, piece, start);
            } else {
                // In Build mode, double-clicking a piece inside a submodel opens that submodel.
                let sub = {
                    app.doc.session().select(&[piece], bm::SelectMode::Replace);
                    let snap = app.snapshot();
                    snap.described
                        .first()
                        .filter(|p| !p.submodel_path.is_empty())
                        .map(|p| p.submodel_path.split('/').map(str::to_owned).collect::<Vec<_>>())
                };
                if let Some(path) = sub {
                    app.focus_submodel(&path);
                }
            }
        }
        crate::flight_path::show(ui, app);
        joints::show(ui, app);
        // The ribbon floats over the top of the view; the other panels start below it.
        ribbon::show(ui, app, rect);
        submodel_breadcrumb(ui, app, rect);
        let tl_clearance = if app.workspace == crate::Workspace::Animate {
            app.timeline.height + 16.0
        } else {
            0.0
        };
        let safe = Rect::from_min_max(
            rect.min,
            egui::pos2(rect.right(), (rect.bottom() - tl_clearance).max(rect.top() + ribbon::SPACE + 120.0)),
        );
        let below = Rect::from_min_max(egui::pos2(safe.left(), safe.top() + ribbon::SPACE), safe.max);
        browser::show(ui, app, below);
        // Floating editors take the top right under the navigator; Properties steps aside while one is open,
        // except when an explicit Properties settings page (Build Settings, Staging, Snap Sound) is active.
        let mut next_top = below.top() + navigator::CLEARANCE;
        let editing = !app.properties_page.is_settings()
            && (app.camera_selection.is_some()
                || app.panels.camera
                || keys_panel::is_open(app)
                || motion_panel::is_open(app)
                || joints::is_open(app)
                || look_panel::is_open(app)
                || queue_panel::is_open(app)
                || export_movie::is_open(app)
                || export_still::is_open(app)
                || checks_panel::is_open(app)
                || loose_panel::is_open(app)
                || fits_panel::is_open(app));
        if editing {
            checks_panel::show(ui, app, below, &mut next_top);
            loose_panel::show(ui, app, below, &mut next_top);
            fits_panel::show(ui, app, below, &mut next_top);
            joints::panel(ui, app, below, &mut next_top);
            export_movie::show(ui, app, below, &mut next_top);
            export_still::show(ui, app, below, &mut next_top);
            queue_panel::show(ui, app, below, &mut next_top);
            look_panel::show(ui, app, below, &mut next_top);
            motion_panel::show(ui, app, below, &mut next_top);
            keys_panel::show(ui, app, below, &mut next_top);
            camera_panel::show(ui, app, below, &mut next_top);
        } else {
            properties::show(ui, app, below);
        }
        navigator::show(ui, app, below);
        callout::show(ui, app, safe);
        viewbar::show(ui, app, safe);
        notices::show(ui, app, safe);
        if app.workspace == crate::Workspace::Animate {
            timeline::show(ui, app, rect);
        }
    });
}

/// Floating breadcrumb chip shown at the top center when focused inside a submodel.
fn submodel_breadcrumb(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect) {
    if !app.has_document {
        return;
    }
    let path = app.doc.session().focus_path();
    if path.is_empty() {
        return;
    }
    let t = app.theme;
    let mut target: Option<Vec<String>> = None;
    egui::Area::new(egui::Id::unique("submodel-breadcrumb"))
        .order(egui::Order::Middle)
        .anchor(Align2::CENTER_TOP, egui::vec2(0.0, ribbon::SPACE + 10.0))
        .constrain_to(area)
        .show(ui.ctx(), |ui| {
            float_frame(&t)
                .corner_radius(CornerRadius::same(8))
                .inner_margin(Margin::symmetric(10, 5))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 6.0;
                        let root_btn = ui
                            .add(egui::Button::new(egui::RichText::new("Main model").size(12.0).color(t.accent)).frame(false))
                            .on_hover_cursor(egui::CursorIcon::PointingHand);
                        if root_btn.clicked() {
                            target = Some(Vec::new());
                        }
                        for (idx, seg) in path.iter().enumerate() {
                            ui.label(egui::RichText::new("›").size(12.0).color(t.text3));
                            let is_last = idx + 1 == path.len();
                            if is_last {
                                ui.label(egui::RichText::new(seg).strong().size(12.0).color(t.text1));
                            } else if ui
                                .add(egui::Button::new(egui::RichText::new(seg).size(12.0).color(t.accent)).frame(false))
                                .on_hover_cursor(egui::CursorIcon::PointingHand)
                                .clicked()
                            {
                                target = Some(path[..=idx].to_vec());
                            }
                        }
                        ui.add_space(4.0);
                        if icon_button_tip(ui, &t, Icon::Close, "Exit Submodel", "Return to Main model", true, false, 20.0).clicked() {
                            target = Some(Vec::new());
                        }
                    });
                });
        });
    if let Some(p) = target {
        app.focus_submodel(&p);
    }
}

/// A floating panel over the viewport.
pub fn float_frame(t: &Theme) -> Frame {
    Frame::NONE
        .fill(t.float_fill())
        .stroke(Stroke::new(1.0, t.border2))
        .corner_radius(CornerRadius::same(10))
        .shadow(Shadow { offset: [0, 10], blur: 30, spread: 0, color: Color32::from_black_alpha(90) })
}

/// A square icon button. Disabled buttons stay visible, dimmed, and keep their hover text.
pub fn icon_button(ui: &mut Ui, t: &Theme, i: Icon, label: &str, enabled: bool, on: bool, size: f32) -> Response {
    let tip = if enabled { label.to_owned() } else { format!("{label} — coming soon") };
    icon_button_tip(ui, t, i, label, &tip, enabled, on, size)
}

/// An icon button with its own hover text, for buttons that are disabled for a reason other
/// than not being built yet.
#[allow(clippy::too_many_arguments)]
pub fn icon_button_tip(ui: &mut Ui, t: &Theme, i: Icon, label: &str, tip: &str, enabled: bool, on: bool, size: f32) -> Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::splat(size), if enabled { Sense::click() } else { Sense::hover() });
    resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, enabled, on, label));
    let hovered = enabled && resp.hovered();
    if on {
        ui.painter().rect_filled(rect, t.radius, t.accent_bg());
    } else if hovered {
        ui.painter().rect_filled(rect, t.radius, t.bg3);
    }
    let tint = if on {
        t.accent
    } else if !enabled {
        t.text3
    } else if hovered {
        t.text1
    } else {
        t.text2
    };
    icons::paint(ui, i, rect, 16.0, tint);
    let resp = resp.on_hover_text(tip);
    if enabled { resp } else { resp.on_hover_cursor(egui::CursorIcon::Default) }
}

/// The hover card of a ribbon tool: title, shortcut and what it does.
/// The shortcut to advertise for `c`: none for a command that is not built yet, whose key does nothing.
pub fn card_keys(c: &Command) -> Option<&'static str> {
    if c.when == crate::When::Soon { None } else { c.keys }
}

pub fn hover_card(resp: Response, t: &Theme, c: &Command) -> Response {
    resp.on_hover_ui(|ui| {
        ui.set_max_width(260.0);
        ui.horizontal(|ui| {
            ui.label(egui::RichText::new(c.title).strong().color(t.text1));
            if let Some(k) = card_keys(c) {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| kbd(ui, t, k));
            }
        });
        ui.label(egui::RichText::new(c.tip).color(t.text2));
    })
}

/// A keyboard shortcut in a small outlined box.
pub fn kbd(ui: &mut Ui, t: &Theme, text: &str) -> Response {
    let galley = ui.painter().layout_no_wrap(text.to_owned(), FontId::proportional(11.0), t.text3);
    let (rect, resp) = ui.allocate_exact_size(galley.size() + Vec2::new(10.0, 2.0), Sense::hover());
    ui.painter().rect_stroke(rect, 4.0, Stroke::new(1.0, t.border2), egui::StrokeKind::Inside);
    ui.painter().galley(rect.center() - galley.size() / 2.0, galley, t.text3);
    resp
}

/// Text painted at `pos` without taking layout space.
pub fn text(ui: &Ui, pos: egui::Pos2, anchor: Align2, s: &str, size: f32, color: Color32) -> Rect {
    ui.painter().text(pos, anchor, s, FontId::proportional(size), color)
}

/// A small dimmed caption.
pub fn caption(s: &str, t: &Theme) -> egui::RichText {
    egui::RichText::new(s).size(SMALL).color(t.text3)
}

/// The panel header: draggable grip + title on the left, then actions on the right.
/// Returns the drag delta if the user dragged the header to move the panel.
pub fn panel_header(ui: &mut Ui, t: &Theme, id_salt: &str, title: &str, draw_bottom_line: bool, actions: impl FnOnce(&mut Ui)) -> Vec2 {
    let mut moved = Vec2::ZERO;
    let resp = Frame::NONE.inner_margin(Margin { left: 10, right: 8, top: 0, bottom: 0 }).show(ui, |ui| {
        ui.set_height(38.0);
        ui.horizontal_centered(|ui| {
            let grip_start = ui.cursor().min;
            icons::icon(ui, Icon::Grip, 16.0, t.text3);
            let title_resp = ui.label(egui::RichText::new(title).strong().color(t.text1));
            let drag_r = Rect::from_min_max(
                egui::pos2(grip_start.x - 4.0, ui.max_rect().top()),
                egui::pos2((title_resp.rect.right() + 12.0).max(grip_start.x + 120.0), ui.max_rect().bottom()),
            );
            let drag = ui.interact(drag_r, ui.scope_id().with(("panel-drag", id_salt)), Sense::drag());
            drag.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, format!("Move {title}")));
            if drag.dragged() {
                moved += drag.drag_delta();
            }
            if drag.hovered() || drag.dragged() {
                ui.ctx().set_cursor_icon(if drag.dragged() {
                    egui::CursorIcon::Grabbing
                } else {
                    egui::CursorIcon::Grab
                });
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.spacing_mut().item_spacing.x = 2.0;
                actions(ui);
            });
        });
    });
    if draw_bottom_line {
        let r = resp.response.rect;
        ui.painter().hline(r.x_range(), r.bottom(), Stroke::new(1.0, t.border));
    }
    moved
}

#[cfg(test)]
mod card_tests {
    use super::card_keys;

    #[test]
    fn soon_commands_show_no_keys() {
        let sub = crate::find("model.submodel").unwrap();
        assert_eq!(sub.keys, Some("⌥⌘G"));
        assert_eq!(card_keys(sub), None);
        assert_eq!(card_keys(crate::find("file.open").unwrap()), Some("⌘O"));
    }
}
