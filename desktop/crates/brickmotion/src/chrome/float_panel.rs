//! Editors as floating panels over the viewport, SolidCraft style (m5-rulings.md): a header with a
//! grip to move the panel, an icon, a title and grey subtitle, ⌄ to fold it to its header and × to
//! close it. Each panel keeps its place and fold for the session.
use std::collections::HashMap;

use egui::{Align2, Area, Color32, FontId, Frame, Id, Margin, Order, Rect, Sense, Stroke, Ui, Vec2, WidgetInfo, pos2, vec2};

use super::{float_frame, icon_button};
use crate::BrickMotionApp;
use crate::icons::{self, Icon};
use crate::theme::Theme;

pub const WIDTH: f32 = 320.0;
const HEADER_H: f32 = 38.0;
const GAP: f32 = 8.0;

/// The editors that float over the viewport.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PanelKind {
    CameraKey,
    Camera,
    Keys,
    Motion,
    Joint,
}

impl PanelKind {
    pub fn title(self) -> &'static str {
        match self {
            PanelKind::CameraKey => "Camera Key",
            PanelKind::Camera => "Camera",
            PanelKind::Keys => "Keys",
            PanelKind::Motion => "Build Motion",
            PanelKind::Joint => "Joint",
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Place {
    /// Where the user dragged it, from the default corner; None until moved.
    offset: Option<Vec2>,
    folded: bool,
}

/// Where each panel sits and whether it is folded, for the session.
#[derive(Default)]
pub struct Panels {
    places: HashMap<PanelKind, Place>,
    /// The Camera panel (scene cameras, export camera, camera track) is open.
    pub camera: bool,
}

impl Panels {
    /// Opening a panel shows its contents again.
    pub fn unfold(&mut self, kind: PanelKind) {
        if let Some(p) = self.places.get_mut(&kind) {
            p.folded = false;
        }
    }

    pub fn folded(&self, kind: PanelKind) -> bool {
        self.places.get(&kind).is_some_and(|p| p.folded)
    }
}

/// What the header asked for this frame.
#[derive(Default)]
pub struct Outcome {
    pub close: bool,
}

/// Draws one floating panel. `next_top` is where an unmoved panel goes; it advances below this one
/// so open panels stack down the right edge.
/// A panel's header: icon, title (the kind's name when empty) and grey subtitle.
pub struct Head<'a> {
    pub icon: Icon,
    pub title: &'a str,
    pub subtitle: &'a str,
}

pub fn show(
    ui: &mut Ui,
    app: &mut BrickMotionApp,
    area: Rect,
    next_top: &mut f32,
    kind: PanelKind,
    head: Head<'_>,
    body: impl FnOnce(&mut Ui, &mut BrickMotionApp),
) -> Outcome {
    let t = app.theme;
    let place = app.panels.places.get(&kind).copied().unwrap_or_default();
    let corner = pos2(area.right() - GAP - WIDTH, *next_top);
    let pos = corner + place.offset.unwrap_or(Vec2::ZERO);
    let max_h = (area.bottom() - pos.y - 12.0).max(HEADER_H + 40.0);
    let mut out = Outcome::default();
    let mut fold = false;
    let mut moved = Vec2::ZERO;

    let shown = Area::new(Id::unique(("float_panel", kind)))
        .order(Order::Middle)
        .fixed_pos(pos)
        .constrain_to(area)
        .show(ui.ctx(), |ui| {
            float_frame(&t).show(ui, |ui| {
                ui.set_width(WIDTH);
                ui.set_max_height(max_h);
                ui.spacing_mut().item_spacing.y = 0.0;
                let resp = ui.interact(ui.max_rect(), Id::unique(("float_panel_body", kind)), Sense::hover());
                resp.widget_info(|| WidgetInfo::labeled(egui::Role::Group, true, format!("{} panel", kind.title())));
                header(ui, &t, kind, &head, place.folded, &mut moved, &mut fold, &mut out.close);
                if !place.folded {
                    egui::ScrollArea::vertical().auto_shrink([false, true]).show(ui, |ui| {
                        Frame::NONE.inner_margin(Margin { left: 0, right: 0, top: 2, bottom: 10 }).show(ui, |ui| {
                            ui.set_width(WIDTH);
                            body(ui, app);
                        });
                    });
                }
            });
        });

    let p = app.panels.places.entry(kind).or_default();
    if moved != Vec2::ZERO {
        p.offset = Some(p.offset.unwrap_or(Vec2::ZERO) + moved);
    }
    if fold {
        p.folded = !p.folded;
    }
    if place.offset.is_none() {
        *next_top = shown.response.rect.bottom() + GAP;
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn header(
    ui: &mut Ui,
    t: &Theme,
    kind: PanelKind,
    head: &Head<'_>,
    folded: bool,
    moved: &mut Vec2,
    fold: &mut bool,
    close: &mut bool,
) {
    let (rect, _) = ui.allocate_exact_size(vec2(WIDTH, HEADER_H), Sense::hover());
    // The grip and title drag the panel; the buttons on the right do not.
    let drag_rect = Rect::from_min_max(rect.min, pos2(rect.right() - 60.0, rect.bottom()));
    let drag = ui.interact(drag_rect, Id::unique(("float_panel_grip", kind)), Sense::drag());
    drag.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, format!("Move {}", kind.title())));
    if drag.dragged() {
        *moved += drag.drag_delta();
    }
    if drag.hovered() || drag.dragged() {
        ui.ctx().set_cursor_icon(if drag.dragged() { egui::CursorIcon::Grabbing } else { egui::CursorIcon::Grab });
    }
    let y = rect.center().y;
    icons::paint(ui, Icon::Grip, Rect::from_center_size(pos2(rect.left() + 16.0, y), Vec2::splat(14.0)), 14.0, t.text3);
    icons::paint(ui, head.icon, Rect::from_center_size(pos2(rect.left() + 36.0, y), Vec2::splat(15.0)), 15.0, t.text2);
    let name = if head.title.is_empty() { kind.title() } else { head.title };
    let title = ui.painter().text(pos2(rect.left() + 50.0, y), Align2::LEFT_CENTER, name, FontId::proportional(13.0), t.text1);
    if !head.subtitle.is_empty() {
        ui.painter().text(pos2(title.right() + 8.0, y), Align2::LEFT_CENTER, head.subtitle, FontId::proportional(11.5), t.text3);
    }
    let mut buttons = ui.new_child(egui::UiBuilder::new().max_rect(Rect::from_min_max(pos2(rect.right() - 60.0, rect.top()), rect.max)).layout(egui::Layout::right_to_left(egui::Align::Center)));
    buttons.spacing_mut().item_spacing.x = 2.0;
    buttons.add_space(6.0);
    if icon_button(&mut buttons, t, Icon::Close, &format!("Close {}", kind.title()), true, false, 24.0).clicked() {
        *close = true;
    }
    let fold_label = if folded { format!("Unfold {}", kind.title()) } else { format!("Fold {}", kind.title()) };
    if icon_button(&mut buttons, t, Icon::Down, &fold_label, true, false, 24.0).clicked() {
        *fold = true;
    }
    if !folded {
        ui.painter().hline(rect.x_range(), rect.bottom(), Stroke::new(1.0, t.border));
    }
}

/// A grey group heading inside a panel, with an optional right-hand note.
pub fn group_heading(ui: &mut Ui, t: &Theme, title: &str, note: &str) {
    let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 28.0), Sense::hover());
    let y = rect.bottom() - 8.0;
    ui.painter().text(pos2(rect.left() + 16.0, y), Align2::LEFT_CENTER, title, FontId::proportional(11.5), t.text3);
    if !note.is_empty() {
        ui.painter().text(pos2(rect.right() - 16.0, y), Align2::RIGHT_CENTER, note, FontId::proportional(11.0), t.text3);
    }
}

/// A row of text links (accent text, hand cursor). Returns the index clicked.
pub fn links(ui: &mut Ui, t: &Theme, labels: &[&str]) -> Option<usize> {
    let mut hit = None;
    link_row(ui, |ui| {
        ui.spacing_mut().item_spacing.x = 16.0;
        for (i, l) in labels.iter().enumerate() {
            if link(ui, t, l, t.accent).clicked() {
                hit = Some(i);
            }
        }
    });
    hit
}

/// A 34-px row inside an inset group, content left to right and centred.
pub fn link_row(ui: &mut Ui, content: impl FnOnce(&mut Ui)) {
    let w = ui.available_width();
    ui.allocate_ui_with_layout(vec2(w, 34.0), egui::Layout::left_to_right(egui::Align::Center), |ui| {
        ui.set_min_size(vec2(w, 34.0));
        ui.add_space(12.0);
        content(ui);
    });
}

/// One text link.
pub fn link(ui: &mut Ui, _t: &Theme, label: &str, color: Color32) -> egui::Response {
    let r = ui.add(egui::Label::new(egui::RichText::new(label).size(12.5).color(color)).sense(Sense::click()));
    r.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, label));
    r.on_hover_cursor(egui::CursorIcon::PointingHand)
}

/// A panel's footer: a grey note on the left and one action button on the right.
pub fn footer(ui: &mut Ui, t: &Theme, note: &str, action: &str, on_click: impl FnOnce()) {
    ui.add_space(10.0);
    Frame::NONE.inner_margin(Margin::symmetric(16, 0)).show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.label(egui::RichText::new(note).size(11.5).color(t.text3));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if super::widgets::secondary_button(ui, t, action, true).clicked() {
                    on_click();
                }
            });
        });
    });
}
