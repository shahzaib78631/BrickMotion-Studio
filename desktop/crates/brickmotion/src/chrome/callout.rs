//! Floating Step callout bar: bottom-left of the viewport, above the selection chip.
//! Steps through build steps, plays a step or through the end, and switches step appearances.
use bm::playback::AssemblyPreview;
use egui::{
    Align2, Area, Color32, CornerRadius, FontId, Id, Margin, Order, Rect, RichText, Sense, Stroke, Ui, WidgetInfo,
    pos2, vec2,
};

use super::{float_frame, icon_button_tip};
use crate::BrickMotionApp;
use crate::icons::{self, Icon};

const APPEARANCES: &[(AssemblyPreview, &str, &str, &str)] = &[
    (AssemblyPreview::Assembled, "Assembled", "Assembled through This Step", "step.appearance_assembled"),
    (AssemblyPreview::Separated, "Separated", "Separated from Earlier Steps", "step.appearance_separated"),
    (AssemblyPreview::LaidOut, "Laid Out", "Lay Out These Parts", "step.appearance_laid_out"),
    (AssemblyPreview::Exploded, "Exploded", "Explode This Step", "step.appearance_exploded"),
];

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect) {
    if !app.has_document {
        return;
    }
    app.steps.sync(app.doc.session());
    let total = app.steps.len();
    if total == 0 {
        return;
    }
    let Some(raw_step) = app.transport.focused_step else {
        return;
    };
    let step = raw_step.min(total - 1);
    if step != raw_step {
        app.transport.focused_step = Some(step);
    }
    let parts = app.steps.row(step).map_or(0, |r| r.pieces);
    let step_title = app.steps.row(step).map(|r| r.title.clone()).unwrap_or_default();

    let t = app.theme;
    let has_bottom_chip = app.edit.placement.is_some() || app.doc.session().selection_len() > 0;
    let offset_y = if has_bottom_chip { -52.0 } else { -14.0 };

    let mut action: Option<CalloutAction> = None;

    Area::new(Id::unique("step-callout"))
        .order(Order::Middle)
        .anchor(Align2::LEFT_BOTTOM, vec2(12.0, offset_y))
        .constrain_to(area)
        .show(ui.ctx(), |ui| {
            float_frame(&t)
                .corner_radius(CornerRadius::same(10))
                .inner_margin(Margin::symmetric(8, 5))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 4.0;

                        let can_prev = step > 0;
                        if icon_button_tip(ui, &t, Icon::Back, "Previous Step", "Previous step", can_prev, false, 24.0)
                            .clicked()
                        {
                            action = Some(CalloutAction::Step(step - 1));
                        }

                        // Step title and part count.
                        let step_word = format!("Step {}", step + 1);
                        let part_word = if parts == 1 { "part" } else { "parts" };
                        let meta = format!("of {total} · {parts} {part_word}");
                        let mut label_resp = ui.label(RichText::new(step_word).strong().size(12.5).color(t.text1));
                        if !step_title.is_empty() {
                            label_resp = label_resp.on_hover_text(step_title);
                        }
                        let _ = label_resp;
                        ui.label(RichText::new(meta).size(11.5).color(t.text3));

                        let can_next = step + 1 < total;
                        if icon_button_tip(ui, &t, Icon::Chevron, "Next Step", "Next step", can_next, false, 24.0)
                            .clicked()
                        {
                            action = Some(CalloutAction::Step(step + 1));
                        }

                        divider(ui, &t);

                        if text_icon_button(ui, &t, Some(Icon::Play), "Play Step", "Play this step", false).clicked() {
                            action = Some(CalloutAction::Command("step.play"));
                        }
                        if text_icon_button(ui, &t, None, "Play to End", "Play from this step to the end", false)
                            .clicked()
                        {
                            action = Some(CalloutAction::Command("step.play_to_end"));
                        }

                        divider(ui, &t);

                        let current_mode = app.transport.step_preview;
                        let mode_label = current_mode
                            .and_then(|m| APPEARANCES.iter().find(|(a, _, _, _)| *a == m).map(|(_, s, _, _)| *s))
                            .unwrap_or("Appearance");
                        let mode_active = current_mode.is_some();
                        let mode_btn = dropdown_button(ui, &t, mode_label, "Step Appearance", mode_active);
                        egui::Popup::from_toggle_button_response(&mode_btn).gap(6.0).show(|ui| {
                            use super::menu;
                            menu::prepare_width(ui, 232.0);
                            for &(mode, _, menu_label, cmd) in APPEARANCES {
                                let selected = current_mode == Some(mode);
                                if menu::item_check(ui, &t, menu_label, selected, true) {
                                    action = Some(CalloutAction::Command(cmd));
                                }
                            }
                            menu::separator(ui, &t);
                            let all_on = current_mode.is_none() && app.transport.state.at_rest;
                            if menu::item_check(ui, &t, "Show All Steps", all_on, true) {
                                action = Some(CalloutAction::Command("step.show_all"));
                            }
                        });

                        if text_icon_button(ui, &t, None, "Show All", "Show all steps assembled", false).clicked() {
                            action = Some(CalloutAction::Command("step.show_all"));
                        }

                        if icon_button_tip(
                            ui,
                            &t,
                            Icon::Close,
                            "Close Step Callout",
                            "Return to full model",
                            true,
                            false,
                            24.0,
                        )
                        .clicked()
                        {
                            action = Some(CalloutAction::Close);
                        }
                    });
                });
        });

    match action {
        Some(CalloutAction::Step(next)) => {
            app.edit.step = Some(next);
            let mode = app.transport.step_preview.unwrap_or(AssemblyPreview::Assembled);
            if let Some(vp) = app.doc.viewport() {
                app.transport.arrange(vp, Some(next), mode);
            } else {
                app.transport.focused_step = Some(next);
            }
        }
        Some(CalloutAction::Command(cmd)) => {
            app.edit.step = Some(step);
            app.requested.push(cmd);
        }
        Some(CalloutAction::Close) => {
            if let Some(vp) = app.doc.viewport() {
                app.transport.rest(vp);
            } else {
                app.transport.focused_step = None;
                app.transport.step_preview = None;
            }
        }
        None => {}
    }
}

enum CalloutAction {
    Step(usize),
    Command(&'static str),
    Close,
}

fn divider(ui: &mut Ui, t: &crate::Theme) {
    let (r, _) = ui.allocate_exact_size(vec2(7.0, 24.0), Sense::hover());
    ui.painter().vline(r.center().x, r.y_range().shrink(4.0), Stroke::new(1.0, t.border));
}

fn text_icon_button(
    ui: &mut Ui,
    t: &crate::Theme,
    icon: Option<Icon>,
    label: &str,
    tip: &str,
    active: bool,
) -> egui::Response {
    let fg = if active { t.accent } else { t.text1 };
    let galley = ui.painter().layout_no_wrap(label.to_owned(), FontId::proportional(12.0), fg);
    let icon_w = if icon.is_some() { 15.0 } else { 0.0 };
    let (rect, resp) = ui.allocate_exact_size(vec2(galley.size().x + icon_w + 14.0, 24.0), Sense::click());
    resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, label));
    if active {
        ui.painter().rect_filled(rect, 6.0, t.accent_bg());
    } else if resp.hovered() {
        ui.painter().rect_filled(rect, 6.0, Color32::from_white_alpha(18));
    }
    let y = rect.center().y;
    let mut x = rect.left() + 7.0;
    if let Some(ic) = icon {
        icons::paint(ui, ic, Rect::from_center_size(pos2(x + 5.5, y), vec2(12.0, 12.0)), 12.0, fg);
        x += icon_w;
    }
    ui.painter().galley(pos2(x, y - galley.size().y / 2.0), galley, fg);
    resp.on_hover_text(tip)
}

fn dropdown_button(ui: &mut Ui, t: &crate::Theme, label: &str, a11y: &str, active: bool) -> egui::Response {
    let fg = if active { t.accent } else { t.text1 };
    let galley = ui.painter().layout_no_wrap(label.to_owned(), FontId::proportional(12.0), fg);
    let (rect, resp) = ui.allocate_exact_size(vec2(galley.size().x + 26.0, 24.0), Sense::click());
    resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, a11y));
    if active {
        ui.painter().rect_filled(rect, 6.0, t.accent_bg());
    } else if resp.hovered() {
        ui.painter().rect_filled(rect, 6.0, Color32::from_white_alpha(18));
    }
    let y = rect.center().y;
    ui.painter().galley(pos2(rect.left() + 7.0, y - galley.size().y / 2.0), galley, fg);
    icons::paint(ui, Icon::Down, Rect::from_center_size(pos2(rect.right() - 10.0, y), vec2(11.0, 11.0)), 11.0, fg);
    resp.on_hover_text("Change how this step is displayed")
}
