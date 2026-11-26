//! Parts inventory import (Rebrickable `.csv` and Studio `.pbg`).
//!
//! [`Inventory`] is captured on the UI thread, prepared on a worker thread (`Send`, never `Sync`),
//! and committed back on the UI thread via [`Session::import_inventory`].
use std::ffi::CString;
use std::path::Path;

use bm_sys as sys;

use crate::session::take_change;
use crate::{Changed, Session, borrowed};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InventoryReport {
    pub error: Option<String>,
    pub pieces: usize,
    pub spares: usize,
    pub invalid_rows: usize,
    pub missing: Vec<String>,
}

/// Captured destination for an inventory import; moves to one worker for [`Inventory::prepare`].
pub struct Inventory {
    raw: *mut sys::BmInventory,
}

unsafe impl Send for Inventory {}

impl Inventory {
    /// Captures the current document at `step` (`None` uses the last step).
    pub fn capture(session: &Session, step: Option<usize>) -> Option<Inventory> {
        let step_i = step.and_then(|s| i32::try_from(s).ok()).unwrap_or(-1);
        let raw = unsafe { sys::bm_inventory_capture(session.raw, step_i) };
        (!raw.is_null()).then_some(Inventory { raw })
    }

    /// Reads and lays out the inventory file. Slow: run on a worker thread.
    pub fn prepare(&mut self, path: &Path) -> InventoryReport {
        let Ok(c) = CString::new(path.to_string_lossy().as_bytes()) else {
            return InventoryReport { error: Some("The file path contains a NUL byte.".into()), ..Default::default() };
        };
        let h = unsafe { sys::bm_inventory_prepare(self.raw, c.as_ptr()) };
        if h.is_null() {
            return InventoryReport { error: Some("The parts inventory could not be prepared.".into()), ..Default::default() };
        }
        let err = borrowed(unsafe { sys::bm_inventory_report_error(h) });
        let pieces = unsafe { sys::bm_inventory_report_pieces(h) };
        let spares = unsafe { sys::bm_inventory_report_spares(h) };
        let invalid_rows = unsafe { sys::bm_inventory_report_invalid_rows(h) };
        let missing_len = unsafe { sys::bm_inventory_report_missing_len(h) };
        let missing = (0..missing_len).map(|i| borrowed(unsafe { sys::bm_inventory_report_missing_at(h, i) })).collect();
        unsafe { sys::bm_inventory_report_free(h) };
        InventoryReport { error: (!err.is_empty()).then_some(err), pieces, spares, invalid_rows, missing }
    }
}

impl Drop for Inventory {
    fn drop(&mut self) {
        unsafe { sys::bm_inventory_free(self.raw) }
    }
}

impl Session {
    pub fn import_inventory(&self, inventory: &Inventory) -> Changed {
        take_change(unsafe { sys::bm_session_import_inventory(self.raw, inventory.raw) })
    }
}
