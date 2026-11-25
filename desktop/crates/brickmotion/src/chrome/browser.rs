//! The floating Browser: Models / Steps / Parts / Library, a filter, and the model tree.
use egui::{Area, Frame, Id, Margin, Order, Rect, RichText, Stroke, Ui, pos2, vec2};

use super::{caption, float_frame, icon_button, panel_header};
use crate::BrickMotionApp;
use crate::icons::{self, Icon};

const WIDTH: f32 = 300.0;
const TABS: [&str; 4] = ["Models", "Steps", "Parts", "Library"];

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: Rect) {
    let t = app.theme;
    let title = app.title();
    let count = app.piece_count();
    Area::new(Id::unique("browser"))
        .order(Order::Middle)
        .fixed_pos(area.min + vec2(10.0, 10.0))
        .constrain_to(area)
        .show(ui.ctx(), |ui| {
            float_frame(&t).show(ui, |ui| {
                ui.set_width(WIDTH);
                ui.spacing_mut().item_spacing.y = 0.0;
                panel_header(ui, &t, "Browser", |ui| {
                    icon_button(ui, &t, Icon::Up, "Collapse", false, false, 24.0);
                    icon_button(ui, &t, Icon::More, "More", false, false, 24.0);
                    icon_button(ui, &t, Icon::Search, "Find", false, false, 24.0);
                });
                Frame::NONE.inner_margin(Margin { left: 8, right: 8, top: 8, bottom: 2 }).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 2.0;
                        for (k, tab) in TABS.iter().enumerate() {
                            let on = app.browser_tab == k;
                            let b = egui::Button::new(RichText::new(*tab).color(if on { t.text1 } else { t.text3 }))
                                .fill(if on { t.bg3 } else { egui::Color32::TRANSPARENT })
                                .min_size(vec2(0.0, 24.0));
                            if ui.add(b).clicked() {
                                app.browser_tab = k;
                            }
                        }
                    });
                });
                Frame::NONE.inner_margin(Margin { left: 8, right: 8, top: 6, bottom: 2 }).show(ui, |ui| {
                    Frame::NONE
                        .fill(t.bg1)
                        .stroke(Stroke::new(1.0, t.border))
                        .corner_radius(6)
                        .inner_margin(Margin { left: 9, right: 9, top: 0, bottom: 0 })
                        .show(ui, |ui| {
                            ui.set_height(26.0);
                            ui.horizontal_centered(|ui| {
                                icons::icon(ui, Icon::Search, 16.0, t.text3);
                                let field = ui.add(
                                    egui::TextEdit::singleline(&mut app.filter)
                                        .hint_text(RichText::new("Filter models and parts").color(t.text3))
                                        .frame(egui::Frame::NONE)
                                        .margin(Margin::ZERO)
                                        .align(egui::Align2::LEFT_CENTER)
                                        .desired_width(f32::INFINITY),
                                );
                                field.widget_info(|| egui::WidgetInfo::labeled(egui::Role::TextInput, true, "Filter models and parts"));
                            });
                        });
                });
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
                        super::tree::show(ui, app);
                    } else if app.browser_tab == 0 {
                        root_row(ui, app, &title, count);
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
        });
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
