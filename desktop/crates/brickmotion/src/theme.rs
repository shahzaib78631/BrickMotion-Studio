//! The calm theme, dark or light: one accent, one active mark, an 8-px grid. Every colour the
//! chrome draws comes from here; `tests/palette.rs` fails when a literal colour appears elsewhere.
use std::sync::{Arc, OnceLock};

use egui::{Color32, Context, CornerRadius, FontData, FontDefinitions, FontFamily, FontId, Stroke, TextStyle};

#[derive(Clone, Copy, Debug)]
pub struct Theme {
    pub bg0: Color32,
    pub bg1: Color32,
    pub bg2: Color32,
    pub bg3: Color32,
    pub border: Color32,
    pub border2: Color32,
    pub text1: Color32,
    pub text2: Color32,
    pub text3: Color32,
    pub accent: Color32,
    pub playhead: Color32,
    /// Destructive actions and errors; also the X axis.
    pub danger: Color32,
    /// Success and "saved"; also the Y axis.
    pub success: Color32,
    /// Warnings and attention marks (never the playhead orange).
    pub warning: Color32,
    /// Text and icons drawn on an accent fill.
    pub on_accent: Color32,
    /// The X, Y and Z axis colours of gizmos and the navigator.
    pub axis: [Color32; 3],
    /// Ink on the playhead's time flag.
    pub on_playhead: Color32,
    /// The bright knob of switches and sliders, and handle rims over the viewport.
    pub knob: Color32,
    /// A keyframe diamond at rest.
    pub key: Color32,
    /// A camera keyframe.
    pub camera_key: Color32,
    pub radius: f32,
    pub grid: f32,
    /// True for the dark appearance: overlays then lighten, otherwise they darken.
    pub dark: bool,
}

impl Theme {
    pub const DARK: Theme = Theme {
        bg0: Color32::from_rgb(0x14, 0x15, 0x18),
        bg1: Color32::from_rgb(0x1a, 0x1b, 0x1f),
        bg2: Color32::from_rgb(0x20, 0x22, 0x27),
        bg3: Color32::from_rgb(0x27, 0x2a, 0x30),
        border: Color32::from_rgb(0x2c, 0x2f, 0x36),
        border2: Color32::from_rgb(0x34, 0x38, 0x3f),
        text1: Color32::from_rgb(0xe8, 0xea, 0xed),
        text2: Color32::from_rgb(0xa4, 0xa9, 0xb1),
        text3: Color32::from_rgb(0x6c, 0x72, 0x7c),
        accent: Color32::from_rgb(0x4f, 0x8c, 0xff),
        playhead: Color32::from_rgb(0xff, 0x9f, 0x43),
        danger: Color32::from_rgb(0xe5, 0x48, 0x4d),
        success: Color32::from_rgb(0x30, 0xa4, 0x6c),
        warning: Color32::from_rgb(0xfe, 0xbc, 0x2e),
        on_accent: Color32::WHITE,
        axis: [Color32::from_rgb(0xe5, 0x48, 0x4d), Color32::from_rgb(0x30, 0xa4, 0x6c), Color32::from_rgb(0x4f, 0x8c, 0xff)],
        on_playhead: Color32::from_rgb(0x1a, 0x11, 0x00),
        knob: Color32::WHITE,
        key: Color32::from_rgb(0xc9, 0xcd, 0xd4),
        camera_key: Color32::from_rgb(0xe3, 0xc3, 0x6b),
        radius: 6.0,
        grid: 8.0,
        dark: true,
    };

    /// The light appearance: the tokens of the approved M7a mockup.
    pub const LIGHT: Theme = Theme {
        bg0: Color32::from_rgb(0xec, 0xee, 0xf2),
        bg1: Color32::from_rgb(0xf5, 0xf6, 0xf8),
        bg2: Color32::from_rgb(0xff, 0xff, 0xff),
        bg3: Color32::from_rgb(0xeb, 0xed, 0xf0),
        border: Color32::from_rgb(0xdc, 0xdf, 0xe6),
        border2: Color32::from_rgb(0xcf, 0xd4, 0xdd),
        text1: Color32::from_rgb(0x1a, 0x1c, 0x20),
        text2: Color32::from_rgb(0x4f, 0x56, 0x62),
        text3: Color32::from_rgb(0x7e, 0x86, 0x94),
        accent: Color32::from_rgb(0x2f, 0x6f, 0xe4),
        playhead: Color32::from_rgb(0xe0, 0x7b, 0x12),
        danger: Color32::from_rgb(0xd9, 0x2d, 0x33),
        success: Color32::from_rgb(0x1f, 0x8a, 0x55),
        warning: Color32::from_rgb(0xc9, 0x8a, 0x0e),
        on_accent: Color32::WHITE,
        axis: [Color32::from_rgb(0xd9, 0x2d, 0x33), Color32::from_rgb(0x1f, 0x8a, 0x55), Color32::from_rgb(0x2f, 0x6f, 0xe4)],
        on_playhead: Color32::from_rgb(0x1a, 0x11, 0x00),
        knob: Color32::WHITE,
        key: Color32::from_rgb(0x5f, 0x66, 0x73),
        camera_key: Color32::from_rgb(0xb4, 0x8a, 0x1e),
        radius: 6.0,
        grid: 8.0,
        dark: false,
    };

    /// A foreground overlay at `alpha` (hairlines, hover and pressed tints, faint tracks): white
    /// over the dark appearance, black over the light one.
    pub fn ink(&self, alpha: u8) -> Color32 {
        if self.dark { Color32::from_white_alpha(alpha) } else { Color32::from_black_alpha(((alpha as u16 * 3) / 4) as u8) }
    }

    /// A drop shadow or backdrop at `alpha`; lighter in the light appearance.
    pub fn shade(&self, alpha: u8) -> Color32 {
        Color32::from_black_alpha(if self.dark { alpha } else { alpha / 4 })
    }

    /// `c` at `alpha` (0–255), keeping its hue.
    pub fn alpha(c: Color32, alpha: u8) -> Color32 {
        Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), alpha)
    }

    /// The accent at `alpha`.
    pub fn accent_a(&self, alpha: u8) -> Color32 {
        Theme::alpha(self.accent, alpha)
    }

    /// A panel surface (`bg2`) at `alpha`, for cards floating over the viewport.
    pub fn surface(&self, alpha: u8) -> Color32 {
        Theme::alpha(self.bg2, alpha)
    }

    /// The accent at low strength, for "on" backgrounds.
    pub fn accent_bg(&self) -> Color32 {
        self.accent_a(38)
    }

    /// Fill of floating panels over the viewport.
    pub fn float_fill(&self) -> Color32 {
        self.surface(248)
    }
}

/// One entry of the theme catalogue (`theme_catalogue.rs`, written by `scripts/gen_themes.py`).
#[derive(Clone, Copy, Debug)]
pub struct ThemeDef {
    /// The id kept in preferences.
    pub id: &'static str,
    pub name: &'static str,
    pub theme: Theme,
    /// Whose published palette the colours come from, shown in About.
    pub credit: Option<&'static str>,
}

/// The preference id that follows the Mac's own appearance.
pub const MATCH_SYSTEM: &str = "system";

/// Every theme, Dark and Light first.
pub fn catalogue() -> &'static [ThemeDef] {
    crate::theme_catalogue::CATALOGUE
}

/// The theme for a preference id; `system` follows `system_dark`, and an unknown id is Dark.
pub fn resolve(id: &str, system_dark: bool) -> Theme {
    if id == MATCH_SYSTEM {
        return if system_dark { Theme::DARK } else { Theme::LIGHT };
    }
    catalogue().iter().find(|d| d.id == id).map(|d| d.theme).unwrap_or(Theme::DARK)
}

/// Viewport › Background › Studio: a neutral mid grey that suits every theme.
pub const STUDIO_BACKGROUND: Color32 = Color32::from_rgb(0x3c, 0x3f, 0x45);
/// Viewport › Background › Black.
pub const BLACK_BACKGROUND: Color32 = Color32::from_rgb(0x00, 0x00, 0x00);

/// The tint that draws an image in its own colours.
pub const NO_TINT: Color32 = Color32::WHITE;

/// Body text size, in points.
pub const TEXT: f32 = 12.5;
pub const SMALL: f32 = 10.5;

/// The Mac's own faces: SF Pro for text, Menlo Regular for crisp timecodes and numbers
/// (SFNSMono.ttf is a variable font whose default outline renders ultra-thin in ab_glyph),
/// and Apple Symbols for ⌘ ⇧ ⌥ ⌫. Missing files fall back to egui's bundled fonts.
fn fonts() -> FontDefinitions {
    fn system(file: &str) -> Option<&'static [u8]> {
        type Cache = std::sync::Mutex<std::collections::HashMap<String, Option<&'static [u8]>>>;
        static CACHE: OnceLock<Cache> = OnceLock::new();
        let mut map = CACHE.get_or_init(Default::default).lock().unwrap();
        *map.entry(file.to_owned()).or_insert_with(|| {
            std::fs::read(format!("/System/Library/Fonts/{file}")).ok().map(|b| &*Box::leak(b.into_boxed_slice()))
        })
    }
    let mut defs = FontDefinitions::default();
    let mut add = |name: &str, file: &str, family: FontFamily, first: bool| {
        if let Some(bytes) = system(file) {
            defs.font_data.insert(name.to_owned(), Arc::new(FontData::from_static(bytes)));
            let list = defs.families.entry(family).or_default();
            if first { list.insert(0, name.to_owned()) } else { list.push(name.to_owned()) }
        }
    };
    add("sf", "SFNS.ttf", FontFamily::Proportional, true);
    add("sf-mono", "SFNSMono.ttf", FontFamily::Monospace, true);
    add("menlo", "Menlo.ttc", FontFamily::Monospace, true);
    add("symbols", "Apple Symbols.ttf", FontFamily::Proportional, false);
    add("symbols-mono", "Apple Symbols.ttf", FontFamily::Monospace, false);
    defs
}

/// The theme `apply` last set on `ctx` (dark before the first call), for helpers that draw
/// without being handed one.
pub fn of(ctx: &Context) -> Theme {
    ctx.data(|d| d.get_temp::<Theme>(egui::Id::NULL.with("bm-theme"))).unwrap_or(Theme::DARK)
}

pub fn apply(ctx: &Context, t: &Theme) {
    ctx.data_mut(|d| d.insert_temp(egui::Id::NULL.with("bm-theme"), *t));
    ctx.set_fonts(fonts());
    let mode = if t.dark { egui::Theme::Dark } else { egui::Theme::Light };
    ctx.set_theme(mode);
    let r = CornerRadius::same(t.radius as u8);
    ctx.style_mut_of(mode, |s| {
        s.text_styles = [
            (TextStyle::Heading, FontId::new(15.0, FontFamily::Proportional)),
            (TextStyle::Body, FontId::new(TEXT, FontFamily::Proportional)),
            (TextStyle::Button, FontId::new(TEXT, FontFamily::Proportional)),
            (TextStyle::Small, FontId::new(SMALL, FontFamily::Proportional)),
            (TextStyle::Monospace, FontId::new(TEXT, FontFamily::Monospace)),
        ]
        .into();
        s.spacing.item_spacing = egui::vec2(t.grid, t.grid / 2.0);
        s.spacing.button_padding = egui::vec2(t.grid, 4.0);
        s.spacing.menu_margin = egui::Margin::same(6);
        s.spacing.interact_size.y = 28.0;
        let v = &mut s.visuals;
        v.dark_mode = t.dark;
        v.panel_fill = t.bg1;
        v.window_fill = if t.dark { Color32::from_rgba_unmultiplied(0x21, 0x23, 0x28, 252) } else { t.surface(252) };
        v.window_stroke = Stroke::new(1.0, if t.dark { Color32::from_rgb(0x3a, 0x3e, 0x47) } else { t.border2 });
        v.window_corner_radius = CornerRadius::same(10);
        v.menu_corner_radius = CornerRadius::same(10);
        v.popup_shadow = egui::Shadow {
            offset: [0, 8],
            blur: 24,
            spread: 0,
            color: t.shade(120),
        };
        v.extreme_bg_color = t.bg1;
        v.faint_bg_color = t.bg2;
        v.code_bg_color = t.bg2;
        v.hyperlink_color = t.accent;
        v.selection.bg_fill = t.accent;
        v.selection.stroke = Stroke::new(1.0, t.on_accent);
        let w = &mut v.widgets;
        for (wv, fill, fg) in [
            (&mut w.noninteractive, t.bg2, t.text2),
            (&mut w.inactive, t.bg2, t.text2),
            (&mut w.hovered, t.bg3, t.text1),
            (&mut w.active, t.bg3, t.text1),
            (&mut w.open, t.bg3, t.text1),
        ] {
            wv.bg_fill = fill;
            wv.weak_bg_fill = fill;
            wv.corner_radius = r;
            wv.fg_stroke = Stroke::new(1.0, fg);
            wv.bg_stroke = Stroke::new(1.0, t.border);
            wv.expansion = 0.0;
        }
        w.noninteractive.bg_stroke = Stroke::new(1.0, t.border);
        w.inactive.weak_bg_fill = Color32::TRANSPARENT;
        w.inactive.bg_stroke = Stroke::NONE;
        w.hovered.bg_stroke = Stroke::NONE;
        w.active.bg_stroke = Stroke::NONE;
    });
}
