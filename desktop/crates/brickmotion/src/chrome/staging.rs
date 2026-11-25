//! Build Staging Properties page (m4-rulings.md: v3 without the preview).
use bm::settings::{GROUPS, LAYOUTS, MATCHES, SIDES, StagingSettings};
use egui::{Color32, CornerRadius, Frame, Margin, Rect, RichText, Sense, Stroke, Ui, WidgetInfo, pos2, vec2};

use super::widgets::{
    SliderEvent, accent_button, footnote, hairline, inset_group, page_footer, parse_number, popup_row,
    secondary_button, section_header, slider_row, switch_row,
};
use crate::BrickMotionApp;
use crate::theme::Theme;

/// Local draft for Build Staging; committed in one undo step when Apply is clicked.
pub struct StagingState {
    pub draft: StagingSettings,
    pub turn: f64,
    pub straighten: bool,
    synced_gen: Option<u64>,
    synced_ver: Option<u64>,
    dirty: bool,
}

impl Default for StagingState {
    fn default() -> Self {
        Self {
            draft: StagingSettings::default(),
            turn: 0.0,
            straighten: false,
            synced_gen: None,
            synced_ver: None,
            dirty: false,
        }
    }
}

impl StagingState {
    pub fn reset(&mut self) {
        self.synced_gen = None;
        self.synced_ver = None;
        self.turn = 0.0;
        self.straighten = false;
        self.dirty = false;
    }

    fn sync(&mut self, session: &bm::Session) {
        let doc_gen = session.generation();
        let ver = session.version();
        if self.synced_gen != Some(doc_gen) || (!self.dirty && self.synced_ver != Some(ver)) {
            self.draft = session.staging_settings();
            self.turn = 0.0;
            self.straighten = false;
            self.synced_gen = Some(doc_gen);
            self.synced_ver = Some(ver);
            self.dirty = false;
        }
    }

    fn is_edited(&self, saved: &StagingSettings) -> bool {
        let aspect_diff = self.draft.layout == "camera-frame" && (self.draft.aspect - saved.aspect).abs() > 1e-3;
        self.draft.layout != saved.layout
            || self.draft.group != saved.group
            || self.draft.sides != saved.sides
            || self.draft.match_ != saved.match_
            || aspect_diff
            || self.turn.abs() > 1e-4
            || self.straighten
    }
}

const LAYOUT_TITLES: [&str; 9] = [
    "Packed",
    "Spaced",
    "Grid",
    "Rows",
    "Scattered",
    "Showcase",
    "Gallery",
    "Fan",
    "Camera Frame",
];

const GROUP_TITLES: [&str; 5] = ["By Step", "By Colour", "By Part", "By Size", "All at Once"];
const SIDE_TITLES: [&str; 5] = ["Front and Back", "Front", "Behind", "Left and Right", "All Around"];
const MATCH_TITLES: [&str; 2] = ["Fill in Order", "Nearest to Final Position"];

const FRAME_PRESETS: [(&str, f64); 4] = [
    ("Landscape · 16:9", 16.0 / 9.0),
    ("Square · 1:1", 1.0),
    ("Portrait · 4:5", 4.0 / 5.0),
    ("Vertical · 9:16", 9.0 / 16.0),
];

/// Exact 25×15 layout tile blocks from `StagingSheet.swift:15-23`.
fn layout_rects(id: &str) -> &'static [(f32, f32, f32, f32)] {
    match id {
        "packed" => &[
            (0.0, 0.0, 10.0, 4.0),
            (11.0, 0.0, 5.0, 4.0),
            (17.0, 0.0, 8.0, 4.0),
            (0.0, 5.0, 6.0, 4.0),
            (7.0, 5.0, 8.0, 4.0),
            (16.0, 5.0, 6.0, 4.0),
            (0.0, 10.0, 14.0, 4.0),
            (15.0, 10.0, 7.0, 4.0),
        ],
        "spaced" => &[
            (1.0, 0.0, 7.0, 3.0),
            (14.0, 0.0, 6.0, 3.0),
            (3.0, 6.0, 5.0, 3.0),
            (12.0, 6.0, 9.0, 3.0),
            (1.0, 12.0, 8.0, 3.0),
            (16.0, 12.0, 5.0, 3.0),
        ],
        "grid" => &[
            (1.0, 0.0, 5.0, 3.0),
            (9.0, 0.0, 5.0, 3.0),
            (17.0, 0.0, 5.0, 3.0),
            (1.0, 5.0, 5.0, 3.0),
            (9.0, 5.0, 5.0, 3.0),
            (17.0, 5.0, 5.0, 3.0),
            (1.0, 10.0, 5.0, 3.0),
            (9.0, 10.0, 5.0, 3.0),
            (17.0, 10.0, 5.0, 3.0),
        ],
        "rows" => &[
            (1.0, 2.0, 4.0, 3.0),
            (7.0, 2.0, 4.0, 3.0),
            (13.0, 2.0, 4.0, 3.0),
            (19.0, 2.0, 4.0, 3.0),
            (1.0, 10.0, 4.0, 3.0),
            (7.0, 10.0, 4.0, 3.0),
            (13.0, 10.0, 4.0, 3.0),
            (19.0, 10.0, 4.0, 3.0),
        ],
        "scattered" => &[
            (2.0, 1.0, 7.0, 3.0),
            (12.0, 0.0, 4.0, 3.0),
            (19.0, 3.0, 5.0, 3.0),
            (1.0, 7.0, 5.0, 3.0),
            (9.0, 8.0, 8.0, 3.0),
            (17.0, 12.0, 7.0, 3.0),
            (4.0, 13.0, 6.0, 2.0),
        ],
        "showcase" => &[
            (5.0, 0.0, 6.0, 3.0),
            (13.0, 0.0, 7.0, 3.0),
            (0.0, 6.0, 5.0, 3.0),
            (7.0, 6.0, 5.0, 3.0),
            (14.0, 6.0, 4.0, 3.0),
            (20.0, 6.0, 5.0, 3.0),
            (6.0, 12.0, 6.0, 3.0),
            (14.0, 12.0, 5.0, 3.0),
        ],
        "gallery" => &[
            (6.0, 0.0, 5.0, 3.0),
            (14.0, 0.0, 5.0, 3.0),
            (3.0, 6.0, 6.0, 3.0),
            (11.0, 6.0, 6.0, 3.0),
            (19.0, 6.0, 4.0, 3.0),
            (6.0, 12.0, 6.0, 3.0),
            (14.0, 12.0, 5.0, 3.0),
        ],
        "fan" => &[
            (9.0, 1.0, 7.0, 3.0),
            (3.0, 4.0, 5.0, 3.0),
            (17.0, 4.0, 5.0, 3.0),
            (0.0, 9.0, 5.0, 3.0),
            (7.0, 10.0, 5.0, 3.0),
            (14.0, 10.0, 5.0, 3.0),
            (21.0, 9.0, 4.0, 3.0),
        ],
        _ => &[
            (6.0, 2.0, 5.0, 3.0),
            (14.0, 2.0, 5.0, 3.0),
            (3.0, 7.0, 5.0, 3.0),
            (18.0, 7.0, 5.0, 3.0),
            (7.0, 11.0, 5.0, 3.0),
            (14.0, 11.0, 5.0, 3.0),
        ],
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, body_max_h: f32) {
    let t = app.theme;
    app.staging.sync(app.doc.session());
    let saved = app.doc.session().staging_settings();
    let adjusted = app.doc.session().moved_waiting_parts();

    let mut do_apply = false;
    let mut do_revert = false;

    let scroll_h = (body_max_h - 48.0).max(120.0);
    egui::ScrollArea::vertical()
        .id_salt("staging-scroll")
        .max_height(scroll_h)
        .auto_shrink([false, true])
        .show(ui, |ui| {
            let st = &mut app.staging;

            // 1. Layout 3×3 tile grid
            let layout_idx = LAYOUTS.iter().position(|&l| l == st.draft.layout).unwrap_or(0);
            section_header(ui, &t, "Layout", Some(LAYOUT_TITLES[layout_idx]));

            Frame::NONE.outer_margin(Margin::symmetric(12, 0)).show(ui, |ui| {
                let gap = 6.0;
                let tile_w = ((ui.available_width() - 2.0 * gap) / 3.0).max(60.0);
                let tile_h = (tile_w / 1.6).round();
                ui.spacing_mut().item_spacing = vec2(gap, gap);
                for row in 0..3 {
                    ui.horizontal(|ui| {
                        for col in 0..3 {
                            let idx = row * 3 + col;
                            let id = LAYOUTS[idx];
                            let title = LAYOUT_TITLES[idx];
                            let chosen = st.draft.layout == id;
                            if layout_tile(ui, &t, id, title, chosen, vec2(tile_w, tile_h)) {
                                st.draft.layout = id.to_owned();
                                st.dirty = true;
                            }
                        }
                    });
                }
            });

            // 2. Waiting Parts inset group
            section_header(ui, &t, "Waiting Parts", None);
            inset_group(ui, |ui| {
                let mut gi = GROUPS.iter().position(|&g| g == st.draft.group).unwrap_or(0);
                if popup_row(ui, &t, "st-group", "Group", GROUP_TITLES[gi], &GROUP_TITLES, &mut gi, true) {
                    st.draft.group = GROUPS[gi].to_owned();
                    st.dirty = true;
                }
                hairline(ui);

                let mut si = SIDES.iter().position(|&s| s == st.draft.sides).unwrap_or(0);
                if popup_row(ui, &t, "st-sides", "Position", SIDE_TITLES[si], &SIDE_TITLES, &mut si, true) {
                    st.draft.sides = SIDES[si].to_owned();
                    st.dirty = true;
                }
                hairline(ui);

                let mut mi = MATCHES.iter().position(|&m| m == st.draft.match_).unwrap_or(0);
                if popup_row(ui, &t, "st-match", "Order", MATCH_TITLES[mi], &MATCH_TITLES, &mut mi, true) {
                    st.draft.match_ = MATCHES[mi].to_owned();
                    st.dirty = true;
                }
                hairline(ui);

                match slider_row(
                    ui,
                    &t,
                    "st-turn",
                    "Turn",
                    &mut st.turn,
                    -180.0..=180.0,
                    5.0,
                    |v| format!("{v:.0}°"),
                    parse_number,
                    true,
                ) {
                    SliderEvent::Changing | SliderEvent::Committed(_) => {
                        st.dirty = true;
                    }
                    SliderEvent::None => {}
                }
                hairline(ui);

                let frame_on = st.draft.layout == "camera-frame";
                let preset_match = FRAME_PRESETS
                    .iter()
                    .position(|&(_, a)| (a - st.draft.aspect).abs() < 0.02);
                let mut fi = preset_match.unwrap_or(FRAME_PRESETS.len());
                let frame_options: Vec<&str> = if preset_match.is_some() {
                    FRAME_PRESETS.iter().map(|(l, _)| *l).collect()
                } else {
                    let mut opts: Vec<&str> = FRAME_PRESETS.iter().map(|(l, _)| *l).collect();
                    opts.push("Project Frame Shape");
                    opts
                };
                let cur_label = frame_options.get(fi).copied().unwrap_or("Project Frame Shape");
                if popup_row(ui, &t, "st-frame", "Frame", cur_label, &frame_options, &mut fi, frame_on)
                    && let Some(&(_, aspect)) = FRAME_PRESETS.get(fi)
                {
                    st.draft.aspect = aspect;
                    st.dirty = true;
                }
            });

            // 3. Put back
            ui.add_space(12.0);
            inset_group(ui, |ui| {
                let can_put_back = adjusted > 0;
                if !can_put_back {
                    st.straighten = false;
                }
                if switch_row(ui, &t, "Put back parts moved by hand", &mut st.straighten, can_put_back) {
                    st.dirty = true;
                }
            });
            let note = match adjusted {
                0 => "No parts were turned or moved on the floor.".to_owned(),
                1 => "1 part was turned or moved on the floor.".to_owned(),
                n => format!("{n} parts were turned or moved on the floor."),
            };
            footnote(ui, &t, &note);
            ui.add_space(12.0);
        });

    let edited = app.staging.is_edited(&saved);
    page_footer(ui, &t, |ui| {
        if edited {
            ui.label(RichText::new("Edited").size(11.0).color(t.text3));
        }
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if accent_button(ui, &t, "Apply", true).clicked() {
                do_apply = true;
            }
            ui.add_space(6.0);
            if secondary_button(ui, &t, "Revert", edited).clicked() {
                do_revert = true;
            }
        });
    });

    if do_revert {
        app.staging.draft = saved;
        app.staging.turn = 0.0;
        app.staging.straighten = false;
        app.staging.dirty = false;
    } else if do_apply {
        let draft = app.staging.draft.clone();
        let turn = app.staging.turn;
        let straighten = app.staging.straighten;
        let c = app.doc.session().apply_staging(&draft, turn, straighten);
        app.edited(c);
        app.staging.draft = app.doc.session().staging_settings();
        app.staging.turn = 0.0;
        app.staging.straighten = false;
        app.staging.dirty = false;
        app.staging.synced_gen = Some(app.doc.session().generation());
        app.staging.synced_ver = Some(app.doc.session().version());
        let (session, vp) = app.doc.parts();
        if let Some(vp) = vp {
            app.transport.preview_staging(session, vp);
        }
    }
}

fn layout_tile(ui: &mut Ui, t: &Theme, id: &str, title: &str, selected: bool, size: egui::Vec2) -> bool {
    let (rect, resp) = ui.allocate_exact_size(size, Sense::click());
    resp.widget_info(|| WidgetInfo::selected(egui::Role::RadioButton, true, selected, title));
    let fill = if selected {
        Color32::from_rgba_unmultiplied(t.accent.r(), t.accent.g(), t.accent.b(), 36)
    } else if resp.hovered() {
        Color32::from_white_alpha(23)
    } else {
        Color32::from_white_alpha(11)
    };
    let stroke = if selected {
        Stroke::new(2.0, t.accent)
    } else {
        Stroke::new(0.5, Color32::from_white_alpha(15))
    };
    ui.painter().rect(rect, CornerRadius::same(7), fill, stroke, egui::StrokeKind::Inside);

    // Draw layout rectangles mapped from 25×15 grid into inset tile rect.
    let inner = rect.shrink2(vec2(10.0, 9.0));
    let sx = inner.width() / 25.0;
    let sy = inner.height() / 15.0;
    let block_fill = if selected {
        Color32::from_rgba_unmultiplied(t.accent.r(), t.accent.g(), t.accent.b(), 130)
    } else {
        Color32::from_white_alpha(36)
    };
    for &(x, y, w, h) in layout_rects(id) {
        let r = Rect::from_min_size(pos2(inner.left() + x * sx, inner.top() + y * sy), vec2(w * sx, h * sy));
        ui.painter().rect_filled(r, 1.5, block_fill);
    }

    let clicked = resp.on_hover_text(title).clicked();
    clicked && !selected
}
