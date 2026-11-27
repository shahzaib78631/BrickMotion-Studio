// Pop-up rows (Group, Position, Order…): every option in the menu is a full-width row.
use brickmotion::chrome::widgets::popup_row;
use brickmotion::theme::{self, Theme};
use egui::accesskit::Role;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

const OPTIONS: [&str; 5] = ["By Step", "By Colour", "By Part", "By Size", "All at Once"];

fn harness() -> Harness<'static, usize> {
    Harness::builder().with_size([360.0, 400.0]).build_ui_state(
        |ui, picked: &mut usize| {
            let t = Theme::DARK;
            theme::apply(ui.ctx(), &t);
            ui.set_width(320.0);
            let current = OPTIONS[*picked];
            popup_row(ui, &t, "group", "Group", current, &OPTIONS, picked, true);
        },
        4,
    )
}

#[test]
fn every_option_is_as_wide_as_the_menu() {
    let mut h = harness();
    h.get_by_role_and_label(Role::ComboBox, "Group").click();
    h.run_steps(3);
    let widths: Vec<f32> = OPTIONS.iter().map(|o| h.get_by_label(o).rect().width()).collect();
    let widest = widths.iter().copied().fold(0.0, f32::max);
    assert!(widest >= 170.0, "rows fill the menu: {widths:?}");
    assert!(widths.iter().all(|w| (w - widest).abs() < 0.5), "all rows the same width: {widths:?}");
}

#[test]
fn clicking_beside_the_text_picks_the_option() {
    let mut h = harness();
    h.get_by_role_and_label(Role::ComboBox, "Group").click();
    h.run_steps(3);
    // 150 px in from the row's left edge: past the end of "By Step", still inside the menu.
    let row = h.get_by_label("By Step").rect();
    let at = egui::pos2(row.min.x + 150.0, row.center().y);
    h.hover_at(at);
    h.run_steps(1);
    h.event(egui::Event::PointerButton { pos: at, button: egui::PointerButton::Primary, pressed: true, modifiers: Default::default() });
    h.event(egui::Event::PointerButton { pos: at, button: egui::PointerButton::Primary, pressed: false, modifiers: Default::default() });
    h.run_steps(3);
    assert_eq!(*h.state(), 0, "the right end of the row picks it");
}

/// Pictures of the open menu for review: `MENU_SHOTS=<dir> cargo test --test popup_menu -- --ignored`.
#[test]
#[ignore]
fn menu_screenshots() {
    let Ok(dir) = std::env::var("MENU_SHOTS") else { return };
    for (name, t) in [("dark", Theme::DARK), ("light", Theme::LIGHT)] {
        let mut h = Harness::builder().with_size([360.0, 260.0]).with_pixels_per_point(2.0).build_ui_state(
            move |ui, picked: &mut usize| {
                theme::apply(ui.ctx(), &t);
                egui::Frame::NONE.fill(t.bg1).inner_margin(12).show(ui, |ui| {
                    ui.set_width(320.0);
                    let current = OPTIONS[*picked];
                    popup_row(ui, &t, "group", "Group", current, &OPTIONS, picked, true);
                });
            },
            4,
        );
        h.get_by_role_and_label(Role::ComboBox, "Group").click();
        h.run_steps(3);
        let row = h.get_by_label("By Part").rect();
        h.hover_at(egui::pos2(row.min.x + 150.0, row.center().y));
        h.run_steps(2);
        h.render().unwrap().save(std::path::Path::new(&dir).join(format!("menu-{name}.png"))).unwrap();
    }
}
