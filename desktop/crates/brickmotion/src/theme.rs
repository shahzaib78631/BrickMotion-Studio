//! The calm dark theme: one accent, one active mark, an 8-px grid.
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
    pub radius: f32,
    pub grid: f32,
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
        radius: 6.0,
        grid: 8.0,
    };

    /// The accent at low strength, for "on" backgrounds.
    pub fn accent_bg(&self) -> Color32 {
        Color32::from_rgba_unmultiplied(0x4f, 0x8c, 0xff, 38)
    }

    /// Fill of floating panels over the viewport.
    pub fn float_fill(&self) -> Color32 {
        Color32::from_rgba_unmultiplied(0x20, 0x22, 0x27, 248)
    }
}

/// Body text size, in points.
pub const TEXT: f32 = 12.5;
pub const SMALL: f32 = 10.5;

/// The Mac's own faces: SF Pro for text, SF Mono for timecodes, Apple Symbols for ⌘ ⇧ ⌥.
/// Missing files (another OS, a stripped system) fall back to egui's bundled fonts.
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
    add("symbols", "Apple Symbols.ttf", FontFamily::Proportional, false);
    add("symbols-mono", "Apple Symbols.ttf", FontFamily::Monospace, false);
    defs
}

pub fn apply(ctx: &Context, t: &Theme) {
    ctx.set_fonts(fonts());
    ctx.set_theme(egui::Theme::Dark);
    let r = CornerRadius::same(t.radius as u8);
    ctx.style_mut_of(egui::Theme::Dark, |s| {
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
        s.spacing.interact_size.y = 28.0;
        let v = &mut s.visuals;
        v.dark_mode = true;
        v.panel_fill = t.bg1;
        v.window_fill = t.bg2;
        v.window_stroke = Stroke::new(1.0, t.border2);
        v.window_corner_radius = CornerRadius::same(10);
        v.menu_corner_radius = CornerRadius::same(9);
        v.extreme_bg_color = t.bg1;
        v.faint_bg_color = t.bg2;
        v.code_bg_color = t.bg2;
        v.hyperlink_color = t.accent;
        v.selection.bg_fill = t.accent;
        v.selection.stroke = Stroke::new(1.0, Color32::WHITE);
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
