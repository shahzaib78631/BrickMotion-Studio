// Parts inventory capture, background preparation and commit behind the C interface.
#include "bmffi.h"

#include <string>

#include "bmapp/inventory_import.h"
#include "bmapp/session.h"
#include "internal.h"

struct BmInventory {
  bmapp::InventoryImport* inv;
};
struct BmInventoryReport {
  bmapp::InventoryReport report;
};

namespace {
using bmffi::change;
using bmffi::handle;
}  // namespace

extern "C" {

BmInventory* bm_inventory_capture(const BmSession* s, int32_t step) {
  if (!s) return nullptr;
  return handle<BmInventory>([&]() -> BmInventory* {
    bmapp::InventoryImport* inv = bmapp::InventoryImport::capture(s->s, step);
    if (!inv) return nullptr;
    return new BmInventory{inv};
  });
}

BmInventoryReport* bm_inventory_prepare(BmInventory* inv, const char* path) {
  if (!inv) return nullptr;
  return handle<BmInventoryReport>([&] {
    return new BmInventoryReport{inv->inv->prepare(path ? path : "")};
  });
}

const char* bm_inventory_report_error(const BmInventoryReport* r) { return r ? r->report.error.c_str() : ""; }
size_t bm_inventory_report_pieces(const BmInventoryReport* r) { return r ? r->report.pieces : 0; }
size_t bm_inventory_report_spares(const BmInventoryReport* r) { return r ? r->report.spares : 0; }
size_t bm_inventory_report_invalid_rows(const BmInventoryReport* r) { return r ? r->report.invalidRows : 0; }
size_t bm_inventory_report_missing_len(const BmInventoryReport* r) { return r ? r->report.missing.size() : 0; }
const char* bm_inventory_report_missing_at(const BmInventoryReport* r, size_t i) {
  return (r && i < r->report.missing.size()) ? r->report.missing[i].c_str() : "";
}
void bm_inventory_report_free(BmInventoryReport* r) { delete r; }

BmChange bm_session_import_inventory(BmSession* s, const BmInventory* inv) {
  return change(s, [&] { return inv ? s->s->importInventory(inv->inv) : bmapp::Changed{}; });
}

void bm_inventory_free(BmInventory* inv) {
  if (!inv) return;
  bmappReleaseInventoryImport(inv->inv);
  delete inv;
}

}  // extern "C"
