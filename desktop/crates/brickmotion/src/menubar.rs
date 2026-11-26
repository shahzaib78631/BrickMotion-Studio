//! The native menu bar (muda), made from the command registry. Each item's id is its command id,
//! and choosing it calls `commands::run` like every other entry point.
//!
//! Only ⌘ shortcuts become menu key equivalents: AppKit gives those to the menu before the
//! window, so they run once, through the menu. Single keys (F, H, ⌫, Esc) stay with the window,
//! where a focused text field can type them.
use muda::accelerator::{Accelerator, Code, Modifiers as MenuMods};
use muda::{IsMenuItem, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};

use crate::BrickMotionApp;
use crate::commands::{Command, Ctx, Shortcut, enabled, find, run, title};
use crate::support::Recents;

/// A menu-bar menu.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MenuSection {
    pub title: &'static str,
    pub items: Vec<MenuEntry>,
}

/// One entry of a menu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuEntry {
    Command(&'static str),
    Separator,
    /// The Open Recent submenu.
    Recent,
    /// An item AppKit provides.
    System(SystemItem),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SystemItem {
    About,
    Hide,
    HideOthers,
    ShowAll,
    Minimize,
    Zoom,
    Fullscreen,
    BringAllToFront,
}

/// The menus, in order.
pub fn menu_model() -> Vec<MenuSection> {
    use MenuEntry::{Command as C, Recent, Separator as Sep, System as S};
    vec![
        MenuSection {
            title: "BrickMotion",
            items: vec![
                S(SystemItem::About),
                Sep,
                C("app.settings"),
                Sep,
                S(SystemItem::Hide),
                S(SystemItem::HideOthers),
                S(SystemItem::ShowAll),
                Sep,
                C("app.quit"),
            ],
        },
        MenuSection { title: "File", items: vec![C("file.new"), C("file.open"), Recent, Sep, C("file.save"), C("file.save_as"), Sep, C("file.export_ldraw"), C("file.export_plan"), C("file.export_submodels")] },
        MenuSection {
            title: "Edit",
            items: vec![
                C("edit.undo"),
                C("edit.redo"),
                Sep,
                C("edit.cut"),
                C("edit.copy"),
                C("edit.paste"),
                C("edit.copy_viewport"),
                C("edit.delete"),
                Sep,
                C("model.duplicate"),
                C("edit.clone"),
                C("model.rotate"),
                Sep,
                C("edit.select_all"),
                C("edit.select_none"),
                C("edit.hide"),
                C("edit.show_all"),
            ],
        },
        MenuSection {
            title: "View",
            items: vec![C("view.fit"), C("view.home"), C("view.frame_selection"), Sep, C("view.look"), C("view.joints"), Sep, C("view.palette")],
        },
        MenuSection {
            title: "Window",
            items: vec![
                S(SystemItem::Minimize),
                S(SystemItem::Zoom),
                Sep,
                S(SystemItem::Fullscreen),
                Sep,
                C("output.render_queue"),
                Sep,
                S(SystemItem::BringAllToFront),
            ],
        },
    ]
}

/// The menu key equivalent for `keys`, when it has ⌘.
pub fn accelerator(keys: &str) -> Option<Accelerator> {
    let s = Shortcut::parse(keys)?;
    if !s.mods.command {
        return None;
    }
    let mut mods = MenuMods::SUPER;
    if s.mods.shift {
        mods |= MenuMods::SHIFT;
    }
    if s.mods.alt {
        mods |= MenuMods::ALT;
    }
    if s.mods.ctrl {
        mods |= MenuMods::CONTROL;
    }
    let name = s.key.name();
    let code: Code = if name.len() == 1 && name.chars().all(|c| c.is_ascii_alphabetic()) {
        format!("Key{name}").parse().ok()?
    } else {
        name.parse().ok()?
    };
    Some(Accelerator::new(Some(mods), code))
}

/// Whether a menu item is enabled. While a text field has focus, ⌘A and ⌘Z belong to it, so
/// those items are off and AppKit passes the keys on to the window.
pub fn menu_enabled(c: &Command, ctx: &Ctx) -> bool {
    let text_keys = matches!(
        c.id,
        "edit.select_all" | "edit.undo" | "edit.redo" | "edit.copy" | "edit.cut" | "edit.paste"
    );
    enabled(c, ctx) && !(ctx.text_focus && text_keys)
}

const RECENT_PREFIX: &str = "recent:";
const RECENT_CLEAR: &str = "recent.clear";

/// The installed menu bar and what each item last showed.
pub struct MenuBar {
    _menu: muda::Menu,
    items: Vec<(&'static Command, MenuItem, String, bool)>,
    recent: Submenu,
    recent_items: Vec<Box<dyn IsMenuItem>>,
    recent_shown: Option<Vec<std::path::PathBuf>>,
    events: std::sync::mpsc::Receiver<MenuEvent>,
}

impl MenuBar {
    /// Makes the menu bar and gives it to the app. Main thread, after the window exists. A chosen
    /// item wakes `ctx`: a menu click is no window event, so egui would not draw a frame for it.
    pub fn install(ctx: &egui::Context) -> MenuBar {
        let (tx, events) = std::sync::mpsc::channel();
        let wake = ctx.clone();
        MenuEvent::set_event_handler(Some(move |e: MenuEvent| {
            let _ = tx.send(e);
            wake.request_repaint();
        }));
        let menu = muda::Menu::new();
        let mut items = Vec::new();
        let recent = Submenu::new("Open Recent", true);
        for section in menu_model() {
            let sub = Submenu::new(section.title, true);
            for e in section.items {
                let _ = match e {
                    MenuEntry::Command(id) => {
                        let c = find(id).expect("menu commands are registered");
                        let item = MenuItem::with_id(c.id, c.title, c.when != crate::commands::When::Soon, c.keys.and_then(accelerator));
                        let r = sub.append(&item);
                        items.push((c, item, c.title.to_owned(), true));
                        r
                    }
                    MenuEntry::Separator => sub.append(&PredefinedMenuItem::separator()),
                    MenuEntry::Recent => sub.append(&recent),
                    MenuEntry::System(s) => sub.append(&system(s)),
                };
            }
            if section.title == "Window" {
                sub.set_as_windows_menu_for_nsapp();
            }
            let _ = menu.append(&sub);
        }
        menu.init_for_nsapp();
        MenuBar { _menu: menu, items, recent, recent_items: Vec::new(), recent_shown: None, events }
    }

    /// Brings titles, enabled states and Open Recent up to date; touches only what changed.
    pub fn sync(&mut self, ctx: &Ctx, recents: &Recents) {
        for (c, item, shown_title, shown_on) in &mut self.items {
            let (t, on) = (title(c, ctx), menu_enabled(c, ctx));
            if *shown_title != t {
                item.set_text(&t);
                *shown_title = t;
            }
            if *shown_on != on {
                item.set_enabled(on);
                *shown_on = on;
            }
        }
        let now: Vec<std::path::PathBuf> = recents.existing().into_iter().map(|p| p.to_path_buf()).collect();
        if self.recent_shown.as_ref() != Some(&now) {
            for old in self.recent_items.drain(..) {
                let _ = self.recent.remove(old.as_ref());
            }
            for (i, p) in now.iter().enumerate() {
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                self.recent_items.push(Box::new(MenuItem::with_id(format!("{RECENT_PREFIX}{i}"), name, true, None)));
            }
            self.recent_items.push(Box::new(PredefinedMenuItem::separator()));
            self.recent_items.push(Box::new(MenuItem::with_id(RECENT_CLEAR, "Clear Menu", !now.is_empty(), None)));
            for item in &self.recent_items {
                let _ = self.recent.append(item.as_ref());
            }
            self.recent_shown = Some(now);
        }
    }

    /// The file an Open Recent item stands for.
    fn recent_path(&self, id: &str) -> Option<std::path::PathBuf> {
        let i: usize = id.strip_prefix(RECENT_PREFIX)?.parse().ok()?;
        self.recent_shown.as_ref()?.get(i).cloned()
    }
}

fn system(s: SystemItem) -> PredefinedMenuItem {
    match s {
        SystemItem::About => PredefinedMenuItem::about(Some("About BrickMotion"), None),
        SystemItem::Hide => PredefinedMenuItem::hide(Some("Hide BrickMotion")),
        SystemItem::HideOthers => PredefinedMenuItem::hide_others(None),
        SystemItem::ShowAll => PredefinedMenuItem::show_all(None),
        SystemItem::Minimize => PredefinedMenuItem::minimize(None),
        SystemItem::Zoom => PredefinedMenuItem::maximize(Some("Zoom")),
        SystemItem::Fullscreen => PredefinedMenuItem::fullscreen(None),
        SystemItem::BringAllToFront => PredefinedMenuItem::bring_all_to_front(None),
    }
}

/// Runs the menu items chosen since the last frame.
pub fn poll(app: &mut BrickMotionApp) {
    let chosen: Vec<MenuEvent> = match &app.menubar {
        Some(m) => m.events.try_iter().collect(),
        None => return,
    };
    for e in chosen {
        let id = e.id().0.as_str();
        if id == RECENT_CLEAR {
            app.recents.clear();
            let _ = app.recents.save(&app.support);
        } else if let Some(p) = app.menubar.as_ref().and_then(|m| m.recent_path(id)) {
            app.open(p);
        } else if let Some(c) = find(id) {
            run(app, c.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{Menu, find, registry};

    fn ids(section: &MenuSection) -> Vec<&'static str> {
        section.items.iter().filter_map(|e| if let MenuEntry::Command(id) = e { Some(*id) } else { None }).collect()
    }

    #[test]
    fn menu_model_ids_exist() {
        for s in menu_model() {
            for id in ids(&s) {
                assert!(find(id).is_some(), "{id} is not a command");
            }
        }
    }

    #[test]
    fn every_menu_command_in_model() {
        let all: Vec<&str> = menu_model().iter().flat_map(ids).collect();
        for c in registry().iter().filter(|c| c.menu != Menu::None) {
            assert_eq!(all.iter().filter(|id| **id == c.id).count(), 1, "{} appears once", c.id);
        }
        for id in &all {
            assert_ne!(find(id).unwrap().menu, Menu::None, "{id} has a menu");
        }
    }

    #[test]
    fn edit_menu_order() {
        let m = menu_model();
        let titles: Vec<&str> = m.iter().map(|s| s.title).collect();
        assert_eq!(titles, ["BrickMotion", "File", "Edit", "View", "Window"]);
        assert!(m[4].items.contains(&MenuEntry::Command("output.render_queue")), "Window › Render Queue");
        let edit = &m[2];
        assert_eq!(
            edit.items,
            vec![
                MenuEntry::Command("edit.undo"),
                MenuEntry::Command("edit.redo"),
                MenuEntry::Separator,
                MenuEntry::Command("edit.cut"),
                MenuEntry::Command("edit.copy"),
                MenuEntry::Command("edit.paste"),
                MenuEntry::Command("edit.copy_viewport"),
                MenuEntry::Command("edit.delete"),
                MenuEntry::Separator,
                MenuEntry::Command("model.duplicate"),
                MenuEntry::Command("edit.clone"),
                MenuEntry::Command("model.rotate"),
                MenuEntry::Separator,
                MenuEntry::Command("edit.select_all"),
                MenuEntry::Command("edit.select_none"),
                MenuEntry::Command("edit.hide"),
                MenuEntry::Command("edit.show_all"),
            ]
        );
        assert_eq!(
            m[1].items,
            vec![
                MenuEntry::Command("file.new"),
                MenuEntry::Command("file.open"),
                MenuEntry::Recent,
                MenuEntry::Separator,
                MenuEntry::Command("file.save"),
                MenuEntry::Command("file.save_as"),
                MenuEntry::Separator,
                MenuEntry::Command("file.export_ldraw"),
                MenuEntry::Command("file.export_plan"),
                MenuEntry::Command("file.export_submodels"),
            ]
        );
    }

    #[test]
    fn only_command_shortcuts_become_accelerators() {
        assert!(accelerator("⇧⌘Z").is_some());
        assert!(accelerator("⌘K").is_some());
        // Single keys stay with the window, so a text field can type them.
        assert!(accelerator("F").is_none());
        assert!(accelerator("⌫").is_none());
        assert!(accelerator("Esc").is_none());
    }

    #[test]
    fn text_editing_keys_go_to_the_field() {
        let typing = Ctx { text_focus: true, pieces: 3, can_undo: true, ..Default::default() };
        assert!(!menu_enabled(find("edit.select_all").unwrap(), &typing));
        assert!(!menu_enabled(find("edit.undo").unwrap(), &typing));
        let idle = Ctx { text_focus: false, ..typing };
        assert!(menu_enabled(find("edit.select_all").unwrap(), &idle));
    }
}
