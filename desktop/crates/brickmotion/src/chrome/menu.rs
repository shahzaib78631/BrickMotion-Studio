//! Unified, calm-dark context and popover menu components used across the desktop chrome.
//! Provides razor-aligned columns, 15-px stroke icons, rounded hover pills, right-aligned
//! shortcuts, miniature toggle switches, native nested submenus, hairline dividers, and danger red.
use egui::containers::menu::SubMenu;
use egui::{Align2, Color32, CornerRadius, CursorIcon, FontId, Pos2, Rect, Response, Sense, Stroke, Ui, WidgetInfo, pos2, vec2};

use crate::icons::{self, Icon};
use crate::theme::Theme;

const ROW_H: f32 = 26.0;
const DEFAULT_W: f32 = 216.0;
const MIN_W: f32 = 180.0;
const MAX_W: f32 = 268.0;
const PAD_X: f32 = 8.0;
const ICON_SLOT: f32 = 22.0;
const DANGER: Color32 = Color32::from_rgb(0xe5, 0x48, 0x4d);

/// Applies consistent compact menu width and tight row spacing inside a popup or context menu.
pub fn prepare(ui: &mut Ui) {
    prepare_width(ui, DEFAULT_W);
}

/// Same as [`prepare`], with an explicit compact width for menus with longer labels.
pub fn prepare_width(ui: &mut Ui, width: f32) {
    let w = width.clamp(MIN_W, MAX_W);
    ui.set_width(w);
    ui.set_max_width(w);
    ui.spacing_mut().item_spacing = vec2(0.0, 2.0);
    ui.spacing_mut().menu_spacing = 4.0;
}

fn row_width(ui: &Ui) -> f32 {
    ui.max_rect().width().clamp(MIN_W, MAX_W)
}

/// A compact header at the top of a context menu (e.g. part number + step summary).
pub fn header(ui: &mut Ui, t: &Theme, title: &str, subtitle: Option<&str>) {
    let h = if subtitle.is_some() { 36.0 } else { 22.0 };
    let (r, _) = ui.allocate_exact_size(vec2(row_width(ui), h), Sense::hover());
    if let Some(sub) = subtitle {
        ui.painter().text(pos2(r.left() + PAD_X, r.top() + 10.5), Align2::LEFT_CENTER, title, FontId::proportional(12.0), t.text1);
        ui.painter().text(pos2(r.left() + PAD_X, r.top() + 25.0), Align2::LEFT_CENTER, sub, FontId::proportional(10.5), t.text3);
    } else {
        ui.painter().text(pos2(r.left() + PAD_X, r.center().y), Align2::LEFT_CENTER, title, FontId::proportional(11.5), t.text2);
    }
}

/// A muted small section heading inside a menu.
pub fn section(ui: &mut Ui, t: &Theme, label: &str) {
    let (r, _) = ui.allocate_exact_size(vec2(row_width(ui), 19.0), Sense::hover());
    ui.painter().text(
        pos2(r.left() + PAD_X, r.center().y + 0.5),
        Align2::LEFT_CENTER,
        label,
        FontId::proportional(10.5),
        t.text3,
    );
}

/// A crisp hairline divider between menu groups.
pub fn separator(ui: &mut Ui, _t: &Theme) {
    let (r, _) = ui.allocate_exact_size(vec2(row_width(ui), 8.0), Sense::hover());
    ui.painter().hline(
        (r.left() + 4.0)..=(r.right() - 4.0),
        r.center().y,
        Stroke::new(0.75, Color32::from_white_alpha(18)),
    );
}

/// Standard menu action row with optional left stroke icon and right-aligned shortcut hint.
/// Closes the enclosing menu automatically when clicked.
pub fn item(ui: &mut Ui, t: &Theme, icon: Option<Icon>, label: &str, shortcut: Option<&str>, enabled: bool) -> bool {
    let resp = draw_row(ui, t, RowStyle {
        icon,
        reserve_left: icon.is_some(),
        label,
        shortcut,
        badge: None,
        check_left: false,
        toggle_right: None,
        destructive: false,
        has_submenu: false,
        force_hot: false,
        enabled,
    });
    if enabled && resp.clicked() {
        ui.close();
        return true;
    }
    false
}

/// Standard menu action row with tooltip text (e.g. full file path for Open Recent).
pub fn item_tip(ui: &mut Ui, t: &Theme, icon: Option<Icon>, label: &str, tip: &str, enabled: bool) -> bool {
    let resp = draw_row(ui, t, RowStyle {
        icon,
        reserve_left: icon.is_some(),
        label,
        shortcut: None,
        badge: None,
        check_left: false,
        toggle_right: None,
        destructive: false,
        has_submenu: false,
        force_hot: false,
        enabled,
    })
    .on_hover_text(tip);
    if enabled && resp.clicked() {
        ui.close();
        return true;
    }
    false
}

/// Radio / checkable menu row that ALWAYS reserves a consistent left checkmark column so
/// checked and unchecked labels align on one razor-straight vertical edge.
pub fn item_check(ui: &mut Ui, t: &Theme, label: &str, checked: bool, enabled: bool) -> bool {
    item_check_note(ui, t, label, None, checked, enabled)
}

/// Same as [`item_check`], with an optional muted right-aligned note/badge (e.g. `"Soon"`).
pub fn item_check_note(ui: &mut Ui, t: &Theme, label: &str, note: Option<&str>, checked: bool, enabled: bool) -> bool {
    let resp = draw_row(ui, t, RowStyle {
        icon: None,
        reserve_left: true,
        label,
        shortcut: note,
        badge: None,
        check_left: checked,
        toggle_right: None,
        destructive: false,
        has_submenu: false,
        force_hot: false,
        enabled,
    });
    if enabled && resp.clicked() {
        ui.close();
        return true;
    }
    false
}

/// Modern toggle menu row with left icon, clean label, optional shortcut key, and right-aligned
/// compact switch pill (stays open on click so users can toggle multiple display options cleanly).
pub fn item_toggle(
    ui: &mut Ui,
    t: &Theme,
    icon: Option<Icon>,
    label: &str,
    shortcut: Option<&str>,
    on: bool,
    enabled: bool,
) -> bool {
    let resp = draw_row(ui, t, RowStyle {
        icon,
        reserve_left: icon.is_some(),
        label,
        shortcut,
        badge: None,
        check_left: false,
        toggle_right: Some(on),
        destructive: false,
        has_submenu: false,
        force_hot: false,
        enabled,
    });
    enabled && resp.clicked()
}

/// Destructive menu action row rendered in calm danger red (`#e5484d`).
pub fn item_destructive(ui: &mut Ui, t: &Theme, icon: Option<Icon>, label: &str, enabled: bool) -> bool {
    let resp = draw_row(ui, t, RowStyle {
        icon,
        reserve_left: icon.is_some(),
        label,
        shortcut: None,
        badge: None,
        check_left: false,
        toggle_right: None,
        destructive: true,
        has_submenu: false,
        force_hot: false,
        enabled,
    });
    if enabled && resp.clicked() {
        ui.close();
        return true;
    }
    false
}

/// Styled nested submenu using egui's native `SubMenu` state so hovering or clicking opens
/// the child menu cleanly beside the row without closing the parent menu.
pub fn submenu(ui: &mut Ui, t: &Theme, icon: Option<Icon>, label: &str, add_contents: impl FnOnce(&mut Ui)) {
    let next_id = ui.next_auto_id();
    let sub_id = SubMenu::id_from_widget_id(next_id);
    let is_open = egui::Popup::is_id_open(ui.ctx(), sub_id);
    let resp = draw_row(ui, t, RowStyle {
        icon,
        reserve_left: icon.is_some(),
        label,
        shortcut: None,
        badge: None,
        check_left: false,
        toggle_right: None,
        destructive: false,
        has_submenu: true,
        force_hot: is_open,
        enabled: true,
    });
    SubMenu::new().show(ui, &resp, |ui| {
        prepare(ui);
        add_contents(ui);
    });
}

struct RowStyle<'a> {
    icon: Option<Icon>,
    reserve_left: bool,
    label: &'a str,
    shortcut: Option<&'a str>,
    #[allow(dead_code)]
    badge: Option<&'a str>,
    check_left: bool,
    toggle_right: Option<bool>,
    destructive: bool,
    has_submenu: bool,
    force_hot: bool,
    enabled: bool,
}

fn draw_row(ui: &mut Ui, t: &Theme, s: RowStyle<'_>) -> Response {
    let w = row_width(ui);
    let sense = if s.enabled { Sense::click() } else { Sense::hover() };
    let (r, resp) = ui.allocate_exact_size(vec2(w, ROW_H), sense);
    let selected = s.check_left || s.toggle_right == Some(true);
    resp.widget_info(|| {
        if selected {
            WidgetInfo::selected(egui::Role::Button, s.enabled, true, s.label)
        } else {
            WidgetInfo::labeled(egui::Role::Button, s.enabled, s.label)
        }
    });

    let hot = s.enabled && (s.force_hot || resp.hovered() || resp.has_focus());
    if hot {
        let fill = if s.destructive {
            Color32::from_rgba_unmultiplied(DANGER.r(), DANGER.g(), DANGER.b(), 34)
        } else {
            Color32::from_white_alpha(20)
        };
        ui.painter().rect_filled(r, CornerRadius::same(6), fill);
    }

    let text_color = if !s.enabled {
        t.text3
    } else if s.destructive {
        DANGER
    } else if hot || selected {
        t.text1
    } else {
        Color32::from_rgb(0xd8, 0xdb, 0xe1)
    };
    let icon_color = if !s.enabled {
        t.text3
    } else if s.destructive {
        DANGER
    } else if hot {
        t.text1
    } else {
        t.text2
    };

    let y = r.center().y;
    let mut text_x = r.left() + PAD_X;
    if s.reserve_left {
        if let Some(ic) = s.icon {
            let ir = Rect::from_center_size(pos2(r.left() + PAD_X + 7.5, y), vec2(15.0, 15.0));
            icons::paint(ui, ic, ir, 15.0, icon_color);
        } else if s.check_left {
            paint_check(ui.painter(), pos2(r.left() + PAD_X + 7.0, y), t.accent);
        }
        text_x = r.left() + PAD_X + ICON_SLOT;
    }

    let mut right_limit = r.right() - PAD_X;
    if s.has_submenu {
        let cr = Rect::from_center_size(pos2(right_limit - 5.0, y), vec2(12.0, 12.0));
        icons::paint(ui, Icon::Chevron, cr, 12.0, if hot { t.text2 } else { t.text3 });
        right_limit -= 18.0;
    } else if let Some(on) = s.toggle_right {
        let pill = Rect::from_center_size(pos2(right_limit - 13.0, y), vec2(26.0, 14.0));
        paint_toggle(ui.painter(), t, pill, on, s.enabled);
        right_limit -= 34.0;
    }

    if let Some(sc) = s.shortcut.filter(|s| !s.is_empty()) {
        let g = ui.painter().layout_no_wrap(sc.to_owned(), FontId::proportional(11.0), t.text3);
        let sw = g.size().x;
        ui.painter().galley(pos2(right_limit - sw, y - g.size().y * 0.5), g, t.text3);
        right_limit -= sw + 10.0;
    }

    let text_clip = Rect::from_min_max(pos2(text_x, r.top()), pos2(right_limit.max(text_x + 12.0), r.bottom()));
    let galley = ui.painter().layout_no_wrap(s.label.to_owned(), FontId::proportional(12.5), text_color);
    ui.painter()
        .with_clip_rect(text_clip)
        .galley(pos2(text_x, y - galley.size().y * 0.5), galley, text_color);

    if s.enabled {
        resp.on_hover_cursor(CursorIcon::PointingHand)
    } else {
        resp
    }
}

fn paint_check(painter: &egui::Painter, c: Pos2, color: Color32) {
    let pts = [
        pos2(c.x - 4.2, c.y + 0.3),
        pos2(c.x - 1.2, c.y + 3.2),
        pos2(c.x + 4.4, c.y - 3.0),
    ];
    painter.line_segment([pts[0], pts[1]], Stroke::new(1.65, color));
    painter.line_segment([pts[1], pts[2]], Stroke::new(1.65, color));
}

fn paint_toggle(painter: &egui::Painter, t: &Theme, r: Rect, on: bool, enabled: bool) {
    let track = if !enabled {
        Color32::from_white_alpha(14)
    } else if on {
        t.accent
    } else {
        Color32::from_white_alpha(30)
    };
    painter.rect_filled(r, CornerRadius::same(7), track);
    let knob_x = if on { r.right() - 7.0 } else { r.left() + 7.0 };
    let knob_col = if enabled { Color32::WHITE } else { t.text3 };
    painter.circle_filled(pos2(knob_x, r.center().y), 5.0, knob_col);
}
