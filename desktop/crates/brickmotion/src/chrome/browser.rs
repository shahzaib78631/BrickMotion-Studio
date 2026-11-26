//! The floating Browser: Models / Steps / Parts / Library, a filter, and the model tree.
//! Supports dragging by the header grip, collapsing, header actions (Find, More), and resizing.
use egui::{Area, CursorIcon, Frame, Id, Margin, Order, Rect, RichText, Sense, Stroke, Ui, Vec2, pos2, vec2};

use super::float_panel::{HeaderSpec, draw_header};
use super::{caption, float_frame, icon_button_tip, menu};
use crate::BrickMotionApp;
use crate::icons::{self, Icon};

const DEFAULT_WIDTH: f32 = 300.0;
const MIN_WIDTH: f32 = 240.0;
const MAX_WIDTH: f32 = 560.0;
const MIN_HEIGHT: f32 = 200.0;
const CHROME_H: f32 = 114.0;
const TABS: [&str; 4] = ["Models", "Steps", "Parts", "Library"];

/// Session layout state for the floating Browser panel.
#[derive(Clone, Debug)]
pub struct BrowserState {
    pub offset: Vec2,
    pub width: f32,
    /// User-resized total height of the Browser panel, or `None` for automatic sizing.
    pub height: Option<f32>,
    pub collapsed: bool,
    /// Whether the inline filter bar is visible (toggled by the header magnifying glass).
    pub show_filter: bool,
}

impl Default for BrowserState {
    fn default() -> Self {
        Self {
            offset: Vec2::ZERO,
            width: DEFAULT_WIDTH,
            height: None,
            collapsed: false,
            show_filter: true,
        }
    }
}

impl BrowserState {
    pub fn reset_layout(&mut self) {
        self.offset = Vec2::ZERO;
        self.width = DEFAULT_WIDTH;
        self.height = None;
        self.collapsed = false;
        self.show_filter = true;
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect) {
    let t = app.theme;
    let title = app.title();
    let count = app.piece_count();

    let max_w = (area.width() - 360.0).clamp(MIN_WIDTH, MAX_WIDTH);
    let width = app.browser.width.clamp(MIN_WIDTH, max_w);
    let max_panel_h = (area.height() - 20.0).max(MIN_HEIGHT);
    let auto_body_h = (max_panel_h - CHROME_H).clamp(240.0, 520.0);
    let pinned_h = app.browser.height.is_some();
    let body_h = match app.browser.height {
        Some(h) => (h.clamp(MIN_HEIGHT, max_panel_h) - CHROME_H).max(96.0),
        None => auto_body_h,
    };

    let anchor = area.min + vec2(10.0, 10.0);
    let pos = pos2(
        (anchor.x + app.browser.offset.x).clamp(area.left() + 4.0, (area.right() - width - 4.0).max(area.left() + 4.0)),
        (anchor.y + app.browser.offset.y).clamp(area.top() + 4.0, (area.bottom() - 46.0).max(area.top() + 4.0)),
    );

    let mut moved = Vec2::ZERO;
    let mut toggle_collapse = false;
    let mut toggle_find = false;
    let mut expand_all = false;
    let mut collapse_all = false;
    let mut clear_filter = false;
    let mut reset_layout = false;
    let mut resize_dx = 0.0f32;
    let mut resize_dy = 0.0f32;

    let shown = Area::new(Id::unique("browser"))
        .order(Order::Middle)
        .fixed_pos(pos)
        .constrain_to(area)
        .show(ui.ctx(), |ui| {
            let collapsed = app.browser.collapsed;
            let show_filter = app.browser.show_filter;
            let frame_resp = float_frame(&t).show(ui, |ui| {
                ui.set_width(width);
                ui.spacing_mut().item_spacing.y = 0.0;
                let fold_label = if collapsed { "Expand Browser" } else { "Collapse Browser" };
                let head = draw_header(
                    ui,
                    &t,
                    width,
                    &HeaderSpec {
                        id_salt: "browser",
                        icon: Icon::Brick,
                        title: "Browser",
                        subtitle: "",
                        folded: collapsed,
                        back_label: None,
                        fold_label: Some(fold_label),
                        close_label: None,
                        extra_actions_w: 54.0,
                    },
                    |ui| {
                        let more_btn = icon_button_tip(ui, &t, Icon::More, "Browser Options", "Browser options", true, false, 24.0);
                        egui::Popup::from_toggle_button_response(&more_btn).gap(6.0).show(|ui| {
                            menu::prepare(ui);
                            match app.browser_tab {
                                0 => {
                                    if menu::item(ui, &t, Some(Icon::Down), "Expand All", None, true) {
                                        expand_all = true;
                                    }
                                    if menu::item(ui, &t, Some(Icon::Up), "Collapse All", None, true) {
                                        collapse_all = true;
                                    }
                                    menu::separator(ui, &t);
                                }
                                1 => {
                                    if menu::item(ui, &t, Some(Icon::Down), "Expand All Steps", None, true) {
                                        expand_all = true;
                                    }
                                    if menu::item(ui, &t, Some(Icon::Up), "Collapse All Steps", None, true) {
                                        collapse_all = true;
                                    }
                                    menu::separator(ui, &t);
                                }
                                _ => {}
                            }
                            if menu::item(ui, &t, Some(Icon::Close), "Clear Filter", None, !app.filter.is_empty()) {
                                clear_filter = true;
                            }
                            menu::separator(ui, &t);
                            if menu::item(ui, &t, Some(Icon::Home), "Reset Position & Size", None, true) {
                                reset_layout = true;
                            }
                        });
                        let find_on = show_filter && !collapsed;
                        let find_tip = if find_on { "Hide filter bar" } else { "Show and focus filter bar" };
                        if icon_button_tip(ui, &t, Icon::Search, "Find in Browser", find_tip, true, find_on, 24.0).clicked() {
                            toggle_find = true;
                        }
                    },
                );
                moved = head.moved;
                toggle_collapse = head.toggle_fold;

                if collapsed {
                    return;
                }

                Frame::NONE.inner_margin(Margin { left: 8, right: 8, top: 8, bottom: 2 }).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 2.0;
                        for (k, tab) in TABS.iter().enumerate() {
                            let on = app.browser_tab == k;
                            let b = egui::Button::new(RichText::new(*tab).color(if on { t.text1 } else { t.text3 }))
                                .fill(if on { t.bg3 } else { egui::Color32::TRANSPARENT })
                                .min_size(vec2(0.0, 24.0));
                            let resp = ui.add(b);
                            resp.widget_info(|| egui::WidgetInfo::selected(egui::Role::Tab, true, on, *tab));
                            if resp.clicked() {
                                app.browser_tab = k;
                            }
                        }
                    });
                });
                if show_filter {
                    let filter_id = ui.make_persistent_id("browser-filter-input");
                    let filter_focused = ui.memory(|m| m.has_focus(filter_id));
                    Frame::NONE.inner_margin(Margin { left: 8, right: 8, top: 6, bottom: 2 }).show(ui, |ui| {
                        let stroke = if filter_focused {
                            Stroke::new(1.5, t.accent)
                        } else {
                            Stroke::new(1.0, t.border)
                        };
                        Frame::NONE
                            .fill(t.bg1)
                            .stroke(stroke)
                            .corner_radius(6)
                            .inner_margin(Margin { left: 9, right: 6, top: 0, bottom: 0 })
                            .show(ui, |ui| {
                                ui.set_height(26.0);
                                ui.horizontal_centered(|ui| {
                                    icons::icon(ui, Icon::Search, 16.0, if filter_focused { t.accent } else { t.text3 });
                                    let had_filter = !app.filter.is_empty();
                                    let field = ui.add(
                                        egui::TextEdit::singleline(&mut app.filter)
                                            .id(filter_id)
                                            .hint_text(RichText::new("Filter models and parts").color(t.text3))
                                            .frame(egui::Frame::NONE)
                                            .margin(Margin::ZERO)
                                            .align(egui::Align2::LEFT_CENTER)
                                            .desired_width((ui.available_width() - if had_filter { 22.0 } else { 4.0 }).max(40.0)),
                                    );
                                    field.widget_info(|| egui::WidgetInfo::labeled(egui::Role::TextInput, true, "Filter models and parts"));
                                    if app.focus_filter {
                                        field.request_focus();
                                        app.focus_filter = false;
                                    }
                                    if !app.filter.is_empty()
                                        && icon_button_tip(ui, &t, Icon::Close, "Clear Filter", "Clear filter", true, false, 18.0).clicked()
                                    {
                                        clear_filter = true;
                                    }
                                });
                            });
                    });
                }
                Frame::NONE.inner_margin(Margin::same(6)).show(ui, |ui| {
                    if let Some(p) = app.opening() {
                        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                        ui.horizontal(|ui| {
                            ui.set_height(28.0);
                            ui.add_space(8.0);
                            ui.add(egui::Spinner::new().size(14.0).color(t.text2));
                            ui.label(RichText::new(format!("Opening {name}…")).color(t.text2));
                        });
                    } else if app.browser_tab == 0 && app.has_document {
                        super::tree::show(ui, app, body_h, pinned_h);
                    } else if app.browser_tab == 0 {
                        root_row(ui, app, &title, count);
                    } else if app.browser_tab == 1 && app.has_document {
                        super::steps::show(ui, app, body_h, pinned_h);
                    } else if app.browser_tab == 2 && app.has_document {
                        super::parts::show(ui, app, body_h, pinned_h);
                    } else if app.browser_tab == 3 {
                        super::library::show(ui, app, body_h, pinned_h);
                    } else {
                        ui.add_space(6.0);
                        ui.horizontal(|ui| {
                            ui.add_space(8.0);
                            ui.label(caption("Nothing here yet", &t).size(12.0));
                        });
                        ui.add_space(6.0);
                    }
                });
            });

            if !collapsed {
                let r = frame_resp.response.rect;
                // Right-edge width resize handle.
                let right_r = Rect::from_min_max(pos2(r.right() - 5.0, r.top() + 38.0), pos2(r.right() + 3.0, r.bottom() - 12.0));
                let right_resp = ui
                    .interact(right_r, Id::unique("browser-resize-w"), Sense::drag())
                    .on_hover_cursor(CursorIcon::ResizeHorizontal);
                if right_resp.dragged() {
                    resize_dx += right_resp.drag_delta().x;
                }
                // Bottom-edge height resize handle.
                let bot_r = Rect::from_min_max(pos2(r.left() + 10.0, r.bottom() - 5.0), pos2(r.right() - 12.0, r.bottom() + 3.0));
                let bot_resp = ui
                    .interact(bot_r, Id::unique("browser-resize-h"), Sense::drag())
                    .on_hover_cursor(CursorIcon::ResizeVertical);
                if bot_resp.dragged() {
                    resize_dy += bot_resp.drag_delta().y;
                }
                // Bottom-right corner resize handle with subtle diagonal grip ticks.
                let corner_r = Rect::from_min_max(pos2(r.right() - 14.0, r.bottom() - 14.0), pos2(r.right() + 2.0, r.bottom() + 2.0));
                let corner_resp = ui
                    .interact(corner_r, Id::unique("browser-resize-se"), Sense::drag())
                    .on_hover_cursor(CursorIcon::ResizeNwSe);
                if corner_resp.dragged() {
                    resize_dx += corner_resp.drag_delta().x;
                    resize_dy += corner_resp.drag_delta().y;
                }
                let grip_color = if corner_resp.hovered() || corner_resp.dragged() { t.text2 } else { t.border2 };
                let p = ui.painter();
                p.line_segment([pos2(r.right() - 10.0, r.bottom() - 4.0), pos2(r.right() - 4.0, r.bottom() - 10.0)], Stroke::new(1.0, grip_color));
                p.line_segment([pos2(r.right() - 6.5, r.bottom() - 4.0), pos2(r.right() - 4.0, r.bottom() - 6.5)], Stroke::new(1.0, grip_color));
            }
        });

    if moved != Vec2::ZERO {
        let next = pos + moved - anchor;
        app.browser.offset = vec2(
            next.x.clamp(area.left() + 4.0 - anchor.x, (area.right() - width - 4.0 - anchor.x).max(0.0)),
            next.y.clamp(area.top() + 4.0 - anchor.y, (area.bottom() - 46.0 - anchor.y).max(0.0)),
        );
    }
    if resize_dx != 0.0 {
        app.browser.width = (width + resize_dx).clamp(MIN_WIDTH, max_w);
    }
    if resize_dy != 0.0 {
        let current_h = app.browser.height.unwrap_or(shown.response.rect.height());
        app.browser.height = Some((current_h + resize_dy).clamp(MIN_HEIGHT, max_panel_h));
    }
    if toggle_collapse {
        app.browser.collapsed = !app.browser.collapsed;
    }
    if toggle_find {
        if app.browser.collapsed {
            app.browser.collapsed = false;
            app.browser.show_filter = true;
            app.focus_filter = true;
        } else if app.browser.show_filter {
            app.browser.show_filter = false;
            app.filter.clear();
        } else {
            app.browser.show_filter = true;
            app.focus_filter = true;
        }
    }
    if clear_filter {
        app.filter.clear();
    }
    if expand_all {
        match app.browser_tab {
            0 => app.tree.open_all(),
            1 => app.steps.open_all(),
            _ => {}
        }
    }
    if collapse_all {
        match app.browser_tab {
            0 => app.tree.collapse_all(),
            1 => app.steps.collapse_all(),
            _ => {}
        }
    }
    if reset_layout {
        app.browser.reset_layout();
    }
}

/// The document itself, at the top of the model tree.
fn root_row(ui: &mut Ui, app: &BrickMotionApp, title: &str, count: usize) {
    let t = app.theme;
    let (r, _) = ui.allocate_exact_size(vec2(ui.available_width(), 28.0), egui::Sense::hover());
    let y = r.center().y;
    icons::paint(ui, Icon::Down, Rect::from_center_size(pos2(r.left() + 10.0, y), vec2(12.0, 12.0)), 12.0, t.text3);
    icons::paint(ui, Icon::Brick, Rect::from_center_size(pos2(r.left() + 28.0, y), vec2(16.0, 16.0)), 16.0, t.playhead);
    ui.painter().text(pos2(r.left() + 42.0, y), egui::Align2::LEFT_CENTER, title, egui::FontId::proportional(12.5), t.text1);
    ui.painter().text(pos2(r.right() - 8.0, y), egui::Align2::RIGHT_CENTER, count.to_string(), egui::FontId::proportional(11.5), t.text3);
    let label = format!("{title}, {count} pieces");
    ui.ctx().accesskit_node_builder(ui.scope_id().with("root-row"), |b| {
        b.set_role(egui::accesskit::Role::TreeItem);
        b.set_label(label);
    });
}
