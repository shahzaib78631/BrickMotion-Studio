//! macOS inset-form widgets shared by the Properties settings pages.
//! Every slider commits ONCE on release, Return, or focus loss, and Esc reverts cleanly.
use egui::{
    Align2, CornerRadius, FontId, Frame, Key, Margin, Modifiers, Rect, Response, RichText, Sense, Stroke,
    Ui, WidgetInfo, pos2, vec2,
};

use crate::icons::{self, Icon};
use crate::theme::Theme;

/// Result of one frame of a commit-on-release slider.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SliderEvent {
    None,
    /// Value changed while dragging; live preview may update, do NOT push an undo step yet.
    Changing,
    /// Gesture finished (mouse release, Return, or focus loss); commit once.
    Committed(f64),
}

impl SliderEvent {
    pub fn committed(self) -> Option<f64> {
        match self {
            SliderEvent::Committed(v) => Some(v),
            _ => None,
        }
    }
}

/// 11 pt semibold section header above an inset group, with an optional right-side label or badge.
pub fn section_header(ui: &mut Ui, t: &Theme, title: &str, right: Option<&str>) {
    Frame::NONE
        .inner_margin(Margin { left: 18, right: 18, top: 14, bottom: 6 })
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(RichText::new(title).size(11.0).strong().color(t.text3));
                if let Some(r) = right {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(RichText::new(r).size(11.0).color(t.text3));
                    });
                }
            });
        });
}

/// A macOS inset form group: 12 px outer margin, radius 9, white 4.5% fill, 0.5 px white 6% edge.
pub fn inset_group(ui: &mut Ui, content: impl FnOnce(&mut Ui)) {
    let t = crate::theme::of(ui.ctx());
    Frame::NONE
        .outer_margin(Margin::symmetric(12, 0))
        .fill(t.ink(11))
        .stroke(Stroke::new(0.5, t.ink(15)))
        .corner_radius(CornerRadius::same(9))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.spacing_mut().item_spacing.y = 0.0;
            content(ui);
        });
}

/// An inset group that lines up with the text around it (no outer margin), for sheets and Home.
pub fn flush_group(ui: &mut Ui, content: impl FnOnce(&mut Ui)) {
    let t = crate::theme::of(ui.ctx());
    Frame::NONE
        .fill(t.ink(11))
        .stroke(Stroke::new(0.5, t.ink(15)))
        .corner_radius(CornerRadius::same(9))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.spacing_mut().item_spacing.y = 0.0;
            content(ui);
        });
}

/// 0.5-px white 7% hairline between rows in an inset group, inset 12 px from the left edge.
pub fn hairline(ui: &mut Ui) {
    let t = crate::theme::of(ui.ctx());
    let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 1.0), Sense::hover());
    ui.painter().hline(
        (rect.left() + 12.0)..=rect.right(),
        rect.center().y,
        Stroke::new(0.5, t.ink(18)),
    );
}

/// 11 pt muted footnote below an inset group.
pub fn footnote(ui: &mut Ui, t: &Theme, text: &str) {
    Frame::NONE
        .inner_margin(Margin { left: 18, right: 18, top: 6, bottom: 2 })
        .show(ui, |ui| {
            ui.label(RichText::new(text).size(11.0).color(t.text3));
        });
}

/// Folded disclosure section header + optional inset group body.
pub fn disclosure(
    ui: &mut Ui,
    t: &Theme,
    id: impl std::hash::Hash + std::fmt::Debug,
    title: &str,
    subtitle: &str,
    default_open: bool,
    body: impl FnOnce(&mut Ui),
) {
    let state_id = ui.make_persistent_id(id);
    let mut open = ui.data_mut(|d| *d.get_temp_mut_or(state_id, default_open));
    Frame::NONE
        .inner_margin(Margin { left: 18, right: 18, top: 14, bottom: 6 })
        .show(ui, |ui| {
            let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), 20.0), Sense::click());
            resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, open, title));
            let y = rect.center().y;
            icons::paint(
                ui,
                if open { Icon::Down } else { Icon::Chevron },
                Rect::from_center_size(pos2(rect.left() + 6.0, y), vec2(11.0, 11.0)),
                11.0,
                t.text3,
            );
            let title_g = ui.painter().layout_no_wrap(title.to_owned(), FontId::proportional(11.5), t.text2);
            ui.painter().galley(pos2(rect.left() + 16.0, y - title_g.size().y / 2.0), title_g, t.text2);
            if !subtitle.is_empty() && !open {
                ui.painter().text(
                    pos2(rect.right(), y),
                    Align2::RIGHT_CENTER,
                    subtitle,
                    FontId::proportional(10.5),
                    t.text3,
                );
            }
            if resp.clicked() {
                open = !open;
                ui.data_mut(|d| d.insert_temp(state_id, open));
            }
        });
    if open {
        body(ui);
    }
}

/// Segmented control: height 24, track white 7%, chosen segment white 17%.
/// Returns true if `selected` changed.
pub fn segmented(
    ui: &mut Ui,
    t: &Theme,
    id: impl std::hash::Hash + std::fmt::Debug,
    options: &[&str],
    selected: &mut usize,
    enabled: bool,
) -> bool {
    if options.is_empty() {
        return false;
    }
    let mut changed = false;
    let total_w = ui.available_width();
    let (rect, _) = ui.allocate_exact_size(vec2(total_w, 24.0), Sense::hover());
    let bg = if t.dark {
        if enabled { t.ink(18) } else { t.ink(10) }
    } else if enabled {
        t.bg0
    } else {
        t.ink(10)
    };
    ui.painter().rect_filled(rect, 7.0, bg);
    if !t.dark {
        ui.painter().rect_stroke(rect, 7.0, Stroke::new(0.5, t.border), egui::StrokeKind::Inside);
    }
    let inner = rect.shrink(2.0);
    let seg_w = inner.width() / options.len() as f32;
    let base_id = ui.make_persistent_id(id);
    for (i, &label) in options.iter().enumerate() {
        let seg = Rect::from_min_size(pos2(inner.left() + i as f32 * seg_w, inner.top()), vec2(seg_w, inner.height()));
        let resp = ui.interact(seg, base_id.with(i), if enabled { Sense::click() } else { Sense::hover() });
        let is_on = *selected == i;
        resp.widget_info(|| WidgetInfo::selected(egui::Role::RadioButton, enabled, is_on, label));
        if is_on {
            let (fill, stroke) = if t.dark {
                (if enabled { t.ink(44) } else { t.ink(22) }, Stroke::new(0.5, t.ink(20)))
            } else {
                (if enabled { t.bg2 } else { t.bg1 }, Stroke::new(0.5, t.border2))
            };
            ui.painter().rect_filled(seg, 5.5, fill);
            ui.painter().rect_stroke(seg, 5.5, stroke, egui::StrokeKind::Inside);
        } else if enabled && resp.hovered() {
            ui.painter().rect_filled(seg, 5.5, t.ink(12));
        }
        let fg = if !enabled {
            t.text3
        } else if is_on {
            t.text1
        } else {
            t.text2
        };
        ui.painter().text(seg.center(), Align2::CENTER_CENTER, label, FontId::proportional(11.5), fg);
        let resp = if enabled { resp.on_hover_cursor(egui::CursorIcon::PointingHand) } else { resp };
        if enabled && resp.clicked() && !is_on {
            *selected = i;
            changed = true;
        }
    }
    changed
}

/// Pop-up row inside an inset group: min height 36, label left, value + ⌃⌄ glyph right.
/// Returns true if `selected` changed.
#[allow(clippy::too_many_arguments)]
pub fn popup_row(
    ui: &mut Ui,
    t: &Theme,
    id: impl std::hash::Hash + std::fmt::Debug,
    label: &str,
    current_text: &str,
    options: &[&str],
    selected: &mut usize,
    enabled: bool,
) -> bool {
    let mut changed = false;
    let (rect, resp) = ui.allocate_exact_size(
        vec2(ui.available_width(), 36.0),
        if enabled { Sense::click() } else { Sense::hover() },
    );
    resp.widget_info(|| WidgetInfo::labeled(egui::Role::ComboBox, enabled, label));
    if enabled && resp.hovered() {
        ui.painter().rect_filled(rect, 0.0, t.ink(8));
    }
    let y = rect.center().y;
    let label_fg = if enabled { t.text1 } else { t.text3 };
    let val_fg = if enabled { t.text2 } else { t.text3 };
    ui.painter().text(pos2(rect.left() + 12.0, y), Align2::LEFT_CENTER, label, FontId::proportional(12.5), label_fg);
    let chev_rect = Rect::from_center_size(pos2(rect.right() - 16.0, y), vec2(11.0, 11.0));
    icons::paint(ui, Icon::ChevUpDown, chev_rect, 11.0, val_fg);
    ui.painter().text(
        pos2(chev_rect.left() - 6.0, y),
        Align2::RIGHT_CENTER,
        current_text,
        FontId::proportional(12.0),
        val_fg,
    );

    if enabled {
        let popup_id = ui.make_persistent_id(id);
        egui::Popup::from_toggle_button_response(&resp)
            .id(popup_id)
            .gap(4.0)
            .show(|ui| {
                // The app's own menu rows: full width, a checkmark on the current one.
                super::menu::prepare(ui);
                for (i, &opt) in options.iter().enumerate() {
                    if super::menu::item_check(ui, t, opt, *selected == i, true) && *selected != i {
                        *selected = i;
                        changed = true;
                    }
                }
            });
    }
    changed
}

/// 28×16 macOS pill switch. Returns true when toggled.
pub fn pill_switch(ui: &mut Ui, t: &Theme, label: &str, on: &mut bool, enabled: bool) -> bool {
    let (rect, resp) = ui.allocate_exact_size(vec2(28.0, 16.0), if enabled { Sense::click() } else { Sense::hover() });
    resp.widget_info(|| WidgetInfo::selected(egui::Role::Switch, enabled, *on, label));
    let track = if *on {
        if enabled { t.accent } else { t.accent_a(100) }
    } else if enabled {
        t.ink(41)
    } else {
        t.ink(22)
    };
    ui.painter().rect_filled(rect, 8.0, track);
    let cx = if *on { rect.right() - 8.0 } else { rect.left() + 8.0 };
    let thumb = if enabled { t.knob } else { t.ink(150) };
    ui.painter().circle_filled(pos2(cx, rect.center().y), 6.5, thumb);
    let resp = if enabled { resp.on_hover_cursor(egui::CursorIcon::PointingHand) } else { resp };
    if enabled && resp.clicked() {
        *on = !*on;
        return true;
    }
    false
}

/// Switch row inside an inset group: min height 36, label left, 28×16 pill switch right.
pub fn switch_row(ui: &mut Ui, t: &Theme, label: &str, on: &mut bool, enabled: bool) -> bool {
    let mut toggled = false;
    Frame::NONE.inner_margin(Margin::symmetric(12, 0)).show(ui, |ui| {
        // One 36-px row: `horizontal_centered` would centre in all the height left below.
        let w = ui.available_width();
        ui.allocate_ui_with_layout(vec2(w, 36.0), egui::Layout::left_to_right(egui::Align::Center), |ui| {
            ui.set_min_size(vec2(w, 36.0));
            let fg = if enabled { t.text1 } else { t.text3 };
            ui.label(RichText::new(label).size(12.5).color(fg));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if pill_switch(ui, t, label, on, enabled) {
                    toggled = true;
                }
            });
        });
    });
    toggled
}

#[derive(Clone, Debug, Default)]
struct SliderState {
    dragging: bool,
    start_value: f64,
    editing: bool,
    draft: String,
    focus_requested: bool,
    /// Esc cancelled a drag while the button is still held: ignore the pointer until release.
    cancelled: bool,
}

fn snap_clamp(v: f64, range: std::ops::RangeInclusive<f64>, step: f64) -> f64 {
    let lo = *range.start();
    let hi = *range.end();
    let snapped = if step > 0.0 { ((v - lo) / step).round() * step + lo } else { v };
    snapped.clamp(lo, hi)
}

/// Fill-pill slider row: label inside left, value right (double-click to type), fill up to value
/// ending in a thin vertical bar. Commits ONCE on release, Return, or focus loss; Esc reverts.
#[allow(clippy::too_many_arguments)]
pub fn slider_row(
    ui: &mut Ui,
    t: &Theme,
    id: impl std::hash::Hash + std::fmt::Debug,
    label: &str,
    value: &mut f64,
    range: std::ops::RangeInclusive<f64>,
    step: f64,
    format_val: impl Fn(f64) -> String,
    parse_val: impl Fn(&str) -> Option<f64>,
    enabled: bool,
) -> SliderEvent {
    slider_row_with(ui, t, id, label, value, range, step, format_val, parse_val, enabled, &SliderLook::default()).0
}

const SLIDER_ACTIVE_KEY: &str = "bm_slider_active_frame";

/// True when any fill-pill slider was dragging or inline-editing on this or the previous frame.
pub fn slider_active(ctx: &egui::Context) -> bool {
    let now = ctx.cumulative_frame_nr();
    ctx.data(|d| d.get_temp::<u64>(egui::Id::unique(SLIDER_ACTIVE_KEY)))
        .is_some_and(|f| now.saturating_sub(f) <= 1)
}

/// How a slider row reads when its value comes from somewhere else.
#[derive(Default)]
pub struct SliderLook {
    /// The value is inherited: grey value text and a grey track fill.
    pub inherited: bool,
    /// A reset button before the value, with this accessible label ("Reset landing").
    pub reset: Option<String>,
}

/// [`slider_row`] with a look; also returns whether the reset button was clicked.
/// The slider bar's height.
const PILL_H: f32 = 36.0;

#[allow(clippy::too_many_arguments)]
pub fn slider_row_with(
    ui: &mut Ui,
    t: &Theme,
    id: impl std::hash::Hash + std::fmt::Debug,
    label: &str,
    value: &mut f64,
    range: std::ops::RangeInclusive<f64>,
    step: f64,
    format_val: impl Fn(f64) -> String,
    parse_val: impl Fn(&str) -> Option<f64>,
    enabled: bool,
    look: &SliderLook,
) -> (SliderEvent, bool) {
    let mut reset_clicked = false;
    let state_id = ui.make_persistent_id(id);
    let mut st = ui.data_mut(|d| d.get_temp::<SliderState>(state_id).unwrap_or_default());
    let mut event = SliderEvent::None;

    if !enabled {
        st.dragging = false;
        st.editing = false;
    }

    // One rounded bar (m6 controls, owner-approved): the label inside on the left, the value on
    // the right, a lighter fill up to the value ending in a thin white bar. Drag anywhere on it;
    // double-click the value to type. The fill is accent while dragging and grey when inherited.
    Frame::NONE.inner_margin(Margin { left: 8, right: 8, top: 4, bottom: 4 }).show(ui, |ui| {
        let (rect, resp) = ui.allocate_exact_size(
            vec2(ui.available_width(), PILL_H),
            if enabled { Sense::click_and_drag() } else { Sense::hover() },
        );
        resp.widget_info(|| WidgetInfo::slider(enabled, *value, label));
        let span = (*range.end() - *range.start()).max(1e-9);
        let pos_to_val = |x: f32| -> f64 {
            let frac = ((x - rect.left()) / rect.width().max(1.0)).clamp(0.0, 1.0) as f64;
            snap_clamp(*range.start() + frac * span, range.clone(), step)
        };

        // The value (and its reset) on the right, over the bar: clicks there are the value's.
        let text = format_val(*value);
        let vfg = if enabled && !look.inherited { t.text1 } else { t.text3 };
        let g = ui.painter().layout_no_wrap(text.clone(), FontId::proportional(12.5), vfg);
        let reset_w = if look.reset.is_some() { 22.0 } else { 0.0 };
        let value_rect = Rect::from_min_max(
            pos2(rect.right() - 10.0 - reset_w - g.size().x - 8.0, rect.top() + 7.0),
            pos2(rect.right() - 10.0 - reset_w, rect.bottom() - 7.0),
        );
        let reset_rect = Rect::from_center_size(pos2(rect.right() - 10.0 - 9.0, rect.center().y), vec2(18.0, 18.0));
        let pointer = ui.input(|i| i.pointer.interact_pos());
        let on_value = pointer.is_some_and(|p| value_rect.contains(p) || (reset_w > 0.0 && reset_rect.contains(p)));

        if st.editing {
            let edit_right = rect.right() - 6.0 - reset_w;
            let edit_left = (edit_right - 78.0).max(rect.left() + 80.0);
            let edit_rect = Rect::from_min_max(pos2(edit_left, rect.top() + 5.0), pos2(edit_right, rect.bottom() - 5.0));
            let edit_id = state_id.with("edit");
            let mut child = ui.new_child(egui::UiBuilder::new().max_rect(edit_rect).layout(egui::Layout::right_to_left(egui::Align::Center)));
            let edit = child.add(
                egui::TextEdit::singleline(&mut st.draft)
                    .id(edit_id)
                    .desired_width(edit_rect.width())
                    .align(Align2::RIGHT_CENTER)
                    .font(FontId::monospace(11.5)),
            );
            edit.widget_info(|| WidgetInfo::labeled(egui::Role::TextInput, true, format!("{label} value")));
            if st.focus_requested {
                edit.request_focus();
                if let Some(mut te) = egui::TextEdit::load_state(child.ctx(), edit_id) {
                    let all = egui::text::CCursorRange::two(egui::text::CCursor::new(0), egui::text::CCursor::new(st.draft.chars().count()));
                    te.cursor.set_char_range(Some(all));
                    te.store(child.ctx(), edit_id);
                }
                st.focus_requested = false;
            }
            if ui.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Escape)) {
                *value = st.start_value;
                st.editing = false;
            } else if ui.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Enter)) || edit.lost_focus() {
                st.editing = false;
                if let Some(parsed) = parse_val(&st.draft) {
                    let snapped = snap_clamp(parsed, range.clone(), step);
                    *value = snapped;
                    event = SliderEvent::Committed(snapped);
                } else {
                    *value = st.start_value;
                }
            }
        } else {
            let vresp = ui.interact(value_rect, state_id.with("value"), if enabled { Sense::click() } else { Sense::hover() });
            vresp.widget_info(|| {
                let mut info = WidgetInfo::labeled(egui::Role::Button, enabled, format!("{label} value"));
                info.current_text_value = Some(text.clone());
                info
            });
            if enabled && vresp.double_clicked() {
                st.editing = true;
                st.dragging = false;
                st.start_value = *value;
                st.draft = text.trim_start_matches("Inherit · ").to_owned();
                st.focus_requested = true;
            }
            if let Some(reset) = &look.reset {
                let rresp = ui
                    .interact(reset_rect, state_id.with("reset"), if enabled { Sense::click() } else { Sense::hover() })
                    .on_hover_cursor(egui::CursorIcon::PointingHand);
                rresp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, enabled, reset.as_str()));
                if enabled && rresp.on_hover_text(reset.as_str()).clicked() {
                    reset_clicked = true;
                }
            }
        }

        if enabled && !st.editing {
            let pointer_down = ui.input(|i| i.pointer.primary_down());
            if st.cancelled && !pointer_down {
                st.cancelled = false;
            }
            if st.cancelled {
                // The press that was cancelled with Esc: no new drag, no click commit.
            } else if !st.dragging && (resp.drag_started() || (resp.is_pointer_button_down_on() && !on_value)) {
                st.dragging = true;
                st.start_value = *value;
                if let Some(p) = pointer {
                    *value = pos_to_val(p.x);
                }
                event = SliderEvent::Changing;
            } else if st.dragging {
                if ui.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Escape)) {
                    *value = st.start_value;
                    st.dragging = false;
                    st.cancelled = true;
                    event = SliderEvent::None;
                } else if pointer_down {
                    if let Some(p) = pointer {
                        *value = pos_to_val(p.x);
                    }
                    event = SliderEvent::Changing;
                } else {
                    if let Some(p) = pointer {
                        *value = pos_to_val(p.x);
                    }
                    st.dragging = false;
                    event = SliderEvent::Committed(*value);
                }
            } else if resp.clicked()
                && !on_value
                && let Some(p) = resp.interact_pointer_pos()
            {
                *value = pos_to_val(p.x);
                event = SliderEvent::Committed(*value);
            }
            if st.dragging || (resp.hovered() && !on_value) {
                ui.ctx().set_cursor_icon(egui::CursorIcon::ResizeHorizontal);
            }
        }

        // Paint: bar, fill, value mark, label, value.
        let p = ui.painter_at(rect);
        let radius = CornerRadius::same(10);
        let hovered = enabled && (resp.hovered() || st.dragging);
        p.rect_filled(rect, radius, t.ink(if hovered { 19 } else { 14 }));
        let frac = ((*value - *range.start()) / span).clamp(0.0, 1.0) as f32;
        let fill_w = frac * rect.width();
        let fill = if !enabled {
            t.ink(12)
        } else if st.dragging {
            t.accent_a(74)
        } else if look.inherited {
            t.ink(15)
        } else {
            t.ink(28)
        };
        if fill_w > 1.0 {
            let right = (rect.left() + fill_w.max(14.0)).min(rect.right());
            p.rect_filled(Rect::from_min_max(rect.min, pos2(right, rect.bottom())), radius, fill);
        }
        let edge_stroke = if st.dragging {
            Stroke::new(1.0, t.accent_a(140))
        } else if hovered {
            Stroke::new(0.5, t.ink(28))
        } else {
            Stroke::NONE
        };
        if edge_stroke != Stroke::NONE {
            p.rect_stroke(rect, radius, edge_stroke, egui::StrokeKind::Inside);
        }
        // Smooth indicator bar inside the fill edge with zero jump across small values.
        let mark_x = (rect.left() + fill_w - 6.0).clamp(rect.left() + 6.0, rect.right() - 7.0);
        let mark = if !enabled || look.inherited {
            t.ink(120)
        } else if st.dragging {
            t.knob
        } else {
            t.text1
        };
        p.rect_filled(Rect::from_center_size(pos2(mark_x, rect.center().y), vec2(3.0, 18.0)), 1.5, mark);
        let lfg = if enabled { t.text1 } else { t.text3 };
        p.text(pos2(rect.left() + 13.0, rect.center().y), egui::Align2::LEFT_CENTER, label, FontId::proportional(12.5), lfg);
        if !st.editing {
            p.galley(pos2(value_rect.right() - 4.0 - g.size().x, rect.center().y - g.size().y / 2.0), g, vfg);
            if look.reset.is_some() {
                icons::paint(ui, Icon::Undo, reset_rect.shrink(3.0), 12.0, t.text3);
            }
        }
    });

    if st.dragging || st.editing {
        let frame = ui.ctx().cumulative_frame_nr();
        ui.ctx().data_mut(|d| d.insert_temp(egui::Id::unique(SLIDER_ACTIVE_KEY), frame));
    }
    ui.data_mut(|d| d.insert_temp(state_id, st));
    (event, reset_clicked)
}

/// Helper to parse a numeric string with optional trailing unit (e.g. "0.45 s", "120%", "45°", "2000 Hz").
pub fn parse_number(s: &str) -> Option<f64> {
    let trimmed = s.trim().trim_end_matches(|c: char| !c.is_ascii_digit() && c != '.' && c != '-' && c != '+').trim();
    trimmed.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Helper to render a footer bar pinned at the bottom of a settings page.
pub fn page_footer(ui: &mut Ui, t: &Theme, content: impl FnOnce(&mut Ui)) {
    let r = ui.min_rect();
    ui.painter().hline(r.x_range(), ui.cursor().top(), Stroke::new(0.5, t.ink(18)));
    Frame::NONE
        .inner_margin(Margin::symmetric(12, 10))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                content(ui);
            });
        });
    let _ = t;
}

/// Secondary footer button (subtle surface fill).
pub fn secondary_button(ui: &mut Ui, t: &Theme, label: &str, enabled: bool) -> Response {
    let btn = egui::Button::new(RichText::new(label).size(12.0).color(if enabled { t.text1 } else { t.text3 }))
        .fill(t.ink(if enabled { 18 } else { 8 }))
        .stroke(Stroke::new(0.5, t.ink(20)))
        .corner_radius(CornerRadius::same(6))
        .min_size(vec2(0.0, 26.0));
    ui.add_enabled(enabled, btn)
}

/// Primary accent footer button.
pub fn accent_button(ui: &mut Ui, t: &Theme, label: &str, enabled: bool) -> Response {
    let fill = if enabled {
        t.accent
    } else {
        t.accent_a(80)
    };
    let fg = if enabled { t.on_accent } else { t.ink(140) };
    let btn = egui::Button::new(RichText::new(label).size(12.0).strong().color(fg))
        .fill(fill)
        .stroke(Stroke::NONE)
        .corner_radius(CornerRadius::same(6))
        .min_size(vec2(0.0, 26.0));
    ui.add_enabled(enabled, btn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use egui::{Event, PointerButton};
    use egui_kittest::Harness;
    use egui_kittest::kittest::Queryable;

    struct State {
        value: f64,
        commits: Vec<f64>,
        changing_frames: usize,
    }

    fn slider_harness(initial: f64) -> Harness<'static, State> {
        let state = State { value: initial, commits: Vec::new(), changing_frames: 0 };
        let mut h = Harness::builder().with_size([360.0, 120.0]).build_ui_state(
            |ui, st: &mut State| {
                let t = Theme::DARK;
                ui.set_width(320.0);
                inset_group(ui, |ui| {
                    match slider_row(
                        ui,
                        &t,
                        "test-slider",
                        "Flight",
                        &mut st.value,
                        0.0..=1.0,
                        0.05,
                        |v| format!("{v:.2} s"),
                        parse_number,
                        true,
                    ) {
                        SliderEvent::None => {}
                        SliderEvent::Changing => st.changing_frames += 1,
                        SliderEvent::Committed(v) => st.commits.push(v),
                    }
                });
            },
            state,
        );
        h.run_steps(2);
        h
    }

    #[test]
    fn drag_commits_once_on_release() {
        let mut h = slider_harness(0.2);
        let rect = h.get_by_role_and_label(egui::accesskit::Role::Slider, "Flight").rect();
        let start = pos2(rect.left() + rect.width() * 0.2, rect.center().y);
        let mid = pos2(rect.left() + rect.width() * 0.5, rect.center().y);
        let end = pos2(rect.left() + rect.width() * 0.8, rect.center().y);

        h.event(Event::PointerMoved(start));
        h.event(Event::PointerButton { pos: start, button: PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE });
        h.step();
        h.event(Event::PointerMoved(mid));
        h.step();
        assert!(h.state().commits.is_empty(), "must not commit mid-drag");
        assert!(h.state().changing_frames > 0);

        h.event(Event::PointerMoved(end));
        h.step();
        assert!(h.state().commits.is_empty(), "must not commit before release");

        h.event(Event::PointerButton { pos: end, button: PointerButton::Primary, pressed: false, modifiers: Modifiers::NONE });
        h.step();
        assert_eq!(h.state().commits.len(), 1, "expected exactly 1 commit on release");
        assert!((h.state().commits[0] - 0.8).abs() <= 0.06, "got {}", h.state().commits[0]);
        assert!((h.state().value - h.state().commits[0]).abs() < 1e-9);
    }

    fn double_click(h: &mut Harness<'static, State>, p: egui::Pos2) {
        let mut t = h.ctx.input(|i| i.time) + 0.02;
        for _ in 0..2 {
            h.input_mut().time = Some(t);
            h.event(Event::PointerMoved(p));
            h.event(Event::PointerButton { pos: p, button: PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE });
            h.step();
            t += 0.02;
            h.input_mut().time = Some(t);
            h.event(Event::PointerButton { pos: p, button: PointerButton::Primary, pressed: false, modifiers: Modifiers::NONE });
            h.step();
            t += 0.02;
        }
        h.input_mut().time = Some(t);
        h.step();
    }

    #[test]
    fn typing_commits_on_return() {
        let mut h = slider_harness(0.2);
        let val_rect = h.get_by_label("Flight value").rect();
        double_click(&mut h, val_rect.center());
        assert!(h.query_by_role(egui::accesskit::Role::TextInput).is_some(), "double-click opens inline text input");
        // Select all & replace with "0.75".
        h.event(Event::Key { key: Key::A, physical_key: None, pressed: true, repeat: false, modifiers: Modifiers::COMMAND });
        h.event(Event::Key { key: Key::A, physical_key: None, pressed: false, repeat: false, modifiers: Modifiers::COMMAND });
        h.event(Event::Text("0.75".into()));
        h.step();
        assert!(h.state().commits.is_empty());

        h.event(Event::Key { key: Key::Enter, physical_key: None, pressed: true, repeat: false, modifiers: Modifiers::NONE });
        h.event(Event::Key { key: Key::Enter, physical_key: None, pressed: false, repeat: false, modifiers: Modifiers::NONE });
        h.step();
        assert_eq!(h.state().commits, vec![0.75]);
        assert!((h.state().value - 0.75).abs() < 1e-9);
    }

    #[test]
    fn escape_reverts() {
        let mut h = slider_harness(0.35);
        // 1. Escape during drag reverts with zero commits.
        let rect = h.get_by_role_and_label(egui::accesskit::Role::Slider, "Flight").rect();
        let start = pos2(rect.left() + rect.width() * 0.35, rect.center().y);
        let far = pos2(rect.left() + rect.width() * 0.9, rect.center().y);
        h.event(Event::PointerMoved(start));
        h.event(Event::PointerButton { pos: start, button: PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE });
        h.step();
        h.event(Event::PointerMoved(far));
        h.step();
        assert!(h.state().value > 0.7);
        h.event(Event::Key { key: Key::Escape, physical_key: None, pressed: true, repeat: false, modifiers: Modifiers::NONE });
        h.event(Event::Key { key: Key::Escape, physical_key: None, pressed: false, repeat: false, modifiers: Modifiers::NONE });
        h.step();
        h.event(Event::PointerButton { pos: far, button: PointerButton::Primary, pressed: false, modifiers: Modifiers::NONE });
        h.step();
        assert!((h.state().value - 0.35).abs() < 1e-9, "Esc during drag must revert");
        assert!(h.state().commits.is_empty());

        // 2. Escape during inline text editing reverts with zero commits.
        let val_rect = h.get_by_label("Flight value").rect();
        double_click(&mut h, val_rect.center());
        h.event(Event::Key { key: Key::A, physical_key: None, pressed: true, repeat: false, modifiers: Modifiers::COMMAND });
        h.event(Event::Key { key: Key::A, physical_key: None, pressed: false, repeat: false, modifiers: Modifiers::COMMAND });
        h.event(Event::Text("0.95".into()));
        h.step();
        h.event(Event::Key { key: Key::Escape, physical_key: None, pressed: true, repeat: false, modifiers: Modifiers::NONE });
        h.event(Event::Key { key: Key::Escape, physical_key: None, pressed: false, repeat: false, modifiers: Modifiers::NONE });
        h.step();
        assert!((h.state().value - 0.35).abs() < 1e-9, "Esc during edit must revert");
        assert!(h.state().commits.is_empty());
    }
}
