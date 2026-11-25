//! Our one stroke-icon family (16×16, 1.5-px strokes), drawn for BrickMotion.
use std::collections::HashMap;
use std::sync::OnceLock;

use egui::{Color32, Image, Rect, Response, Ui, Vec2};

macro_rules! icons {
    ($($v:ident => $f:literal),* $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum Icon { $($v),* }
        impl Icon {
            pub const ALL: &'static [Icon] = &[$(Icon::$v),*];
            pub fn name(self) -> &'static str { match self { $(Icon::$v => $f),* } }
            fn svg(self) -> &'static [u8] {
                match self { $(Icon::$v => include_bytes!(concat!("../assets/icons/", $f, ".svg"))),* }
            }
        }
    };
}

icons! {
    Brick => "brick", Plus => "plus", Minus => "minus", Import => "import", Inventory => "inventory",
    Move => "move", Rotate => "rotate", Paint => "paint", Replace => "replace", Copy => "copy",
    Group => "group", Extract => "extract", Step => "step", Seat => "seat", Search => "search",
    Eye => "eye", EyeOff => "eyeoff", Sliders => "sliders", Home => "home", Undo => "undo",
    Redo => "redo", Close => "close", Gear => "gear", Help => "help", Grip => "grip",
    Chevron => "chev", Down => "down", Up => "up", Orbit => "orbit", Pan => "pan", Fit => "fit",
    LookAt => "lookat", Sun => "sun", Layers => "layers", Cam => "cam", Keys => "keys",
    Wave => "wave", Fly => "fly", Plan => "plan", Regen => "regen", Stage => "stage",
    Wand => "wand", Vid => "vid", Queue => "queue", Target => "target", More => "more",
    Cursor => "cursor", Razor => "razor", Magnet => "magnet", Marker => "marker", Prev => "prev",
    Next => "next", Play => "playf", Pause => "pause", Loop => "loop", Pin => "pin", Back => "back",
    ChevUpDown => "chev_ud", File => "file",
}

/// The SVG with its strokes in white, so `tint` gives the final colour.
fn white(i: Icon) -> &'static [u8] {
    static CACHE: OnceLock<HashMap<Icon, &'static [u8]>> = OnceLock::new();
    CACHE.get_or_init(|| {
        Icon::ALL
            .iter()
            .map(|&i| {
                let s = String::from_utf8_lossy(i.svg()).replace("currentColor", "#ffffff");
                (i, &*Box::leak(s.into_bytes().into_boxed_slice()))
            })
            .collect()
    })[&i]
}

pub fn image(i: Icon, size: f32, tint: Color32) -> Image<'static> {
    Image::from_bytes(format!("bytes://icon/{}.svg", i.name()), white(i)).fit_to_exact_size(Vec2::splat(size)).tint(tint)
}

pub fn icon(ui: &mut Ui, i: Icon, size: f32, tint: Color32) -> Response {
    ui.add(image(i, size, tint))
}

/// Paints an icon centred in `rect` without taking layout space.
pub fn paint(ui: &Ui, i: Icon, rect: Rect, size: f32, tint: Color32) {
    image(i, size, tint).paint_at(ui, Rect::from_center_size(rect.center(), Vec2::splat(size)));
}
