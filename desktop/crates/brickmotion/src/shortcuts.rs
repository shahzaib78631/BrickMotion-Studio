//! Keyboard shortcuts, read from the command registry.
use crate::BrickMotionApp;
use crate::commands::{Shortcut, registry, run};

/// Every command's shortcut, most modifiers first: egui ignores extra ⇧ and ⌥ when matching, so
/// ⇧⌘Z must be taken before ⌘Z sees it.
fn ordered() -> Vec<(Shortcut, &'static str)> {
    let mut list: Vec<(Shortcut, &'static str)> =
        registry().iter().filter_map(|c| Some((Shortcut::parse(c.keys?)?, c.id))).collect();
    list.sort_by_key(|(s, _)| std::cmp::Reverse(s.specificity()));
    list
}

/// Runs the commands whose keys were pressed this frame. A key without ⌘ belongs to a focused
/// text field. A matched key is consumed, so widgets do not also act on it.
pub fn handle(app: &mut BrickMotionApp, ctx: &egui::Context) {
    let typing = app.text_focus;
    for (s, id) in ordered() {
        if typing && !s.mods.command {
            continue;
        }
        if ctx.input_mut(|i| i.consume_key(s.mods, s.key)) {
            run(app, id);
        }
    }
}
