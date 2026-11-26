//! Import Parts Inventory (Rebrickable `.csv` and Studio `.pbg`, Swift `InventoryImportSheet`):
//! captures the document on the UI thread, reads & lays out the inventory off the UI thread, and
//! commits in one undo step on the UI thread if the document revision has not moved.
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, TryRecvError, channel};

use bm::inventory::{Inventory, InventoryReport};

use crate::BrickMotionApp;
use crate::app::DialogRequest;
use crate::notices::Notice;
use crate::viewport::ViewOp;

type DocKey = (u64, u64);

pub struct PendingInventory {
    doc: DocKey,
    rx: Receiver<(Inventory, InventoryReport)>,
}

/// Comma-groups an integer as Swift's en-US `formatted()` does (e.g. `1234` -> `"1,234"`).
pub fn group_thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// Formats Swift `InventoryImportSheet.Summary.details`.
pub fn summary_details(report: &InventoryReport) -> String {
    let mut lines = Vec::new();
    if report.invalid_rows > 0 {
        lines.push(format!("Unreadable rows: {}", group_thousands(report.invalid_rows)));
    }
    if report.spares > 0 {
        lines.push(format!("Spare pieces skipped: {}", group_thousands(report.spares)));
    }
    if !report.missing.is_empty() {
        let names: Vec<String> = report.missing.iter().take(8).map(|m| bm::export::display_name(m)).collect();
        lines.push(format!("Missing part files: {}", names.join(", ")));
        if report.missing.len() > 8 {
            lines.push(format!("{} more missing part files", group_thousands(report.missing.len() - 8)));
        }
    }
    lines.join("\n")
}

impl BrickMotionApp {
    /// Opens the file panel for Rebrickable `.csv` or Studio `.pbg` parts inventories.
    pub fn open_inventory_dialog(&mut self) {
        if !self.has_document || self.inventory_pending() {
            return;
        }
        if !self.dialogs_enabled() {
            self.dialog_requests.push(DialogRequest { kind: "inventory", suggested: None });
            return;
        }
        let mut dialog = rfd::FileDialog::new()
            .set_title("Import Parts Inventory")
            .add_filter("Parts Inventory (CSV, PBG)", &["csv", "pbg"]);
        if let Some(dir) = self.state.path.as_deref().and_then(Path::parent) {
            dialog = dialog.set_directory(dir);
        }
        if let Some(path) = dialog.pick_file() {
            self.finish_inventory(path);
        }
    }

    /// Starts preparing the chosen inventory file on a background thread (the open panel's answer).
    pub fn finish_inventory(&mut self, path: PathBuf) {
        if !self.has_document || self.inventory_pending() {
            return;
        }
        let s = self.doc.session();
        let doc = (s.generation(), s.version());
        let Some(mut inv) = Inventory::capture(s, self.edit.step) else {
            return;
        };
        let (tx, rx) = channel();
        let wake = self.ctx_handle();
        let spawned = std::thread::Builder::new().name("bm-inventory".into()).spawn(move || {
            let report = inv.prepare(&path);
            let _ = tx.send((inv, report));
            if let Some(ctx) = wake {
                ctx.request_repaint();
            }
        });
        match spawned {
            Ok(_) => self.pending_inventory = Some(PendingInventory { doc, rx }),
            Err(e) => crate::notices::push(
                &mut self.notices,
                Notice::Error { title: "Couldn’t Import Parts".into(), detail: e.to_string() },
            ),
        }
    }

    pub fn inventory_pending(&self) -> bool {
        self.pending_inventory.is_some()
    }

    pub(crate) fn poll_inventory(&mut self) {
        let Some(pending) = &self.pending_inventory else {
            return;
        };
        let done = match pending.rx.try_recv() {
            Ok(v) => Some(Ok(v)),
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => Some(Err(())),
        };
        let Some(done) = done else {
            return;
        };
        let doc = pending.doc;
        self.pending_inventory = None;

        let Ok((inv, report)) = done else {
            crate::notices::push(
                &mut self.notices,
                Notice::Error {
                    title: "Couldn’t Import Parts".into(),
                    detail: "The parts inventory could not be prepared.".into(),
                },
            );
            return;
        };

        if let Some(err) = report.error {
            crate::notices::push(&mut self.notices, Notice::Error { title: "Couldn’t Import Parts".into(), detail: err });
            return;
        }

        if report.pieces == 0 {
            let details = summary_details(&report);
            let detail = if details.is_empty() {
                "The file contains no part entries.".to_owned()
            } else {
                details
            };
            crate::notices::push(&mut self.notices, Notice::Warning { title: "No Parts to Import".into(), detail });
            return;
        }

        let s = self.doc.session();
        if (s.generation(), s.version()) != doc {
            crate::notices::push(
                &mut self.notices,
                Notice::Warning {
                    title: "Couldn’t Import Parts".into(),
                    detail: "The document changed while the file was read. Import it again.".into(),
                },
            );
            return;
        }

        let changed = s.import_inventory(&inv);
        if changed.refused.is_some() {
            crate::notices::push(
                &mut self.notices,
                Notice::Warning {
                    title: "Couldn’t Import Parts".into(),
                    detail: "The document changed while the file was read. Import it again.".into(),
                },
            );
            return;
        }

        self.viewport.queue(ViewOp::FrameSelection);
        if report.invalid_rows > 0 || !report.missing.is_empty() {
            let title = if report.pieces == 1 {
                "Imported 1 Part".to_owned()
            } else {
                format!("Imported {} Parts", group_thousands(report.pieces))
            };
            crate::notices::push(&mut self.notices, Notice::Warning { title, detail: summary_details(&report) });
        }
    }
}
