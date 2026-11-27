//! The Render Queue panel (Swift `RenderQueueWindow`): every export, newest first, with its
//! progress, Cancel while it waits or renders, Show in Finder once it is done, and Clear Finished.
use egui::{Color32, CornerRadius, Sense, Ui, WidgetInfo, pos2, vec2};

use super::float_panel::{self, Head, PanelKind};
use super::widgets::{footnote, hairline, page_footer, secondary_button};
use crate::BrickMotionApp;
use crate::icons::Icon;
use crate::render_queue::{Job, JobStatus};
use crate::theme::Theme;

#[derive(Default)]
pub struct QueuePanel {
    pub open: bool,
}

pub fn toggle(app: &mut BrickMotionApp) {
    app.queue_panel.open = !app.queue_panel.open;
    if app.queue_panel.open {
        app.panels.unfold(PanelKind::Queue);
    }
}

pub fn is_open(app: &BrickMotionApp) -> bool {
    app.queue_panel.open
}

/// The status line under a job (Swift's copy).
pub fn status_text(s: &JobStatus) -> String {
    match s {
        JobStatus::Queued => "Waiting to render".into(),
        JobStatus::Rendering { total: 0, .. } => "Preparing render…".into(),
        JobStatus::Rendering { done, total } if done == total => "Finalizing…".into(),
        JobStatus::Rendering { done, total } => format!("Frame {done} of {total}"),
        JobStatus::Cancelling => "Cancelling…".into(),
        JobStatus::Cancelled => "Cancelled".into(),
        JobStatus::Complete => "Exported".into(),
        JobStatus::Interrupted => "Interrupted when BrickMotion closed".into(),
        JobStatus::Failed(reason) => reason.clone(),
    }
}

/// Swift's count of the exports still to finish.
pub fn subtitle(jobs: &[Job]) -> String {
    match jobs.iter().filter(|j| !j.status.finished()).count() {
        0 => "No exports in progress".into(),
        1 => "1 export in progress".into(),
        n => format!("{n} exports in progress"),
    }
}

pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, area: egui::Rect, next_top: &mut f32) {
    if !app.queue_panel.open {
        return;
    }
    let subtitle = subtitle(app.queue.jobs());
    let out = float_panel::show(ui, app, area, next_top, PanelKind::Queue, Head { icon: Icon::Queue, title: "", subtitle: &subtitle }, body);
    if out.close {
        app.queue_panel.open = false;
    }
}

enum Action {
    Cancel(String),
    Reveal(std::path::PathBuf),
    Clear,
}

fn dot(s: &JobStatus, t: &Theme) -> Color32 {
    match s {
        JobStatus::Complete => t.success,
        JobStatus::Interrupted | JobStatus::Failed(_) => t.warning,
        JobStatus::Rendering { .. } => t.accent,
        _ => t.text3,
    }
}

fn body(ui: &mut Ui, app: &mut BrickMotionApp) {
    let t = app.theme;
    let mut action = None;
    if app.queue.jobs().is_empty() {
        footnote(ui, &t, "No exports");
        footnote(ui, &t, "Build, Keyframes, and Turntable exports appear here.");
    } else {
        egui::ScrollArea::vertical().max_height(360.0).auto_shrink([false, true]).show(ui, |ui| {
            for (i, job) in app.queue.jobs().iter().enumerate() {
                if i > 0 {
                    hairline(ui);
                }
                row(ui, &t, job, &mut action);
            }
        });
    }
    page_footer(ui, &t, |ui| {
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if secondary_button(ui, &t, "Clear Finished", app.queue.has_finished_jobs()).clicked() {
                action = Some(Action::Clear);
            }
        });
    });
    match action {
        Some(Action::Cancel(id)) => app.queue.cancel(&id),
        Some(Action::Clear) => app.queue.clear_finished(),
        Some(Action::Reveal(path)) => {
            if app.dialogs_enabled() {
                let _ = std::process::Command::new("open").arg("-R").arg(&path).spawn();
            } else {
                app.revealed = Some(path);
            }
        }
        None => {}
    }
}

fn row(ui: &mut Ui, t: &Theme, job: &Job, action: &mut Option<Action>) {
    let name = job.destination.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    egui::Frame::NONE.inner_margin(egui::Margin::symmetric(14, 9)).show(ui, |ui| {
        ui.spacing_mut().item_spacing.y = 3.0;
        ui.horizontal(|ui| {
            let (r, _) = ui.allocate_exact_size(vec2(8.0, 16.0), Sense::hover());
            ui.painter().circle_filled(pos2(r.center().x, r.center().y), 3.5, dot(&job.status, t));
            ui.vertical(|ui| {
                ui.set_width(ui.available_width() - 96.0);
                ui.add(egui::Label::new(egui::RichText::new(&name).size(12.5).color(t.text1)).truncate())
                    .on_hover_text(job.destination.display().to_string());
                ui.label(egui::RichText::new(&job.summary).size(10.5).color(t.text3));
                if let JobStatus::Rendering { done, total } = job.status {
                    let (bar, _) = ui.allocate_exact_size(vec2(ui.available_width(), 4.0), Sense::hover());
                    ui.painter().rect_filled(bar, CornerRadius::same(2), t.ink(18));
                    if total > 0 && done < total {
                        let mut fill = bar;
                        fill.set_width(bar.width() * done as f32 / total as f32);
                        ui.painter().rect_filled(fill, CornerRadius::same(2), t.accent);
                    }
                }
                let text = status_text(&job.status);
                ui.add(egui::Label::new(egui::RichText::new(&text).size(10.5).color(t.text2)).wrap());
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| match job.status {
                JobStatus::Queued | JobStatus::Rendering { .. } => {
                    let r = secondary_button(ui, t, "Cancel", true);
                    let label = format!("Cancel {name}");
                    r.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, &label));
                    if r.clicked() {
                        *action = Some(Action::Cancel(job.id.clone()));
                    }
                }
                JobStatus::Complete => {
                    let r = secondary_button(ui, t, "Show in Finder", true);
                    let label = format!("Show {name} in Finder");
                    r.widget_info(|| WidgetInfo::labeled(egui::Role::Button, true, &label));
                    if r.clicked() {
                        *action = Some(Action::Reveal(job.destination.clone()));
                    }
                }
                _ => {}
            });
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses() {
        assert_eq!(status_text(&JobStatus::Rendering { done: 0, total: 0 }), "Preparing render…");
        assert_eq!(status_text(&JobStatus::Rendering { done: 3, total: 9 }), "Frame 3 of 9");
        assert_eq!(status_text(&JobStatus::Rendering { done: 9, total: 9 }), "Finalizing…");
        assert_eq!(status_text(&JobStatus::Failed("x".into())), "x");
    }
}
