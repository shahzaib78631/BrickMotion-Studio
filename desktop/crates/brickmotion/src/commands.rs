//! Every command the ribbon and Search commands show. Generated from final-locked.html's
//! ribbon and hover-card copy; the ribbon reads only this table.
use crate::{Icon, Workspace};

#[derive(Clone, Copy, Debug)]
pub struct Command {
    pub id: &'static str,
    pub title: &'static str,
    pub icon: Icon,
    pub shortcut: Option<&'static str>,
    pub tip: &'static str,
    pub workspace: Workspace,
    /// "" for commands that are not on the ribbon.
    pub tab: &'static str,
    pub group: &'static str,
    pub enabled: bool,
}

pub fn registry() -> &'static [Command] {
    &REGISTRY
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

static REGISTRY: [Command; 35] = [
    Command { id: "model.add_part", title: "Add Part", icon: Icon::Plus, shortcut: Some("P"), tip: "Pick a part from the library and place it on the studs under the pointer. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Insert", enabled: false },
    Command { id: "model.import", title: "Import", icon: Icon::Import, shortcut: Some("⌘O"), tip: "Open an LDraw or BrickMotion model.", workspace: Workspace::Build, tab: "Model", group: "Insert", enabled: true },
    Command { id: "model.inventory", title: "Inventory", icon: Icon::Inventory, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Insert", enabled: false },
    Command { id: "model.move", title: "Move", icon: Icon::Move, shortcut: Some("M"), tip: "Drag the selection along the arrows; it snaps to studs and holes. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Modify", enabled: false },
    Command { id: "model.rotate", title: "Rotate", icon: Icon::Rotate, shortcut: Some("R"), tip: "Turn the selection in 90° steps around its connection. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Modify", enabled: false },
    Command { id: "model.recolour", title: "Recolour", icon: Icon::Paint, shortcut: Some("C"), tip: "Apply a colour to every selected piece. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Modify", enabled: false },
    Command { id: "model.replace", title: "Replace", icon: Icon::Replace, shortcut: None, tip: "Swap the part, keeping position and colour. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Modify", enabled: false },
    Command { id: "model.duplicate", title: "Duplicate", icon: Icon::Copy, shortcut: Some("⌘D"), tip: "Copy the selection and place the copy. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Modify", enabled: false },
    Command { id: "model.submodel", title: "Submodel", icon: Icon::Group, shortcut: Some("⌥⌘G"), tip: "Turn the selection into a submodel used once. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Arrange", enabled: false },
    Command { id: "model.extract", title: "Extract", icon: Icon::Extract, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Arrange", enabled: false },
    Command { id: "model.to_step", title: "To Step", icon: Icon::Step, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Arrange", enabled: false },
    Command { id: "model.seat_loose", title: "Seat Loose", icon: Icon::Seat, shortcut: None, tip: "Find pieces that are not connected and seat them. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Fit", enabled: false },
    Command { id: "model.what_fits", title: "What Fits", icon: Icon::Search, shortcut: Some("F"), tip: "List parts builders usually put at this connection. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Fit", enabled: false },
    Command { id: "model.look", title: "Look", icon: Icon::Eye, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Configure", enabled: false },
    Command { id: "model.build_settings", title: "Build Settings", icon: Icon::Sliders, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Build, tab: "Model", group: "Configure", enabled: false },
    Command { id: "video.plan_build", title: "Plan Build", icon: Icon::Plan, shortcut: None, tip: "Work out the build order and flights for the video. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Plan", enabled: false },
    Command { id: "video.regenerate", title: "Regenerate", icon: Icon::Regen, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Plan", enabled: false },
    Command { id: "video.order", title: "Order", icon: Icon::Step, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Plan", enabled: false },
    Command { id: "video.staging", title: "Staging", icon: Icon::Stage, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Staging", enabled: false },
    Command { id: "video.straighten", title: "Straighten", icon: Icon::Rotate, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Staging", enabled: false },
    Command { id: "video.flights", title: "Flights", icon: Icon::Fly, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Staging", enabled: false },
    Command { id: "video.add_key", title: "Add Key", icon: Icon::Keys, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Keys", enabled: false },
    Command { id: "video.bake_flight", title: "Bake Flight", icon: Icon::Fly, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Keys", enabled: false },
    Command { id: "video.group", title: "Group", icon: Icon::Group, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Keys", enabled: false },
    Command { id: "video.camera_key", title: "Camera Key", icon: Icon::Cam, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Camera", enabled: false },
    Command { id: "video.auto_direct", title: "Auto-direct", icon: Icon::Wand, shortcut: None, tip: "Place camera keys that follow the build. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Camera", enabled: false },
    Command { id: "video.follow", title: "Follow", icon: Icon::Target, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Camera", enabled: false },
    Command { id: "video.snap_sound", title: "Snap Sound", icon: Icon::Wave, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Audio", enabled: false },
    Command { id: "video.mix", title: "Mix", icon: Icon::Sliders, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Build Video", group: "Audio", enabled: false },
    Command { id: "output.export_movie", title: "Export Movie", icon: Icon::Vid, shortcut: Some("⇧⌘E"), tip: "Render the build video with the current look. — coming soon", workspace: Workspace::Animate, tab: "Output", group: "Output", enabled: false },
    Command { id: "output.export_still", title: "Export Still", icon: Icon::Cam, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Output", group: "Output", enabled: false },
    Command { id: "output.render_queue", title: "Render Queue", icon: Icon::Queue, shortcut: None, tip: "Opens its options in the Properties panel. — coming soon", workspace: Workspace::Animate, tab: "Output", group: "Output", enabled: false },
    Command { id: "file.open", title: "Open…", icon: Icon::File, shortcut: Some("⌘O"), tip: "Open an LDraw model (.ldr, .mpd, .dat).", workspace: Workspace::Build, tab: "", group: "File", enabled: true },
    Command { id: "view.fit", title: "Fit All", icon: Icon::Fit, shortcut: Some("F"), tip: "Frame the whole model.", workspace: Workspace::Build, tab: "", group: "View", enabled: true },
    Command { id: "view.home", title: "Home View", icon: Icon::Home, shortcut: Some("H"), tip: "Return to the starting view.", workspace: Workspace::Build, tab: "", group: "View", enabled: true },
];
