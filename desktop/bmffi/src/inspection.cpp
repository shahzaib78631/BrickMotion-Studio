// Model checks, loose pieces and choice rules, BrickNet habit fits, fitting parts and seating.
#include "bmffi.h"

#include <string>
#include <vector>

#include "bmapp/assembly_inspection.h"
#include "bmapp/session.h"
#include "internal.h"

struct BmModelChecks {
  bmapp::ModelChecks checks;
};
struct BmLoosePieces {
  bmapp::LoosePieces loose;
};
struct BmHabitFits {
  std::vector<bmapp::HabitFit> fits;
  std::vector<std::string> whys;
};
struct BmFittingParts {
  std::vector<bmapp::FittingPart> parts;
};

namespace {
using bmffi::change;
using bmffi::from_mat3;
using bmffi::from_vec3;
using bmffi::guard;
using bmffi::handle;
using bmffi::list;
using bmffi::make;
using bmffi::to_mat3;
using bmffi::to_vec3;
}  // namespace

extern "C" {

BmModelChecks* bm_inspection_check_model(BmInspection* i) {
  if (!i) return nullptr;
  return handle<BmModelChecks>([&] { return new BmModelChecks{i->inspection->checkModel()}; });
}
size_t bm_model_checks_len(const BmModelChecks* c) { return c ? c->checks.findings.size() : 0; }
int32_t bm_model_checks_kind(const BmModelChecks* c, size_t i) {
  if (!c || i >= c->checks.findings.size()) return 0;
  return static_cast<int32_t>(c->checks.findings[i].kind);
}
const char* bm_model_checks_title(const BmModelChecks* c, size_t i) {
  return (c && i < c->checks.findings.size()) ? c->checks.findings[i].title.c_str() : "";
}
const char* bm_model_checks_detail(const BmModelChecks* c, size_t i) {
  return (c && i < c->checks.findings.size()) ? c->checks.findings[i].detail.c_str() : "";
}
size_t bm_model_checks_pieces(const BmModelChecks* c, size_t i, uint32_t* out, size_t cap) {
  if (!c || i >= c->checks.findings.size()) return 0;
  const auto& p = c->checks.findings[i].pieces;
  for (size_t k = 0; out && k < p.size() && k < cap; ++k) out[k] = p[k];
  return p.size();
}
const char* bm_model_checks_error(const BmModelChecks* c) { return c ? c->checks.error.c_str() : ""; }
void bm_model_checks_free(BmModelChecks* c) { delete c; }

BmLoosePieces* bm_inspection_loose_pieces(BmInspection* i) {
  if (!i) return nullptr;
  return handle<BmLoosePieces>([&] { return new BmLoosePieces{i->inspection->loosePieces()}; });
}
size_t bm_loose_pieces_len(const BmLoosePieces* l) { return l ? l->loose.pieces.size() : 0; }
BmLoosePiece bm_loose_pieces_at(const BmLoosePieces* l, size_t i) {
  if (!l || i >= l->loose.pieces.size())
    return BmLoosePiece{BM_NO_PIECE, BM_NO_PIECE, {{1, 0, 0, 0, 1, 0, 0, 0, 1}}, {0, 0, 0}, 0, 0, false};
  const bmapp::LoosePiece& r = l->loose.pieces[i];
  return BmLoosePiece{r.piece, r.onto, from_mat3(r.pose.rotation), from_vec3(r.pose.position), r.offset, r.angle, r.safe};
}
const char* bm_loose_pieces_note(const BmLoosePieces* l, size_t i) {
  return (l && i < l->loose.pieces.size()) ? l->loose.pieces[i].note.c_str() : "";
}
const char* bm_loose_pieces_error(const BmLoosePieces* l) { return l ? l->loose.error.c_str() : ""; }
void bm_loose_pieces_free(BmLoosePieces* l) { delete l; }

size_t bm_loose_initial_choice(const BmLoosePieces* l, uint32_t* out, size_t cap) {
  if (!l) return 0;
  return guard<size_t>(0, [&] {
    const bmapp::PieceList chosen = bmapp::initialLooseChoice(l->loose.pieces);
    for (size_t k = 0; out && k < chosen.size() && k < cap; ++k) out[k] = chosen[k];
    return chosen.size();
  });
}
uint32_t bm_loose_waiting_on(const BmLoosePieces* l, uint32_t piece, const uint32_t* chosen, size_t n) {
  if (!l) return BM_NO_PIECE;
  return guard<uint32_t>(BM_NO_PIECE, [&] { return bmapp::looseWaitingOn(l->loose.pieces, piece, list(chosen, n)); });
}
size_t bm_loose_uncheck(const BmLoosePieces* l, uint32_t piece, const uint32_t* chosen, size_t n, uint32_t* out, size_t cap) {
  if (!l) return 0;
  return guard<size_t>(0, [&] {
    const bmapp::PieceList next = bmapp::looseUncheck(l->loose.pieces, piece, list(chosen, n));
    for (size_t k = 0; out && k < next.size() && k < cap; ++k) out[k] = next[k];
    return next.size();
  });
}
BmString bm_loose_detail(const BmLoosePieces* l, size_t i, const char* onto_name) {
  if (!l || i >= l->loose.pieces.size()) return make("");
  return guard<BmString>(BmString{nullptr, 0}, [&] {
    return make(bmapp::looseDetail(l->loose.pieces[i], onto_name ? onto_name : ""));
  });
}

BmHabitFits* bm_inspection_habit_fits(BmInspection* i, uint32_t piece, size_t limit) {
  if (!i) return nullptr;
  return handle<BmHabitFits>([&] {
    auto* out = new BmHabitFits;
    out->fits = i->inspection->habitFits(piece, limit);
    out->whys.reserve(out->fits.size());
    for (const auto& fit : out->fits) out->whys.push_back(bmapp::habitWhy(fit));
    return out;
  });
}
size_t bm_habit_fits_len(const BmHabitFits* h) { return h ? h->fits.size() : 0; }
BmHabitFit bm_habit_fits_at(const BmHabitFits* h, size_t i) {
  if (!h || i >= h->fits.size()) return BmHabitFit{16, {{1, 0, 0, 0, 1, 0, 0, 0, 1}}, {0, 0, 0}, 0, 0, 0};
  const bmapp::HabitFit& f = h->fits[i];
  return BmHabitFit{static_cast<int32_t>(f.color), from_mat3(f.pose.rotation), from_vec3(f.pose.position), f.models, f.total, f.links};
}
const char* bm_habit_fits_name(const BmHabitFits* h, size_t i) {
  return (h && i < h->fits.size()) ? h->fits[i].name.c_str() : "";
}
const char* bm_habit_fits_description(const BmHabitFits* h, size_t i) {
  return (h && i < h->fits.size()) ? h->fits[i].description.c_str() : "";
}
const char* bm_habit_fits_joint(const BmHabitFits* h, size_t i) {
  return (h && i < h->fits.size()) ? h->fits[i].joint.c_str() : "";
}
const char* bm_habit_fits_why(const BmHabitFits* h, size_t i) {
  return (h && i < h->whys.size()) ? h->whys[i].c_str() : "";
}
void bm_habit_fits_free(BmHabitFits* h) { delete h; }

BmFittingParts* bm_inspection_fitting_parts(BmInspection* i, uint32_t piece, const char* const* candidates, size_t n, size_t limit) {
  if (!i) return nullptr;
  return handle<BmFittingParts>([&] {
    std::vector<std::string> names;
    names.reserve(candidates ? n : 0);
    for (size_t k = 0; candidates && k < n; ++k)
      if (candidates[k]) names.emplace_back(candidates[k]);
    return new BmFittingParts{i->inspection->fittingParts(piece, names, limit)};
  });
}
size_t bm_fitting_parts_len(const BmFittingParts* f) { return f ? f->parts.size() : 0; }
const char* bm_fitting_parts_name(const BmFittingParts* f, size_t i) {
  return (f && i < f->parts.size()) ? f->parts[i].name.c_str() : "";
}
BmVec3 bm_fitting_parts_contact(const BmFittingParts* f, size_t i) {
  return (f && i < f->parts.size()) ? from_vec3(f->parts[i].contact) : BmVec3{0, 0, 0};
}
void bm_fitting_parts_free(BmFittingParts* f) { delete f; }

BmChange bm_session_seat_pieces(BmSession* s, const BmPieceMove* moves, size_t n, uint64_t generation, uint64_t version) {
  return change(s, [&] {
    bmapp::PieceMoves out;
    out.reserve(moves ? n : 0);
    for (size_t k = 0; moves && k < n; ++k) {
      bmapp::PieceMove m;
      m.piece = moves[k].piece;
      m.pose.rotation = to_mat3(moves[k].rotation);
      m.pose.position = to_vec3(moves[k].position);
      out.push_back(m);
    }
    return s->s->seatPieces(out, generation, version);
  });
}

}  // extern "C"
