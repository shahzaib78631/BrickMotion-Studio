//! Look › Bricks: how parts are rounded for display (bmr::Rounding). Planning and collision always
//! use the parts as the library draws them; these only change the picture, in the viewport and in
//! every export.
use egui::Ui;

use bm::export::RenderLook;

use super::widgets::{footnote, hairline, inset_group, section_header, switch_row};
use crate::theme::Theme;

type Field = fn(&mut RenderLook) -> &mut bool;

const ROWS: [(&str, Field); 3] = [
    ("Smooth curves", |l| &mut l.smooth_curves),
    ("Rounded edges", |l| &mut l.rounded_edges),
    ("Soft stud bases", |l| &mut l.soft_stud_roots),
];

/// The Bricks card. Returns the look with the switch that was flipped, if one was.
pub fn section(ui: &mut Ui, t: &Theme, look: &RenderLook) -> Option<RenderLook> {
    let mut next = look.clone();
    let mut changed = false;
    section_header(ui, t, "Bricks", None);
    inset_group(ui, |ui| {
        for (i, (label, field)) in ROWS.into_iter().enumerate() {
            if i > 0 {
                hairline(ui);
            }
            changed |= switch_row(ui, t, label, field(&mut next), true);
        }
    });
    footnote(ui, t, "Rounder studs and softer edges. Off draws the parts as plain LDraw geometry.");
    changed.then_some(next)
}
