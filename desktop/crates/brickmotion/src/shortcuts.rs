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
/// text field. A matched key is consumed, so widgets do not also act on it. With the menu bar
/// installed, ⌘ keys belong to it (AppKit gives them to the menu first), so they run once.
pub fn handle(app: &mut BrickMotionApp, ctx: &egui::Context) {
    // A slider being dragged or typed into owns Esc and the plain keys (Esc reverts it); so does an open menu.
    let typing = app.text_focus
        || app.palette.open
        || app.swatches.open.is_some()
        || app.steps.editor.is_some()
        || app.replace.open
        || app.naming.is_some()
        || app.shortcuts_open || app.settings.open || app.about_open
        // An open menu or popup owns Esc and the arrow keys.
        || egui::Popup::is_any_open(ctx)
        || crate::chrome::widgets::slider_active(ctx);

    // While placing a part, Tab, ⇧Tab, R, Return and Esc belong to the placement before the registry.
    if !typing && app.edit.placement.is_some() {
        if ctx.input_mut(|i| i.consume_key(egui::Modifiers::NONE, egui::Key::Escape)) {
            app.cancel_placement();
            return;
        }
        if ctx.input_mut(|i| i.consume_key(egui::Modifiers::NONE, egui::Key::Enter)) {
            if let Some(p) = app.edit.placement.as_mut() {
                p.accept();
            }
            return;
        }
        if ctx.input_mut(|i| i.consume_key(egui::Modifiers::NONE, egui::Key::R)) {
            if let (Some(p), Some(vp)) = (app.edit.placement.as_mut(), app.doc.viewport()) {
                p.turn(vp);
            }
            return;
        }
        if ctx.input_mut(|i| i.consume_key(egui::Modifiers::SHIFT, egui::Key::Tab)) {
            if let (Some(p), Some(vp)) = (app.edit.placement.as_mut(), app.doc.viewport()) {
                p.cycle_grip(vp, true);
            }
            return;
        }
        if ctx.input_mut(|i| i.consume_key(egui::Modifiers::NONE, egui::Key::Tab)) {
            if let (Some(p), Some(vp)) = (app.edit.placement.as_mut(), app.doc.viewport()) {
                p.cycle_grip(vp, false);
            }
            return;
        }
    }

    let menu = app.menubar.is_some();
    for (s, id) in ordered() {
        if (typing && !s.mods.command) || (menu && s.mods.command) {
            continue;
        }
        let alt = ctx.input(|i| {
            i.modifiers.alt
                || i.events.iter().any(|e| {
                    matches!(e, egui::Event::Key { key, pressed: true, modifiers, .. } if *key == s.key && modifiers.alt)
                })
        });
        if ctx.input_mut(|i| i.consume_key(s.mods, s.key)) {
            app.edit.alt_held = alt;
            run(app, id);
            app.edit.alt_held = false;
        }
    }
    // S opens the palette too (⌘K is its listed shortcut).
    if !typing && ctx.input_mut(|i| i.consume_key(egui::Modifiers::NONE, egui::Key::S)) {
        run(app, "view.palette");
    }
}
