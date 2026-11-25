//! BrickMotion desktop: a Rust/egui shell over the C++ engine.
mod app;
pub mod chrome;
mod commands;
mod icons;
mod theme;

pub use app::{BrickMotionApp, Workspace};
pub use commands::{Command, find, registry, tabs};
pub use icons::{Icon, icon};
pub use theme::{Theme, apply};
