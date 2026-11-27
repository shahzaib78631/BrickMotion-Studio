//! Snap Sound Properties page (m4-rulings.md: v2 page with v3 Mix inset group).
use bm::settings::{PRESETS, SnapExample, SnapLibrary, SnapMix, SnapSource, snap_mix_preset};
use egui::{Align2, CornerRadius, FontId, Frame, Margin, Rect, RichText, Sense, Stroke, Ui, WidgetInfo, pos2, vec2};

use super::widgets::{
    SliderEvent, disclosure, footnote, hairline, inset_group, page_footer, parse_number, pill_switch,
    secondary_button, section_header, slider_row, switch_row,
};
use crate::BrickMotionApp;
use crate::icons::{self, Icon};
use crate::theme::Theme;

#[derive(Default)]
pub struct SoundPageState {
    draft: SnapMix,
    synced: Option<(u64, u64)>,
    dragging: bool,
}

impl SoundPageState {
    pub fn reset(&mut self) {
        self.synced = None;
        self.dragging = false;
    }

    fn sync(&mut self, session: &bm::Session) {
        let key = (session.generation(), session.version());
        if !self.dragging && self.synced != Some(key) {
            self.draft = session.snap_mix();
            self.synced = Some(key);
        }
    }
}

fn mixes_match(a: &SnapMix, b: &SnapMix) -> bool {
    let near = |x: f64, y: f64| (x - y).abs() < 0.02;
    a.source == b.source
        && near(a.volume, b.volume)
        && near(a.room, b.room)
        && near(a.stereo, b.stereo)
        && near(a.click, b.click)
        && (a.brightness - b.brightness).abs() < 50.0
        && near(a.thump, b.thump)
        && near(a.thump_pitch, b.thump_pitch)
        && near(a.thump_length, b.thump_length)
        && near(a.pitch, b.pitch)
        && near(a.variation, b.variation)
        && a.size_pitch == b.size_pitch
        && a.size_match == b.size_match
        && a.together == b.together
}

fn parse_percent(s: &str) -> Option<f64> {
    parse_number(s).map(|v| v / 100.0)
}

fn format_percent(v: f64) -> String {
    format!("{:.0}%", (v * 100.0).round())
}

fn source_summary(m: &SnapMix) -> String {
    match m.source {
        SnapSource::Physical => "Source: Part Physics — modelled per brick".into(),
        SnapSource::Recorded => {
            let lib = match m.library {
                SnapLibrary::All => "All recordings",
                SnapLibrary::Freesound => "Freesound",
                SnapLibrary::OpenGameArt => "OpenGameArt",
            };
            format!("Source: Recorded — {lib}")
        }
        SnapSource::Synthesised => "Source: Synthesised — procedural click & body".into(),
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, body_max_h: f32) {
    let t = app.theme;
    app.sound_page.sync(app.doc.session());

    let last_ex = app.sound.last_example;
    let wf_plate = app.sound.waveform(SnapExample::Plate).map(|w| w.to_vec());
    let wf_brick = app.sound.waveform(SnapExample::Brick).map(|w| w.to_vec());
    let wf_pin = app.sound.waveform(SnapExample::Pin).map(|w| w.to_vec());

    let mut commit_mix: Option<SnapMix> = None;
    let mut play_example: Option<SnapExample> = None;
    let mut still_dragging = false;

    let scroll_h = (body_max_h - 48.0).max(120.0);
    egui::ScrollArea::vertical()
        .id_salt("snap-sound-scroll")
        .max_height(scroll_h)
        .auto_shrink([false, true])
        .show(ui, |ui| {
            let draft = &mut app.sound_page.draft;

            // 1. Header row (Snap sound toggle)
            ui.add_space(12.0);
            inset_group(ui, |ui| {
                Frame::NONE.inner_margin(Margin::symmetric(12, 10)).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.spacing_mut().item_spacing.y = 2.0;
                            ui.label(RichText::new("Snap sound").size(13.0).strong().color(t.text1));
                            ui.label(
                                RichText::new("Heard when you play the build and in exports")
                                    .size(11.0)
                                    .color(t.text3),
                            );
                        });
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if pill_switch(ui, &t, "Snap sound", &mut draft.enabled, true) {
                                commit_mix = Some(*draft);
                            }
                        });
                    });
                });
            });

            // 2. Hear it (3 sample tiles with waveforms)
            section_header(ui, &t, "Hear it", None);
            Frame::NONE.outer_margin(Margin::symmetric(12, 0)).show(ui, |ui| {
                let gap = 6.0;
                let tile_w = ((ui.available_width() - 2.0 * gap) / 3.0).max(70.0);
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = gap;
                    for (ex, label, wf) in [
                        (SnapExample::Plate, "Plate", wf_plate.as_deref()),
                        (SnapExample::Brick, "Brick", wf_brick.as_deref()),
                        (SnapExample::Pin, "Pin", wf_pin.as_deref()),
                    ] {
                        if sample_tile(ui, &t, label, wf, last_ex == Some(ex), vec2(tile_w, 52.0)) {
                            play_example = Some(ex);
                        }
                    }
                });
            });
            footnote(ui, &t, "Plays straight away — no planning needed. Each change replays the last sample.");

            // 3. Character (6 preset tiles + Source line with Change…)
            section_header(ui, &t, "Character", None);
            Frame::NONE.outer_margin(Margin::symmetric(12, 0)).show(ui, |ui| {
                let gap = 6.0;
                let tile_w = ((ui.available_width() - gap) * 0.5).max(90.0);
                ui.spacing_mut().item_spacing = vec2(gap, gap);
                for row in 0..3 {
                    ui.horizontal(|ui| {
                        for col in 0..2 {
                            let (title, id) = PRESETS[row * 2 + col];
                            let preset = snap_mix_preset(id);
                            let active = mixes_match(draft, &preset);
                            if preset_tile(ui, &t, title, active, vec2(tile_w, 32.0)) {
                                let mut next = preset;
                                next.enabled = draft.enabled;
                                *draft = next;
                                commit_mix = Some(*draft);
                            }
                        }
                    });
                }
            });

            ui.add_space(8.0);
            inset_group(ui, |ui| {
                Frame::NONE.inner_margin(Margin::symmetric(12, 8)).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(source_summary(draft)).size(11.5).color(t.text2));
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            let btn = secondary_button(ui, &t, "Change…", true);
                            egui::Popup::from_toggle_button_response(&btn).gap(4.0).show(|ui| {
                                ui.set_min_width(180.0);
                                ui.label(RichText::new("Source").size(11.0).color(t.text3));
                                for (src, label) in [
                                    (SnapSource::Physical, "Part Physics"),
                                    (SnapSource::Recorded, "Recorded"),
                                    (SnapSource::Synthesised, "Synthesised"),
                                ] {
                                    if ui.selectable_label(draft.source == src, label).clicked() {
                                        if draft.source != src {
                                            draft.source = src;
                                            commit_mix = Some(*draft);
                                        }
                                        ui.close();
                                    }
                                }
                                if draft.source == SnapSource::Recorded {
                                    ui.separator();
                                    ui.label(RichText::new("Recordings").size(11.0).color(t.text3));
                                    for (lib, label) in [
                                        (SnapLibrary::All, "All"),
                                        (SnapLibrary::Freesound, "Freesound"),
                                        (SnapLibrary::OpenGameArt, "OpenGameArt"),
                                    ] {
                                        if ui.selectable_label(draft.library == lib, label).clicked() {
                                            if draft.library != lib {
                                                draft.library = lib;
                                                commit_mix = Some(*draft);
                                            }
                                            ui.close();
                                        }
                                    }
                                }
                            });
                        });
                    });
                });
            });

            // 4. Mix (v3 inset group)
            section_header(ui, &t, "Mix", None);
            inset_group(ui, |ui| {
                match slider_row(
                    ui,
                    &t,
                    "ss-volume",
                    "Volume",
                    &mut draft.volume,
                    0.0..=1.5,
                    0.05,
                    format_percent,
                    parse_percent,
                    true,
                ) {
                    SliderEvent::Changing => still_dragging = true,
                    SliderEvent::Committed(_) => commit_mix = Some(*draft),
                    SliderEvent::None => {}
                }
                hairline(ui);

                match slider_row(
                    ui,
                    &t,
                    "ss-room",
                    "Room",
                    &mut draft.room,
                    0.0..=1.0,
                    0.05,
                    format_percent,
                    parse_percent,
                    true,
                ) {
                    SliderEvent::Changing => still_dragging = true,
                    SliderEvent::Committed(_) => commit_mix = Some(*draft),
                    SliderEvent::None => {}
                }
                hairline(ui);

                match slider_row(
                    ui,
                    &t,
                    "ss-stereo",
                    "Stereo width",
                    &mut draft.stereo,
                    0.0..=1.0,
                    0.05,
                    format_percent,
                    parse_percent,
                    true,
                ) {
                    SliderEvent::Changing => still_dragging = true,
                    SliderEvent::Committed(_) => commit_mix = Some(*draft),
                    SliderEvent::None => {}
                }
            });

            // 5. Click and Body (folded; dimmed unless Recorded or Synthesised)
            let detail_on = draft.source != SnapSource::Physical;
            disclosure(ui, &t, "ss-detail", "Click and Body", "Click, body, variation", false, |ui| {
                inset_group(ui, |ui| {
                    match slider_row(
                        ui,
                        &t,
                        "ss-click",
                        "Click level",
                        &mut draft.click,
                        0.0..=2.0,
                        0.05,
                        format_percent,
                        parse_percent,
                        detail_on,
                    ) {
                        SliderEvent::Changing => still_dragging = true,
                        SliderEvent::Committed(_) => commit_mix = Some(*draft),
                        SliderEvent::None => {}
                    }
                    hairline(ui);

                    match slider_row(
                        ui,
                        &t,
                        "ss-bright",
                        "Brightness",
                        &mut draft.brightness,
                        500.0..=6000.0,
                        100.0,
                        |v| format!("{v:.0} Hz"),
                        parse_number,
                        detail_on,
                    ) {
                        SliderEvent::Changing => still_dragging = true,
                        SliderEvent::Committed(_) => commit_mix = Some(*draft),
                        SliderEvent::None => {}
                    }
                    hairline(ui);

                    match slider_row(
                        ui,
                        &t,
                        "ss-pitch",
                        "Click pitch",
                        &mut draft.pitch,
                        0.7..=1.4,
                        0.01,
                        format_percent,
                        parse_percent,
                        detail_on,
                    ) {
                        SliderEvent::Changing => still_dragging = true,
                        SliderEvent::Committed(_) => commit_mix = Some(*draft),
                        SliderEvent::None => {}
                    }
                    hairline(ui);

                    match slider_row(
                        ui,
                        &t,
                        "ss-thump",
                        "Body level",
                        &mut draft.thump,
                        0.0..=2.0,
                        0.05,
                        format_percent,
                        parse_percent,
                        detail_on,
                    ) {
                        SliderEvent::Changing => still_dragging = true,
                        SliderEvent::Committed(_) => commit_mix = Some(*draft),
                        SliderEvent::None => {}
                    }
                    hairline(ui);

                    match slider_row(
                        ui,
                        &t,
                        "ss-thump-pitch",
                        "Body pitch",
                        &mut draft.thump_pitch,
                        0.5..=2.0,
                        0.05,
                        format_percent,
                        parse_percent,
                        detail_on,
                    ) {
                        SliderEvent::Changing => still_dragging = true,
                        SliderEvent::Committed(_) => commit_mix = Some(*draft),
                        SliderEvent::None => {}
                    }
                    hairline(ui);

                    match slider_row(
                        ui,
                        &t,
                        "ss-thump-len",
                        "Body length",
                        &mut draft.thump_length,
                        0.3..=2.0,
                        0.05,
                        format_percent,
                        parse_percent,
                        detail_on,
                    ) {
                        SliderEvent::Changing => still_dragging = true,
                        SliderEvent::Committed(_) => commit_mix = Some(*draft),
                        SliderEvent::None => {}
                    }
                    hairline(ui);

                    match slider_row(
                        ui,
                        &t,
                        "ss-variation",
                        "Variation",
                        &mut draft.variation,
                        0.0..=1.0,
                        0.05,
                        format_percent,
                        parse_percent,
                        detail_on,
                    ) {
                        SliderEvent::Changing => still_dragging = true,
                        SliderEvent::Committed(_) => commit_mix = Some(*draft),
                        SliderEvent::None => {}
                    }
                    hairline(ui);

                    let mut together = draft.together as f64;
                    match slider_row(
                        ui,
                        &t,
                        "ss-together",
                        "Simultaneous arrivals",
                        &mut together,
                        1.0..=3.0,
                        1.0,
                        |v| format!("{v:.0}"),
                        parse_number,
                        detail_on,
                    ) {
                        SliderEvent::Changing => {
                            draft.together = together.round().clamp(1.0, 3.0) as i32;
                            still_dragging = true;
                        }
                        SliderEvent::Committed(v) => {
                            draft.together = v.round().clamp(1.0, 3.0) as i32;
                            commit_mix = Some(*draft);
                        }
                        SliderEvent::None => {}
                    }
                    hairline(ui);

                    if switch_row(ui, &t, "Match pitch to part size", &mut draft.size_pitch, detail_on) {
                        commit_mix = Some(*draft);
                    }
                    hairline(ui);

                    if switch_row(ui, &t, "Match clicks to part size", &mut draft.size_match, detail_on) {
                        commit_mix = Some(*draft);
                    }
                });
            });

            ui.add_space(12.0);
        });

    // 6. Footer: Include in exports (the default for a video's Include Snap Sounds) + Restore Defaults
    page_footer(ui, &t, |ui| {
        let mut inc = app.sound_page.draft.enabled;
        ui.horizontal(|ui| {
            if pill_switch(ui, &t, "Include in exports", &mut inc, true) {
                app.sound_page.draft.enabled = inc;
                commit_mix = Some(app.sound_page.draft);
            }
            ui.label(RichText::new("Include in exports").size(11.5).color(t.text2))
                .on_hover_text("New videos of the build include snap sounds");
        });
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            let defaults = SnapMix { enabled: app.sound_page.draft.enabled, ..SnapMix::default() };
            let is_default = mixes_match(&app.sound_page.draft, &defaults);
            if secondary_button(ui, &t, "Restore Defaults", !is_default).clicked() {
                app.sound_page.draft = defaults;
                commit_mix = Some(defaults);
            }
        });
    });

    app.sound_page.dragging = still_dragging;

    if let Some(next) = commit_mix {
        let c = app.doc.session().set_snap_mix(&next);
        app.edited(c);
        app.sound_page.draft = app.doc.session().snap_mix();
        app.sound_page.synced = Some((app.doc.session().generation(), app.doc.session().version()));
        if let Some(ex) = app.sound.last_example {
            play_example = Some(ex);
        }
    }

    if let Some(ex) = play_example {
        app.play_snap_sample(ex);
    }
}

fn sample_tile(
    ui: &mut Ui,
    t: &Theme,
    label: &str,
    waveform: Option<&[f32]>,
    active: bool,
    size: egui::Vec2,
) -> bool {
    let (rect, resp) = ui.allocate_exact_size(size, Sense::click());
    resp.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, format!("Play {label} sample")));
    let fill = if active {
        t.accent_a(26)
    } else if resp.hovered() {
        t.ink(20)
    } else {
        t.ink(11)
    };
    let stroke = if active {
        Stroke::new(1.5, t.accent)
    } else {
        Stroke::new(0.5, t.ink(15))
    };
    ui.painter().rect(rect, CornerRadius::same(8), fill, stroke, egui::StrokeKind::Inside);

    // Top row: play glyph + label.
    let top_y = rect.top() + 13.0;
    let tint = if active { t.accent } else { t.text1 };
    icons::paint(ui, Icon::Play, Rect::from_center_size(pos2(rect.left() + 14.0, top_y), vec2(11.0, 11.0)), 11.0, tint);
    ui.painter().text(pos2(rect.left() + 24.0, top_y), Align2::LEFT_CENTER, label, FontId::proportional(11.5), t.text1);

    // Bottom area: waveform (flat line until first played).
    let wave_rect = Rect::from_min_max(pos2(rect.left() + 8.0, rect.top() + 25.0), pos2(rect.right() - 8.0, rect.bottom() - 7.0));
    let cy = wave_rect.center().y;
    let wave_color = if active { t.accent } else { t.ink(90) };
    if let Some(peaks) = waveform.filter(|p| !p.is_empty()) {
        let step = wave_rect.width() / peaks.len() as f32;
        let max_h = wave_rect.height() * 0.5;
        for (i, &p) in peaks.iter().enumerate() {
            let x = wave_rect.left() + (i as f32 + 0.5) * step;
            let h = (p * max_h).max(0.75);
            ui.painter().line_segment([pos2(x, cy - h), pos2(x, cy + h)], Stroke::new(1.2, wave_color));
        }
    } else {
        ui.painter().hline(wave_rect.x_range(), cy, Stroke::new(1.0, t.ink(40)));
    }

    resp.on_hover_text(format!("Hear {label} snap")).clicked()
}

fn preset_tile(ui: &mut Ui, t: &Theme, title: &str, active: bool, size: egui::Vec2) -> bool {
    let (rect, resp) = ui.allocate_exact_size(size, Sense::click());
    resp.widget_info(|| WidgetInfo::selected(egui::Role::RadioButton, true, active, title));
    let fill = if active {
        t.accent_a(32)
    } else if resp.hovered() {
        t.ink(20)
    } else {
        t.ink(11)
    };
    let stroke = if active {
        Stroke::new(1.5, t.accent)
    } else {
        Stroke::new(0.5, t.ink(15))
    };
    ui.painter().rect(rect, CornerRadius::same(7), fill, stroke, egui::StrokeKind::Inside);
    let fg = if active { t.text1 } else { t.text2 };
    ui.painter().text(rect.center(), Align2::CENTER_CENTER, title, FontId::proportional(12.0), fg);
    resp.clicked() && !active
}
