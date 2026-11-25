//! BrickMotion desktop: a Rust/egui shell over the C++ engine.
mod app;
pub mod chrome;
pub mod commands;
pub mod document;
mod icons;
mod loader;
mod notices;
mod shortcuts;
mod snapshot;
pub mod support;
mod theme;
pub mod viewport;

pub use app::{Answer, BrickMotionApp, DialogRequest, Pending, Workspace};
pub use document::{DocState, save_to};
pub use loader::{Loaded, Loader, OPEN_EXTENSIONS, Warm, open_model};
pub use notices::Notice;
pub use snapshot::snapshot;
pub use commands::{Command, Ctx, Menu, Shortcut, When, find, registry, run, tabs};
pub use icons::{Icon, icon};
pub use theme::{Theme, apply};
