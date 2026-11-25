// List handles: each owns a copy of the engine's rows, and rows hand out pointers into it.
#include <cstring>
#include <vector>

#include "bmffi.h"
#include "bmapp/session.h"
#include "internal.h"

struct BmOutline {
  std::vector<bmapp::OutlineRow> rows;
};
struct BmSnapshot {
  bmapp::Snapshot snap;
};
struct BmColors {
  std::vector<bmapp::ColorInfo> colors;
};

namespace {
template <typename T, typename F>
T* handle(F&& f) {
  try {
    return f();
  } catch (...) {
    return nullptr;
  }
}
}  // namespace

extern "C" {

BmOutline* bm_session_outline(const BmSession* s) {
  if (!s) return nullptr;
  return handle<BmOutline>([&] { return new BmOutline{s->s->outline()}; });
}
size_t bm_outline_len(const BmOutline* o) { return o ? o->rows.size() : 0; }
BmOutlineRow bm_outline_row(const BmOutline* o, size_t i) {
  if (!o || i >= o->rows.size()) return BmOutlineRow{"", "", "", "", 0, -1, 0, 0, false, false};
  const bmapp::OutlineRow& r = o->rows[i];
  return BmOutlineRow{r.id.c_str(), r.def.c_str(), r.name.c_str(), r.group.c_str(),
                      static_cast<int32_t>(r.depth), static_cast<int32_t>(r.parent),
                      r.pieces, r.uses, r.shared, r.unused};
}
void bm_outline_free(BmOutline* o) { delete o; }

BmSnapshot* bm_session_snapshot(const BmSession* s) {
  if (!s) return nullptr;
  return handle<BmSnapshot>([&] { return new BmSnapshot{s->s->snapshot()}; });
}
BmSnapshotInfo bm_snapshot_info(const BmSnapshot* s) {
  if (!s) return BmSnapshotInfo{0, 0, 0, 0, false};
  return BmSnapshotInfo{s->snap.version, s->snap.pieces, s->snap.selection.size(), s->snap.hidden,
                        s->snap.dirty};
}
size_t bm_snapshot_piece_len(const BmSnapshot* s) { return s ? s->snap.selected.size() : 0; }
BmPieceInfo bm_snapshot_piece(const BmSnapshot* s, size_t i) {
  if (!s || i >= s->snap.selected.size()) return BmPieceInfo{0, "", "", "", "", 0, 0, false};
  const bmapp::PieceInfo& p = s->snap.selected[i];
  return BmPieceInfo{p.piece, p.part.c_str(), p.description.c_str(), p.colorName.c_str(),
                     p.submodelPath.c_str(), p.color, p.step, p.inSharedSubmodel};
}
void bm_snapshot_free(BmSnapshot* s) { delete s; }

BmColors* bm_colors(const BmSession* s) {
  if (!s) return nullptr;
  return handle<BmColors>([&] { return new BmColors{s->s->colors()}; });
}
size_t bm_colors_len(const BmColors* c) { return c ? c->colors.size() : 0; }
BmColor bm_colors_at(const BmColors* c, size_t i) {
  if (!c || i >= c->colors.size()) return BmColor{0, "", 0, 1, 0};
  const bmapp::ColorInfo& k = c->colors[i];
  return BmColor{k.code, k.name.c_str(), k.rgb, k.alpha, k.group};
}
void bm_colors_free(BmColors* c) { delete c; }

size_t bm_struct_size(const char* name) {
  if (!name) return 0;
  struct Entry {
    const char* name;
    size_t size;
  };
  static const Entry kSizes[] = {
      {"BmOutlineRow", sizeof(BmOutlineRow)}, {"BmPieceInfo", sizeof(BmPieceInfo)},
      {"BmSnapshotInfo", sizeof(BmSnapshotInfo)}, {"BmColor", sizeof(BmColor)},
      {"BmChange", sizeof(BmChange)}, {"BmOpenResult", sizeof(BmOpenResult)},
      {"BmString", sizeof(BmString)},
  };
  for (const Entry& e : kSizes)
    if (std::strcmp(e.name, name) == 0) return e.size;
  return 0;
}

}  // extern "C"
