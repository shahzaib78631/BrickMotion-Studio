//! Every command, the state each needs, and the one dispatcher the ribbon, palette, shortcuts and
//! menu bar all call. The ribbon rows come from final-locked.html's ribbon and hover-card copy.
use egui::{Key, Modifiers};

use crate::{BrickMotionApp, Icon, Workspace};

/// When a command can run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum When {
    Always,
    /// A document is open (a new one counts).
    Document,
    /// The document has pieces.
    Pieces,
    /// Something is selected.
    Selection,
    CanUndo,
    CanRedo,
    /// Not built yet: shown dimmed with " — coming soon".
    Soon,
}

/// The native menu a command sits in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Menu {
    App,
    File,
    Edit,
    View,
    None,
}

#[derive(Clone, Copy, Debug)]
pub struct Command {
    pub id: &'static str,
    pub title: &'static str,
    pub icon: Icon,
    /// Written as the menus show it: "⇧⌘Z", "F", "⌫", "Esc". Always parses.
    pub keys: Option<&'static str>,
    pub tip: &'static str,
    pub workspace: Workspace,
    /// "" for commands that are not on the ribbon.
    pub tab: &'static str,
    pub group: &'static str,
    pub when: When,
    pub menu: Menu,
}

/// The state commands are enabled from, built once per frame.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Ctx {
    pub has_document: bool,
    pub pieces: usize,
    pub selected: usize,
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_name: String,
    pub redo_name: String,
    /// A text field has keyboard focus: single keys belong to it.
    pub text_focus: bool,
    pub local_axes: bool,
    pub collision: bool,
    pub tool: crate::edit::Tool,
}

/// A key with its modifiers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Shortcut {
    pub key: Key,
    pub mods: Modifiers,
}

impl Shortcut {
    /// "⇧⌘Z", "⌥⌘G", "⌘K", "F", "⌫", "Esc".
    pub fn parse(s: &str) -> Option<Shortcut> {
        let mut mods = Modifiers::NONE;
        let mut rest = s;
        loop {
            let mut chars = rest.chars();
            match chars.next() {
                Some('⇧') => mods.shift = true,
                // `command` alone: egui matches it to ⌘ on a Mac (and Ctrl elsewhere).
                Some('⌘') => mods.command = true,
                Some('⌥') => mods.alt = true,
                Some('⌃') => mods.ctrl = true,
                _ => break,
            }
            rest = chars.as_str();
        }
        let key = match rest {
            "⌫" => Key::Backspace,
            "Esc" => Key::Escape,
            "←" => Key::ArrowLeft,
            "→" => Key::ArrowRight,
            "↑" => Key::ArrowUp,
            "↓" => Key::ArrowDown,
            "" => return None,
            k => Key::from_name(k)?,
        };
        Some(Shortcut { key, mods })
    }

    /// The shortcut as menus show it.
    pub fn label(&self) -> String {
        let mut out = String::new();
        if self.mods.ctrl {
            out.push('⌃');
        }
        if self.mods.alt {
            out.push('⌥');
        }
        if self.mods.shift {
            out.push('⇧');
        }
        if self.mods.command {
            out.push('⌘');
        }
        out.push_str(match self.key {
            Key::Backspace => "⌫",
            Key::Escape => "Esc",
            Key::ArrowLeft => "←",
            Key::ArrowRight => "→",
            Key::ArrowUp => "↑",
            Key::ArrowDown => "↓",
            k => k.name(),
        });
        out
    }

    /// How many modifiers it holds; more specific shortcuts are matched first.
    pub fn specificity(&self) -> usize {
        [self.mods.shift, self.mods.command, self.mods.alt, self.mods.ctrl].iter().filter(|b| **b).count()
    }
}

pub fn enabled(c: &Command, ctx: &Ctx) -> bool {
    match c.when {
        When::Always => true,
        When::Document => ctx.has_document,
        When::Pieces => ctx.pieces > 0,
        When::Selection => ctx.selected > 0,
        When::CanUndo => ctx.can_undo,
        When::CanRedo => ctx.can_redo,
        When::Soon => false,
    }
}

/// Why a command is disabled, for the palette; None when it is enabled.
pub fn why_disabled(c: &Command, ctx: &Ctx) -> Option<&'static str> {
    if enabled(c, ctx) {
        return None;
    }
    Some(match c.when {
        When::Document => "Needs a document",
        When::Pieces => "Needs a model with pieces",
        When::Selection => "Needs a selection",
        When::CanUndo => "Nothing to undo",
        When::CanRedo => "Nothing to redo",
        _ => "Coming soon",
    })
}

/// The command's title now: "Undo Delete" names the edit undo would take back.
pub fn title(c: &Command, ctx: &Ctx) -> String {
    let named = |base: &str, name: &str| if name.is_empty() { base.to_owned() } else { format!("{base} {name}") };
    match c.id {
        "edit.undo" => named("Undo", &ctx.undo_name),
        "edit.redo" => named("Redo", &ctx.redo_name),
        "view.local_axes" => if ctx.local_axes { "Local Axes" } else { "World Axes" }.to_owned(),
        "edit.collision" => if ctx.collision { "Collision Checks On" } else { "Collision Checks Off" }.to_owned(),
        _ => c.title.to_owned(),
    }
}

/// The only way a command runs. False for an unknown or disabled id.
pub fn run(app: &mut BrickMotionApp, id: &str) -> bool {
    let Some(c) = find(id) else { return false };
    // Nothing runs behind "Save changes?".
    if app.confirm.is_some() || !enabled(c, &app.ctx()) {
        return false;
    }
    app.execute(c.id)
}

pub fn registry() -> &'static [Command] {
    REGISTRY
}

pub fn find(id: &str) -> Option<&'static Command> {
    REGISTRY.iter().find(|c| c.id == id)
}

/// The ribbon tabs of each workspace, in order.
pub fn tabs(w: Workspace) -> &'static [&'static str] {
    match w {
        Workspace::Build => &["Model", "Parts", "Steps", "Inspect", "Suggest", "View"],
        Workspace::Animate => &["Build Video", "Keyframes", "Camera", "Motion", "Sound", "Output"],
    }
}

static REGISTRY: &[Command] = &[
    Command { id: "model.add_part", title: "Add Part", icon: Icon::Plus, keys: Some("P"), tip: "Pick a part from the library and place it on the studs under the pointer.", workspace: Workspace::Build, tab: "Model", group: "Insert", when: When::Document, menu: Menu::None },
    Command { id: "model.import", title: "Import", icon: Icon::Import, keys: None, tip: "Open an LDraw or BrickMotion model.", workspace: Workspace::Build, tab: "Model", group: "Insert", when: When::Always, menu: Menu::None },
    Command { id: "model.inventory", title: "Inventory", icon: Icon::Inventory, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Insert", when: When::Soon, menu: Menu::None },
    Command { id: "model.move", title: "Move", icon: Icon::Move, keys: Some("M"), tip: "Drag the selection along the arrows; it snaps to studs and holes.", workspace: Workspace::Build, tab: "Model", group: "Modify", when: When::Document, menu: Menu::None },
    Command { id: "model.rotate", title: "Turn", icon: Icon::Rotate, keys: Some("R"), tip: "Turn the selection 90° clockwise around its centre.", workspace: Workspace::Build, tab: "Model", group: "Modify", when: When::Selection, menu: Menu::Edit },
    Command { id: "model.recolour", title: "Recolour", icon: Icon::Paint, keys: None, tip: "Apply a colour to every selected piece.", workspace: Workspace::Build, tab: "Model", group: "Modify", when: When::Selection, menu: Menu::None },
    Command { id: "model.replace", title: "Replace", icon: Icon::Replace, keys: None, tip: "Swap the part, keeping position and colour. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Modify", when: When::Soon, menu: Menu::None },
    Command { id: "model.duplicate", title: "Duplicate", icon: Icon::Copy, keys: Some("⌘D"), tip: "Copy the selection and offset the copy by one stud.", workspace: Workspace::Build, tab: "Model", group: "Modify", when: When::Selection, menu: Menu::Edit },
    Command { id: "model.submodel", title: "Submodel", icon: Icon::Group, keys: Some("⌥⌘G"), tip: "Turn the selection into a submodel used once. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Arrange", when: When::Soon, menu: Menu::None },
    Command { id: "model.extract", title: "Extract", icon: Icon::Extract, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Arrange", when: When::Soon, menu: Menu::None },
    Command { id: "model.to_step", title: "To Step", icon: Icon::Step, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Arrange", when: When::Soon, menu: Menu::None },
    Command { id: "model.seat_loose", title: "Seat Loose", icon: Icon::Seat, keys: None, tip: "Find pieces that are not connected and seat them. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Fit", when: When::Soon, menu: Menu::None },
    Command { id: "model.what_fits", title: "What Fits", icon: Icon::Search, keys: None, tip: "List parts builders usually put at this connection. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Fit", when: When::Soon, menu: Menu::None },
    Command { id: "model.look", title: "Look", icon: Icon::Eye, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Configure", when: When::Soon, menu: Menu::None },
    Command { id: "model.build_settings", title: "Build Settings", icon: Icon::Sliders, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Configure", when: When::Soon, menu: Menu::None },
    Command { id: "video.plan_build", title: "Plan Build", icon: Icon::Plan, keys: None, tip: "Work out the build order and flights for the video. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Plan", when: When::Soon, menu: Menu::None },
    Command { id: "video.regenerate", title: "Regenerate", icon: Icon::Regen, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Plan", when: When::Soon, menu: Menu::None },
    Command { id: "video.order", title: "Order", icon: Icon::Step, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Plan", when: When::Soon, menu: Menu::None },
    Command { id: "video.staging", title: "Staging", icon: Icon::Stage, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Staging", when: When::Soon, menu: Menu::None },
    Command { id: "video.straighten", title: "Straighten", icon: Icon::Rotate, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Staging", when: When::Soon, menu: Menu::None },
    Command { id: "video.flights", title: "Flights", icon: Icon::Fly, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Staging", when: When::Soon, menu: Menu::None },
    Command { id: "video.add_key", title: "Add Key", icon: Icon::Keys, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Keys", when: When::Soon, menu: Menu::None },
    Command { id: "video.bake_flight", title: "Bake Flight", icon: Icon::Fly, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Keys", when: When::Soon, menu: Menu::None },
    Command { id: "video.group", title: "Group", icon: Icon::Group, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Keys", when: When::Soon, menu: Menu::None },
    Command { id: "video.camera_key", title: "Camera Key", icon: Icon::Cam, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Camera", when: When::Soon, menu: Menu::None },
    Command { id: "video.auto_direct", title: "Auto-direct", icon: Icon::Wand, keys: None, tip: "Place camera keys that follow the build. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Camera", when: When::Soon, menu: Menu::None },
    Command { id: "video.follow", title: "Follow", icon: Icon::Target, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Camera", when: When::Soon, menu: Menu::None },
    Command { id: "video.snap_sound", title: "Snap Sound", icon: Icon::Wave, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Audio", when: When::Soon, menu: Menu::None },
    Command { id: "video.mix", title: "Mix", icon: Icon::Sliders, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Audio", when: When::Soon, menu: Menu::None },
    Command { id: "output.export_movie", title: "Export Movie", icon: Icon::Vid, keys: Some("⇧⌘E"), tip: "Render the build video with the current look. — coming soon", workspace: Workspace::Animate, tab: "Output", group: "Output", when: When::Soon, menu: Menu::None },
    Command { id: "output.export_still", title: "Export Still", icon: Icon::Cam, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Output", group: "Output", when: When::Soon, menu: Menu::None },
    Command { id: "output.render_queue", title: "Render Queue", icon: Icon::Queue, keys: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Output", group: "Output", when: When::Soon, menu: Menu::None },
    Command { id: "file.open", title: "Open…", icon: Icon::File, keys: Some("⌘O"), tip: "Open a BrickMotion project or an LDraw model.", workspace: Workspace::Build, tab: "", group: "File", when: When::Always, menu: Menu::File },
    Command { id: "view.fit", title: "Fit All", icon: Icon::Fit, keys: Some("F"), tip: "Frame the whole model.", workspace: Workspace::Build, tab: "", group: "View", when: When::Always, menu: Menu::View },
    Command { id: "view.home", title: "Home View", icon: Icon::Home, keys: Some("H"), tip: "Return to the starting view.", workspace: Workspace::Build, tab: "", group: "View", when: When::Always, menu: Menu::View },
    Command { id: "app.settings", title: "Settings…", icon: Icon::Gear, keys: None, tip: "Autosave and backup settings. — coming soon", workspace: Workspace::Build, tab: "", group: "App", when: When::Soon, menu: Menu::App },
    Command { id: "app.quit", title: "Quit BrickMotion", icon: Icon::Close, keys: Some("⌘Q"), tip: "Quit, asking to save an edited document first.", workspace: Workspace::Build, tab: "", group: "App", when: When::Always, menu: Menu::App },
    Command { id: "file.new", title: "New", icon: Icon::Plus, keys: Some("⌘N"), tip: "Start an empty project.", workspace: Workspace::Build, tab: "", group: "File", when: When::Always, menu: Menu::File },
    Command { id: "file.save", title: "Save", icon: Icon::Down, keys: Some("⌘S"), tip: "Save the project as a .brickmotion file.", workspace: Workspace::Build, tab: "", group: "File", when: When::Document, menu: Menu::File },
    Command { id: "file.save_as", title: "Save As…", icon: Icon::Down, keys: Some("⇧⌘S"), tip: "Save the project under a new name.", workspace: Workspace::Build, tab: "", group: "File", when: When::Document, menu: Menu::File },
    Command { id: "edit.undo", title: "Undo", icon: Icon::Undo, keys: Some("⌘Z"), tip: "Undo the last edit.", workspace: Workspace::Build, tab: "", group: "Edit", when: When::CanUndo, menu: Menu::Edit },
    Command { id: "edit.redo", title: "Redo", icon: Icon::Redo, keys: Some("⇧⌘Z"), tip: "Redo the edit you undid.", workspace: Workspace::Build, tab: "", group: "Edit", when: When::CanRedo, menu: Menu::Edit },
    Command { id: "edit.delete", title: "Delete", icon: Icon::Close, keys: Some("⌫"), tip: "Delete the selected pieces.", workspace: Workspace::Build, tab: "", group: "Edit", when: When::Selection, menu: Menu::Edit },
    Command { id: "edit.select_all", title: "Select All", icon: Icon::Cursor, keys: Some("⌘A"), tip: "Select every piece that is not hidden.", workspace: Workspace::Build, tab: "", group: "Edit", when: When::Pieces, menu: Menu::Edit },
    Command { id: "edit.select_none", title: "Select None", icon: Icon::Cursor, keys: Some("Esc"), tip: "Clear the selection.", workspace: Workspace::Build, tab: "", group: "Edit", when: When::Selection, menu: Menu::Edit },
    Command { id: "edit.hide", title: "Hide Selection", icon: Icon::EyeOff, keys: None, tip: "Hide the selected pieces until Show All.", workspace: Workspace::Build, tab: "", group: "Edit", when: When::Selection, menu: Menu::Edit },
    Command { id: "edit.show_all", title: "Show All", icon: Icon::Eye, keys: None, tip: "Show every hidden piece.", workspace: Workspace::Build, tab: "", group: "Edit", when: When::Pieces, menu: Menu::Edit },
    Command { id: "view.frame_selection", title: "Frame Selection", icon: Icon::LookAt, keys: Some("⌘F"), tip: "Frame the selected pieces.", workspace: Workspace::Build, tab: "", group: "View", when: When::Selection, menu: Menu::View },
    Command { id: "view.palette", title: "Command Palette…", icon: Icon::Search, keys: Some("⌘K"), tip: "Find any command by name.", workspace: Workspace::Build, tab: "", group: "View", when: When::Always, menu: Menu::View },
    Command { id: "tool.select", title: "Select Tool", icon: Icon::Cursor, keys: Some("V"), tip: "Pick pieces in the viewport.", workspace: Workspace::Build, tab: "", group: "Tools", when: When::Document, menu: Menu::None },
    Command { id: "model.rotate_tool", title: "Rotate Tool", icon: Icon::Rotate, keys: None, tip: "Turn the selection interactively with the rotate rings.", workspace: Workspace::Build, tab: "", group: "Tools", when: When::Document, menu: Menu::None },
    Command { id: "model.rotate_back", title: "Turn Back", icon: Icon::Rotate, keys: Some("⇧R"), tip: "Turn the selection 90° anticlockwise around its centre.", workspace: Workspace::Build, tab: "", group: "Modify", when: When::Selection, menu: Menu::None },
    Command { id: "edit.clone", title: "Clone", icon: Icon::Copy, keys: Some("C"), tip: "Duplicate the selection in place.", workspace: Workspace::Build, tab: "", group: "Edit", when: When::Selection, menu: Menu::Edit },
    Command { id: "edit.raise", title: "Raise", icon: Icon::Up, keys: Some("E"), tip: "Raise the selection by one plate (hold ⌥ for one brick).", workspace: Workspace::Build, tab: "", group: "Edit", when: When::Selection, menu: Menu::None },
    Command { id: "edit.lower", title: "Lower", icon: Icon::Down, keys: Some("Q"), tip: "Lower the selection by one plate (hold ⌥ for one brick).", workspace: Workspace::Build, tab: "", group: "Edit", when: When::Selection, menu: Menu::None },
    Command { id: "edit.nudge_left", title: "Nudge Left", icon: Icon::Move, keys: Some("←"), tip: "Move the selection one stud left along the view.", workspace: Workspace::Build, tab: "", group: "Edit", when: When::Selection, menu: Menu::None },
    Command { id: "edit.nudge_right", title: "Nudge Right", icon: Icon::Move, keys: Some("→"), tip: "Move the selection one stud right along the view.", workspace: Workspace::Build, tab: "", group: "Edit", when: When::Selection, menu: Menu::None },
    Command { id: "edit.nudge_up", title: "Nudge Forward", icon: Icon::Move, keys: Some("↑"), tip: "Move the selection one stud away from the view.", workspace: Workspace::Build, tab: "", group: "Edit", when: When::Selection, menu: Menu::None },
    Command { id: "edit.nudge_down", title: "Nudge Back", icon: Icon::Move, keys: Some("↓"), tip: "Move the selection one stud toward the view.", workspace: Workspace::Build, tab: "", group: "Edit", when: When::Selection, menu: Menu::None },
    Command { id: "edit.copy", title: "Copy", icon: Icon::Copy, keys: Some("⌘C"), tip: "Copy the selected pieces to the clipboard.", workspace: Workspace::Build, tab: "", group: "Edit", when: When::Selection, menu: Menu::Edit },
    Command { id: "edit.cut", title: "Cut", icon: Icon::Razor, keys: Some("⌘X"), tip: "Copy the selected pieces to the clipboard and delete them.", workspace: Workspace::Build, tab: "", group: "Edit", when: When::Selection, menu: Menu::Edit },
    Command { id: "edit.paste", title: "Paste", icon: Icon::Plus, keys: Some("⌘V"), tip: "Paste pieces from the clipboard.", workspace: Workspace::Build, tab: "", group: "Edit", when: When::Document, menu: Menu::Edit },
    Command { id: "view.local_axes", title: "Local Axes", icon: Icon::Target, keys: Some("L"), tip: "Switch the gizmo between local and world axes.", workspace: Workspace::Build, tab: "", group: "View", when: When::Document, menu: Menu::None },
    Command { id: "edit.collision", title: "Collision Checks", icon: Icon::Magnet, keys: Some("K"), tip: "Turn collision checks on or off while placing parts.", workspace: Workspace::Build, tab: "", group: "Edit", when: When::Document, menu: Menu::None },
];
