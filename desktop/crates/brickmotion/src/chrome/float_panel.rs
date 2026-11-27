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
pub const HEADER_H: f32 = 38.0;
const GAP: f32 = 8.0;

/// Unified header configuration shared across every floating panel in the app
/// (Browser, Properties, Build Settings, Build Staging, Snap Sound, Look, Checks,
/// Loose, Fits, Export, Queue, Keys, Motion, Camera, Joints).
pub struct HeaderSpec<'a> {
    pub id_salt: &'a str,
    pub icon: Icon,
    pub title: &'a str,
    pub subtitle: &'a str,
    pub folded: bool,
    /// Optional `<` back button (used by Settings sub-pages returning to Properties).
    pub back_label: Option<&'a str>,
    /// Label for the collapse/expand button (`None` hides the button).
    pub fold_label: Option<&'a str>,
    /// Label for the close/hide button (`None` hides the button).
    pub close_label: Option<&'a str>,
    /// Extra right-hand width reserved for custom extension actions (e.g. Browser Find & More).
    pub extra_actions_w: f32,
}

/// Actions triggered by the unified panel header on this frame.
#[derive(Default)]
pub struct HeaderOutcome {
    pub moved: Vec2,
    pub back: bool,
    pub toggle_fold: bool,
    pub close: bool,
}

/// Draws the single canonical floating-panel header used throughout the app.
pub fn draw_header(
    ui: &mut Ui,
    t: &Theme,
    width: f32,
    spec: &HeaderSpec<'_>,
    extra_actions: impl FnOnce(&mut Ui),
) -> HeaderOutcome {
    let mut out = HeaderOutcome::default();
    let (rect, _) = ui.allocate_exact_size(vec2(width, HEADER_H), Sense::hover());
    let y = rect.center().y;

    let mut right_w = 8.0 + spec.extra_actions_w;
    if spec.close_label.is_some() {
        right_w += 26.0;
    }
    if spec.fold_label.is_some() {
        right_w += 26.0;
    }

    let mut left_x = rect.left() + 8.0;
    // Drag grip always sits first so every panel feels consistently movable.
    icons::paint(ui, Icon::Grip, Rect::from_center_size(pos2(left_x + 7.0, y), Vec2::splat(14.0)), 14.0, t.text3);
    left_x += 18.0;

    // Optional `<` Back button (placed cleanly inside a child Ui so it doesn't interfere with drag).
    let mut drag_start_x = rect.left();
    if let Some(back_lbl) = spec.back_label {
        let back_rect = Rect::from_center_size(pos2(left_x + 12.0, y), vec2(24.0, 24.0));
        let mut back_ui = ui.new_child(egui::UiBuilder::new().max_rect(back_rect));
        if super::icon_button_tip(&mut back_ui, t, Icon::Back, back_lbl, back_lbl, true, false, 24.0).clicked() {
            out.back = true;
        }
        left_x += 28.0;
        drag_start_x = back_rect.right() + 2.0;
    }

    // Drag region covers the title/icon area (and grip when there is no back button).
    let drag_rect = Rect::from_min_max(pos2(drag_start_x, rect.top()), pos2((rect.right() - right_w).max(drag_start_x + 24.0), rect.bottom()));
    let drag = ui.interact(drag_rect, Id::unique(("panel_header_grip", spec.id_salt)), Sense::drag());
    drag.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, format!("Move {}", spec.title)));
    if drag.dragged() {
        out.moved += drag.drag_delta();
    }
    if drag.hovered() || drag.dragged() {
        ui.ctx().set_cursor_icon(if drag.dragged() { egui::CursorIcon::Grabbing } else { egui::CursorIcon::Grab });
    }
    // If a back button sits to the right of the grip, also allow dragging directly on the grip dots.
    if spec.back_label.is_some() {
        let grip_r = Rect::from_min_max(rect.min, pos2(rect.left() + 24.0, rect.bottom()));
        let gdrag = ui.interact(grip_r, Id::unique(("panel_header_grip_dots", spec.id_salt)), Sense::drag());
        if gdrag.dragged() {
            out.moved += gdrag.drag_delta();
        }
        if gdrag.hovered() || gdrag.dragged() {
            ui.ctx().set_cursor_icon(if gdrag.dragged() { egui::CursorIcon::Grabbing } else { egui::CursorIcon::Grab });
        }
    }

    // Panel icon + crisp title + optional muted subtitle.
    icons::paint(ui, spec.icon, Rect::from_center_size(pos2(left_x + 8.0, y), Vec2::splat(15.0)), 15.0, t.text2);
    left_x += 22.0;
    let text_clip = Rect::from_min_max(pos2(left_x, rect.top()), pos2((rect.right() - right_w - 4.0).max(left_x + 12.0), rect.bottom()));
    let tp = ui.painter().with_clip_rect(text_clip);
    let title_r = tp.text(pos2(left_x, y), Align2::LEFT_CENTER, spec.title, FontId::proportional(13.0), t.text1);
    if !spec.subtitle.is_empty() && title_r.right() + 10.0 < text_clip.right() {
        tp.text(pos2(title_r.right() + 8.0, y), Align2::LEFT_CENTER, spec.subtitle, FontId::proportional(11.5), t.text3);
    }

    // Right-hand controls: Close (×), Collapse/Expand (^/v), then any custom extension actions.
    let mut buttons = ui.new_child(
        egui::UiBuilder::new()
            .max_rect(Rect::from_min_max(pos2(rect.right() - right_w, rect.top()), rect.max))
            .layout(egui::Layout::right_to_left(egui::Align::Center)),
    );
    buttons.spacing_mut().item_spacing.x = 2.0;
    buttons.add_space(6.0);
    if let Some(close_lbl) = spec.close_label
        && icon_button(&mut buttons, t, Icon::Close, close_lbl, true, false, 24.0).clicked()
    {
        out.close = true;
    }
    if let Some(fold_lbl) = spec.fold_label {
        let fold_icon = if spec.folded { Icon::Down } else { Icon::Up };
        if icon_button(&mut buttons, t, fold_icon, fold_lbl, true, false, 24.0).clicked() {
            out.toggle_fold = true;
        }
    }
    extra_actions(&mut buttons);

    if !spec.folded {
        ui.painter().hline(rect.x_range(), rect.bottom(), Stroke::new(1.0, t.border));
    }
    out
}

/// The editors that float over the viewport.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PanelKind {
    CameraKey,
    Camera,
    Keys,
    Motion,
    Joint,
    Look,
    Queue,
    Movie,
    Still,
    Checks,
    Loose,
    Fits,
}

impl PanelKind {
    pub fn title(self) -> &'static str {
        match self {
            PanelKind::CameraKey => "Camera Key",
            PanelKind::Camera => "Camera",
            PanelKind::Keys => "Keys",
            PanelKind::Motion => "Build Motion",
            PanelKind::Joint => "Joint",
            PanelKind::Look => "Look",
            PanelKind::Queue => "Render Queue",
            PanelKind::Movie => "Export Video",
            PanelKind::Still => "Export Still",
            PanelKind::Checks => "Model Checks",
            PanelKind::Loose => "Seat Loose Pieces",
            PanelKind::Fits => "Compatible Parts",
        }
    }
}

/// Which ribbon command opened the Camera panel, so only one button highlights active.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CameraFocus {
    Scene,
    Export,
}

#[derive(Clone, Copy, Debug, Default)]
struct Place {
    /// Where the user dragged it, relative to the top-right anchor of the viewport area; None until moved.
    offset: Option<Vec2>,
    folded: bool,
}

/// Where each panel sits and whether it is folded, for the session.
#[derive(Default)]
pub struct Panels {
    places: HashMap<PanelKind, Place>,
    /// The Camera panel (scene cameras, export camera, camera track) is open.
    pub camera: bool,
    /// Which Camera ribbon button opened the panel.
    pub camera_focus: Option<CameraFocus>,
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
    let anchor = pos2(area.right() - GAP - WIDTH, area.top() + super::navigator::CLEARANCE);
    let pos = match place.offset {
        Some(off) => anchor + off,
        None => pos2(area.right() - GAP - WIDTH, *next_top),
    };
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
                    egui::ScrollArea::vertical().id_salt(("float_panel_scroll", kind)).auto_shrink([false, true]).show(ui, |ui| {
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
        let base = p.offset.unwrap_or_else(|| pos - anchor);
        p.offset = Some(base + moved);
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
    let name = if head.title.is_empty() { kind.title() } else { head.title };
    let close_lbl = format!("Close {}", kind.title());
    let fold_lbl = if folded { format!("Unfold {}", kind.title()) } else { format!("Fold {}", kind.title()) };
    let out = draw_header(
        ui,
        t,
        WIDTH,
        &HeaderSpec {
            id_salt: kind.title(),
            icon: head.icon,
            title: name,
            subtitle: head.subtitle,
            folded,
            back_label: None,
            fold_label: Some(&fold_lbl),
            close_label: Some(&close_lbl),
            extra_actions_w: 0.0,
        },
        |_| {},
    );
    *moved += out.moved;
    *fold = out.toggle_fold;
    *close = out.close;
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
