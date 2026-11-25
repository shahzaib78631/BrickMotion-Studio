//! BrickMotion desktop: a Rust/egui shell over the C++ engine.
mod app;
pub mod chrome;
mod commands;
mod icons;
mod loader;
mod notices;
mod snapshot;
mod theme;
pub mod viewport;

pub use app::{BrickMotionApp, Workspace};
pub use loader::{Loaded, Loader, OPEN_EXTENSIONS, Warm, open_model};
pub use notices::Notice;
pub use snapshot::snapshot;
pub use commands::{Command, find, registry, tabs};
pub use icons::{Icon, icon};
pub use theme::{Theme, apply};
