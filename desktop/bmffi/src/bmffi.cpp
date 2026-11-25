// The engine's session and viewport behind a flat C interface. Every entry point catches C++
// exceptions so none crosses into Rust.
#include "bmffi.h"

#include <cstdlib>
#include <cstring>
#include <exception>
#include <filesystem>
#include <string>
#include <vector>

#include "bmapp/session.h"
#include "bmapp/viewport.h"

struct BmSession {
  bmapp::Session* s;
};
struct BmViewport {
  bmapp::Viewport* v;
};

namespace {

BmString make(const std::string& text) {
  BmString out{nullptr, text.size()};
  out.ptr = static_cast<char*>(std::malloc(text.size() + 1));
  if (!out.ptr) return BmString{nullptr, 0};
  std::memcpy(out.ptr, text.data(), text.size());
  out.ptr[text.size()] = '\0';
  return out;
}

template <typename R, typename F>
R guard(R neutral, F&& f) {
  try {
    return f();
  } catch (...) {
    return neutral;
  }
}

template <typename F>
void guardVoid(F&& f) {
  try {
    f();
  } catch (...) {
  }
}

bmapp::ViewPreset preset(BmViewPreset p) {
  switch (p) {
    case BM_VIEW_BACK: return bmapp::ViewPreset::Back;
    case BM_VIEW_RIGHT: return bmapp::ViewPreset::Right;
    case BM_VIEW_LEFT: return bmapp::ViewPreset::Left;
    case BM_VIEW_TOP: return bmapp::ViewPreset::Top;
    case BM_VIEW_BOTTOM: return bmapp::ViewPreset::Bottom;
    default: return bmapp::ViewPreset::Front;
  }
}

bmapp::SelectMode mode(BmSelectMode m) {
  switch (m) {
    case BM_SELECT_ADD: return bmapp::SelectMode::Add;
    case BM_SELECT_TOGGLE: return bmapp::SelectMode::Toggle;
    default: return bmapp::SelectMode::Replace;
  }
}

}  // namespace

extern "C" {

void bm_string_free(BmString s) { std::free(s.ptr); }

BmString bm_ldraw_directory(void) {
  return guard(BmString{nullptr, 0}, [] { return make(bmapp::Session::ldrawDirectory()); });
}

BmString bm_engine_version(void) {
  return guard(BmString{nullptr, 0}, [] { return make(bmapp::Session::engineVersion()); });
}

BmSession* bm_session_new(void) {
  return guard<BmSession*>(nullptr, [] { return new BmSession{bmapp::Session::create()}; });
}

void bm_session_free(BmSession* s) {
  if (!s) return;
  bmappReleaseSession(s->s);
  delete s;
}

BmOpenResult bm_session_open(BmSession* s, const char* utf8_path) {
  BmOpenResult out{false, {nullptr, 0}, {nullptr, 0}};
  if (!s || !utf8_path) {
    out.error = make("no file was given");
    return out;
  }
  try {
    // A library folder without LDConfig.ldr would open every part as missing; refuse and name it.
    std::string ldraw = bmapp::Session::ldrawDirectory();
    std::error_code ec;
    if (!ldraw.empty() && !std::filesystem::exists(std::filesystem::path(ldraw) / "LDConfig.ldr", ec)) {
      const char* from = std::getenv("BM_LDRAW_DIR") ? "set by BM_LDRAW_DIR" : "the built-in location";
      out.error = make("No LDraw parts library at " + ldraw + " (" + from +
                       "). Point BM_LDRAW_DIR at the folder that holds LDConfig.ldr.");
      return out;
    }
    bmapp::OpenResult r = s->s->open(utf8_path);
    out.ok = r.ok;
    out.error = make(r.error);
    out.warnings = make(r.warnings);
  } catch (const std::exception& e) {
    out.error = make(e.what());
  } catch (...) {
    out.error = make("the engine failed while opening the file");
  }
  return out;
}

void bm_open_result_free(BmOpenResult r) {
  bm_string_free(r.error);
  bm_string_free(r.warnings);
}

void bm_session_adopt(BmSession* into, const BmSession* loaded) {
  if (!into || !loaded) return;
  guardVoid([&] { into->s->adoptLoadedSession(loaded->s); });
}

BmString bm_session_title(const BmSession* s) {
  if (!s) return BmString{nullptr, 0};
  return guard(BmString{nullptr, 0}, [&] { return make(s->s->title()); });
}

size_t bm_session_piece_count(const BmSession* s) {
  return s ? guard<size_t>(0, [&] { return s->s->pieceCount(); }) : 0;
}

uint64_t bm_session_generation(const BmSession* s) {
  return s ? guard<uint64_t>(0, [&] { return s->s->generation(); }) : 0;
}

void bm_session_select(BmSession* s, const uint32_t* pieces, size_t n, BmSelectMode m) {
  if (!s) return;
  guardVoid([&] {
    std::vector<uint32_t> list(pieces, pieces + (pieces ? n : 0));
    s->s->select(list, mode(m));
  });
}

size_t bm_session_selection(const BmSession* s, uint32_t* out, size_t cap) {
  if (!s) return 0;
  return guard<size_t>(0, [&] {
    std::vector<uint32_t> sel = s->s->selection();
    for (size_t i = 0; i < sel.size() && i < cap && out; ++i) out[i] = sel[i];
    return sel.size();
  });
}

BmViewport* bm_viewport_new(BmSession* s) {
  if (!s || !bmapp::Viewport::metalDevice()) return nullptr;
  return guard<BmViewport*>(nullptr, [&] { return new BmViewport{bmapp::Viewport::create(s->s)}; });
}

void bm_viewport_free(BmViewport* v) {
  if (!v) return;
  bmappReleaseViewport(v->v);
  delete v;
}

bool bm_viewport_ok(const BmViewport* v) { return v && guard(false, [&] { return v->v->ok(); }); }

void bm_viewport_resize(BmViewport* v, int px_w, int px_h, double scale) {
  if (!v || px_w <= 0 || px_h <= 0 || !(scale > 0)) return;
  guardVoid([&] { v->v->resize(px_w, px_h, scale); });
}

bool bm_viewport_draw(BmViewport* v) { return v && guard(false, [&] { return v->v->draw(nullptr); }); }

bool bm_viewport_needs_draw(const BmViewport* v) {
  return v && guard(false, [&] { return v->v->needsDraw(); });
}

bool bm_viewport_readback(BmViewport* v, uint8_t* rgba, size_t cap, int* w, int* h) {
  if (w) *w = 0;
  if (h) *h = 0;
  if (!v) return false;
  return guard(false, [&] {
    bmapp::Picture p = v->v->readback();
    if (w) *w = p.width;
    if (h) *h = p.height;
    if (!rgba || cap < p.rgba.size()) return false;
    std::memcpy(rgba, p.rgba.data(), p.rgba.size());
    return true;
  });
}

void bm_viewport_orbit(BmViewport* v, double dx, double dy) {
  if (v) guardVoid([&] { v->v->orbit(dx, dy); });
}
void bm_viewport_pan(BmViewport* v, double dx, double dy) {
  if (v) guardVoid([&] { v->v->pan(dx, dy); });
}
void bm_viewport_zoom_toward(BmViewport* v, double factor, double x, double y) {
  if (v && factor > 0) guardVoid([&] { v->v->zoomToward(factor, x, y); });
}
void bm_viewport_fit_all(BmViewport* v) {
  if (v) guardVoid([&] { v->v->fitAll(); });
}
void bm_viewport_view(BmViewport* v, BmViewPreset p) {
  if (v) guardVoid([&] { v->v->view(preset(p)); });
}
void bm_viewport_set_background(BmViewport* v, double r, double g, double b) {
  if (v) guardVoid([&] { v->v->setBackground(r, g, b); });
}
void bm_viewport_set_orthographic(BmViewport* v, bool on) {
  if (v) guardVoid([&] { v->v->setOrthographic(on); });
}
uint32_t bm_viewport_pick(BmViewport* v, double x, double y) {
  return v ? guard<uint32_t>(BM_NO_PIECE, [&] { return v->v->pick(x, y); }) : BM_NO_PIECE;
}
void bm_viewport_frame_selection(BmViewport* v) {
  if (v) guardVoid([&] { v->v->frameSelection(); });
}

// ---- Documents ----

void bm_change_free(BmChange c) { bm_string_free(c.refused); }

BmOpenResult bm_session_new_blank(BmSession* s) {
  BmOpenResult out{false, {nullptr, 0}, {nullptr, 0}};
  if (!s) {
    out.error = make("no session");
    return out;
  }
  try {
    bmapp::OpenResult r = s->s->newBlank();
    out.ok = r.ok;
    out.error = make(r.error);
    out.warnings = make(r.warnings);
  } catch (const std::exception& e) {
    out.error = make(e.what());
  } catch (...) {
    out.error = make("the engine failed while making a new project");
  }
  return out;
}

BmString bm_session_project_bytes(const BmSession* s) {
  if (!s) return BmString{nullptr, 0};
  return guard(BmString{nullptr, 0}, [&] { return make(s->s->projectBytes()); });
}

bool bm_session_imported(const BmSession* s) { return s && guard(false, [&] { return s->s->imported(); }); }
bool bm_session_dirty(const BmSession* s) { return s && guard(false, [&] { return s->s->dirty(); }); }
void bm_session_mark_saved(BmSession* s) {
  if (s) guardVoid([&] { s->s->markSaved(); });
}
uint64_t bm_session_version(const BmSession* s) {
  return s ? guard<uint64_t>(0, [&] { return s->s->version(); }) : 0;
}
uint64_t bm_session_structure_version(const BmSession* s) {
  return s ? guard<uint64_t>(0, [&] { return s->s->structureVersion(); }) : 0;
}

bool bm_session_can_undo(const BmSession* s) { return s && guard(false, [&] { return s->s->canUndo(); }); }
bool bm_session_can_redo(const BmSession* s) { return s && guard(false, [&] { return s->s->canRedo(); }); }
BmString bm_session_undo_name(const BmSession* s) {
  if (!s) return BmString{nullptr, 0};
  return guard(BmString{nullptr, 0}, [&] { return make(s->s->undoName()); });
}
BmString bm_session_redo_name(const BmSession* s) {
  if (!s) return BmString{nullptr, 0};
  return guard(BmString{nullptr, 0}, [&] { return make(s->s->redoName()); });
}

}  // extern "C"

namespace {
template <typename F>
BmChange change(BmSession* s, F&& f) {
  BmChange out{false, 0, {nullptr, 0}};
  if (!s) {
    out.refused = make("no document");
    return out;
  }
  try {
    bmapp::Changed c = f();
    out.structure = c.structure;
    out.version = c.version;
    out.refused = make(c.refused);
  } catch (const std::exception& e) {
    out.refused = make(e.what());
  } catch (...) {
    out.refused = make("the engine failed during the edit");
  }
  return out;
}

std::vector<uint32_t> list(const uint32_t* pieces, size_t n) {
  return std::vector<uint32_t>(pieces, pieces + (pieces ? n : 0));
}
}  // namespace

extern "C" {

BmChange bm_session_undo(BmSession* s) {
  return change(s, [&] { return s->s->undo(); });
}
BmChange bm_session_redo(BmSession* s) {
  return change(s, [&] { return s->s->redo(); });
}
BmChange bm_session_remove(BmSession* s, const uint32_t* pieces, size_t n) {
  return change(s, [&] { return s->s->remove(list(pieces, n)); });
}

void bm_session_select_all(BmSession* s) {
  if (s) guardVoid([&] { s->s->selectAll(); });
}
void bm_session_select_none(BmSession* s) {
  if (s) guardVoid([&] { s->s->selectNone(); });
}
void bm_session_hide(BmSession* s, const uint32_t* pieces, size_t n) {
  if (s) guardVoid([&] { s->s->hide(list(pieces, n)); });
}
void bm_session_show_all(BmSession* s) {
  if (s) guardVoid([&] { s->s->showAll(); });
}
size_t bm_session_pieces_of_row(const BmSession* s, const char* id, uint32_t* out, size_t cap) {
  if (!s || !id) return 0;
  return guard<size_t>(0, [&] {
    std::vector<uint32_t> p = s->s->piecesOfRow(id);
    for (size_t i = 0; i < p.size() && i < cap && out; ++i) out[i] = p[i];
    return p.size();
  });
}

}  // extern "C"
