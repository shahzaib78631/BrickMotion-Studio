//! File › Export LDraw / Export Plan, a submodel row's Export Project / Export LDraw, and Edit ›
//! Copy Viewport Image. Panels and copy are Swift's (`Document.exportLDraw`, `exportPlan`,
//! `SubmodelFileExport`). The bytes are read once the destination is chosen; a document that
//! changed while the panel was open is refused, as Swift does.
use std::path::{Path, PathBuf};

use crate::app::DialogRequest;
use crate::notices::Notice;
use crate::support::write_atomic;
use crate::BrickMotionApp;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileExport {
    Plan,
    Ldraw,
    SubmodelProject,
    SubmodelLdraw,
}

/// An export waiting for its destination.
#[derive(Clone, Debug)]
pub struct PendingExport {
    kind: FileExport,
    model: Option<String>,
    generation: u64,
}

/// A name the save panel suggests: the display name without "/".
fn display_name(raw: &str) -> String {
    let lower = raw.to_lowercase();
    let stem = [".ldr", ".dat", ".mpd"].iter().find(|e| lower.ends_with(*e)).map_or(raw, |e| &raw[..raw.len() - e.len()]);
    stem.split(' ').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ").replace('/', " ")
}

impl BrickMotionApp {
    /// Asks where to export; the file is written when the destination is chosen.
    pub fn export_bytes(&mut self, kind: FileExport, model: Option<&str>) {
        let title = self.doc.session().title();
        let (suggested, filter, ext, panel_title) = match kind {
            FileExport::Plan => (format!("{title}.plan.json"), "Plan", "json", "Export Plan"),
            FileExport::Ldraw => (format!("{}.mpd", display_name(&title)), "LDraw model", "mpd", "Export LDraw"),
            FileExport::SubmodelProject => {
                (format!("{}.brickmotion", display_name(model.unwrap_or(""))), "BrickMotion project", "brickmotion", "Save Submodel Project")
            }
            FileExport::SubmodelLdraw => {
                (format!("{}.mpd", display_name(model.unwrap_or(""))), "LDraw model", "mpd", "Export Submodel as LDraw")
            }
        };
        self.pending_export =
            Some(PendingExport { kind, model: model.map(str::to_owned), generation: self.doc.session().generation() });
        if !self.dialogs_enabled() {
            self.dialog_requests.push(DialogRequest { kind: "export", suggested: Some(suggested) });
            return;
        }
        let mut dialog = rfd::FileDialog::new().set_title(panel_title).add_filter(filter, &[ext]).set_file_name(&suggested);
        if let Some(dir) = self.state.path.as_deref().and_then(Path::parent) {
            dialog = dialog.set_directory(dir);
        }
        match dialog.save_file() {
            Some(path) => self.finish_export(path),
            None => self.pending_export = None,
        }
    }

    /// Writes the waiting export to `path` (the save panel's answer).
    pub fn finish_export(&mut self, path: PathBuf) {
        let Some(p) = self.pending_export.take() else { return };
        let name = path.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        let result = (|| {
            let s = self.doc.session();
            let submodel = matches!(p.kind, FileExport::SubmodelProject | FileExport::SubmodelLdraw);
            if s.generation() != p.generation {
                return Err(if submodel {
                    "The submodel changed before the export finished.".to_owned()
                } else {
                    "The document changed before the export finished.".to_owned()
                });
            }
            let model = p.model.as_deref().unwrap_or("");
            let bytes = match p.kind {
                FileExport::Plan => s.plan_bytes(),
                FileExport::Ldraw => s.mpd_bytes(),
                FileExport::SubmodelProject => s.submodel_project_bytes(model),
                FileExport::SubmodelLdraw => s.submodel_mpd_bytes(model),
            };
            if bytes.is_empty() {
                return Err("The submodel changed before the export finished.".to_owned());
            }
            write_atomic(&path, bytes.as_bytes()).map_err(|e| e.to_string())
        })();
        if let Err(detail) = result {
            crate::notices::push(&mut self.notices, Notice::Error { title: format!("Couldn't export {name}"), detail });
        }
    }

    /// Edit › Copy Viewport Image: the viewport's last frame as an image on the clipboard.
    pub fn copy_viewport_image(&mut self) {
        let frame = self.viewport.last_frame();
        if frame.width == 0 || frame.height == 0 || frame.rgba.len() < frame.width as usize * frame.height as usize * 4 {
            crate::notices::push(
                &mut self.notices,
                Notice::Warning { title: "Couldn't copy the viewport".into(), detail: "The viewport has not drawn a picture yet.".into() },
            );
            return;
        }
        let (w, h) = (frame.width as usize, frame.height as usize);
        let rgba = frame.rgba[..w * h * 4].to_vec();
        if !self.dialogs_enabled() {
            self.clipboard_image = Some((w, h, rgba));
            return;
        }
        let image = arboard::ImageData { width: w, height: h, bytes: rgba.into() };
        if let Err(e) = arboard::Clipboard::new().and_then(|mut cb| cb.set_image(image)) {
            crate::notices::push(&mut self.notices, Notice::Warning { title: "Couldn't copy the viewport".into(), detail: e.to_string() });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::display_name;

    #[test]
    fn names() {
        assert_eq!(display_name("wheel  pair.LDR"), "wheel pair");
        assert_eq!(display_name("a/b.mpd"), "a b");
    }
}
