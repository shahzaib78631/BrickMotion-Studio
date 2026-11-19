#include "bmapp/session.h"

#include <algorithm>
#include <exception>
#include <iterator>
#include <map>
#include <set>
#include "bm/doc/source.h"
#include "bm/io.h"
#include "commands.h"
#include "bm/version.h"
#include "engine.h"
#include "session_impl.h"

namespace bmapp {

namespace {
std::string describe(const bm::LoadReport& r) {
  std::string out;
  auto list = [&](const char* what, const std::vector<std::string>& items) {
    for (const std::string& item : items) out += std::string(what) + ": " + item + "\n";
  };
  list("Missing", r.missing);
  list("Loop", r.cycles);
  list("Unknown colour", r.unknownColors);
  if (r.skippedLines) out += std::to_string(r.skippedLines) + " malformed lines\n";
  return out;
}

bool isProject(const std::filesystem::path& path) {
  std::string ext = path.extension().string();
  std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return ext == ".brickmotion";
}
}  // namespace

Session::Session() : impl_(std::make_unique<Impl>()) {}
Session* Session::create() { return new Session(); }

Session::~Session() = default;

std::string Session::ldrawDirectory() {
  std::string dir = bmtools::ldrawDir();
#ifdef BM_DEFAULT_LDRAW
  std::error_code ec;
  if (dir.empty() && std::filesystem::exists(std::filesystem::path(BM_DEFAULT_LDRAW) / "LDConfig.ldr", ec)) dir = BM_DEFAULT_LDRAW;
#endif
  return dir;
}
std::string Session::engineVersion() { return bm::version(); }

OpenResult Session::open(const std::string& path) {
  OpenResult result;
  auto fresh = std::make_unique<Impl>();
  fresh->file = path;
  fresh->ldraw = ldrawDirectory();
  if (fresh->ldraw.empty()) {
    result.error = "No LDraw library was found. Set BM_LDRAW_DIR to the folder that holds LDConfig.ldr.";
    return result;
  }
  try {
    fresh->library = std::make_unique<bm::ldraw::Library>(fresh->ldraw);
    fresh->full = std::make_unique<bm::ldraw::PartCache>(*fresh->library, bm::ldraw::PartCache::defaultDirectory());
    bm::ldraw::FlattenOptions low;
    low.lowResPrimitives = true;
    fresh->low = std::make_unique<bm::ldraw::PartCache>(*fresh->library, bm::ldraw::PartCache::defaultDirectory().parent_path() / "parts-low", low);
    fresh->source = bm::doc::fromFile(fresh->file);
    reflatten(*fresh);
  } catch (const std::exception& e) {
    result.error = e.what();
    return result;
  }
  fresh->imported = !isProject(fresh->file);
  result.ok = true;
  result.warnings = describe(fresh->model->report());
  impl_ = std::move(fresh);
  return result;
}

size_t Session::pieceCount() const { return impl_->model ? impl_->model->pieces().size() : 0; }

std::string Session::title() const { return impl_->file.stem().string(); }

bool Session::imported() const { return impl_->imported; }

Summary Session::summarize(const std::vector<uint32_t>& pieces) const {
  Summary s;
  if (!impl_->model) return s;
  const auto& all = impl_->model->pieces();
  std::set<uint32_t> known;
  std::set<std::string> parts;
  for (uint32_t p : pieces)
    if (p < all.size() && known.insert(p).second) parts.insert(all[p].part);
  s.count = known.size();
  s.parts.assign(parts.begin(), parts.end());
  return s;
}

namespace {
bm::Vec3 engine(Vec3 v) { return {v.x, v.y, v.z}; }
}  // namespace

namespace {
/// Carries a list of pieces over a reflatten: each piece goes where the same items made it now.
std::vector<uint32_t> carried(const std::vector<uint32_t>& pieces, const std::vector<bm::doc::PieceRef>& before, const std::map<std::vector<bm::doc::ItemId>, uint32_t>& now) {
  std::vector<uint32_t> out;
  for (uint32_t p : pieces)
    if (p < before.size())
      if (const auto it = now.find(before[p].chain); it != now.end()) out.push_back(it->second);
  std::sort(out.begin(), out.end());
  out.erase(std::unique(out.begin(), out.end()), out.end());
  return out;
}

/// After an edit: logs it for the viewports, and after a reflatten carries the view state over.
Changed edited(Session::Impl& s, uint64_t before, Changed c) {
  if (c.version == before) return c;
  s.changes.push_back(c);
  while (s.changes.size() > Session::Impl::kChangesKept) s.changes.pop_front();
  if (c.structure) {
    std::map<std::vector<bm::doc::ItemId>, uint32_t> now;
    if (!s.selection.empty() || !s.hidden.empty())
      for (uint32_t p = 0; p < s.refs.size(); p++) now.emplace(s.refs[p].chain, p);
    s.selection = carried(s.selection, s.previousRefs, now);
    s.hidden = carried(s.hidden, s.previousRefs, now);
    s.previousRefs.clear();
    s.selectionStamp++, s.hiddenStamp++;
  }
  return c;
}

std::vector<uint32_t> known(const std::vector<uint32_t>& pieces, size_t count) {
  std::vector<uint32_t> out;
  for (uint32_t p : pieces)
    if (p < count) out.push_back(p);
  std::sort(out.begin(), out.end());
  out.erase(std::unique(out.begin(), out.end()), out.end());
  return out;
}
}  // namespace

#define BM_EDIT(call) \
  if (!impl_->model) return Changed{}; \
  const uint64_t before = impl_->version; \
  return edited(*impl_, before, call)

Changed Session::move(const std::vector<uint32_t>& pieces, Vec3 delta, bool continuing) { BM_EDIT(moveCommand(*impl_, pieces, engine(delta), continuing)); }
Changed Session::rotate(const std::vector<uint32_t>& pieces, Vec3 axis, double degrees, Vec3 pivot, bool continuing) {
  BM_EDIT(rotateCommand(*impl_, pieces, engine(axis), degrees, engine(pivot), continuing));
}
Changed Session::recolor(const std::vector<uint32_t>& pieces, int code) { BM_EDIT(recolorCommand(*impl_, pieces, code)); }
Changed Session::remove(const std::vector<uint32_t>& pieces) { BM_EDIT(removeCommand(*impl_, pieces)); }
Changed Session::duplicate(const std::vector<uint32_t>& pieces, Vec3 offset) { BM_EDIT(duplicateCommand(*impl_, pieces, engine(offset))); }
std::string Session::copy(const std::vector<uint32_t>& pieces) const { return impl_->model ? copyText(*impl_, pieces) : ""; }
Changed Session::paste(const std::string& text, Vec3 offset) { BM_EDIT(pasteCommand(*impl_, text, engine(offset))); }
Changed Session::replacePart(const std::vector<uint32_t>& pieces, const std::string& part) { BM_EDIT(replaceCommand(*impl_, pieces, part)); }
Changed Session::makeUnique(uint32_t piece) { BM_EDIT(makeUniqueCommand(*impl_, piece)); }
Changed Session::undo() { BM_EDIT(undoCommand(*impl_)); }
Changed Session::redo() { BM_EDIT(redoCommand(*impl_)); }
#undef BM_EDIT

void Session::select(const std::vector<uint32_t>& pieces, SelectMode mode) {
  Impl& s = *impl_;
  const std::vector<uint32_t> given = known(pieces, pieceCount());
  std::vector<uint32_t> out;
  switch (mode) {
    case SelectMode::Replace: out = given; break;
    case SelectMode::Add: std::set_union(s.selection.begin(), s.selection.end(), given.begin(), given.end(), std::back_inserter(out)); break;
    case SelectMode::Toggle: std::set_symmetric_difference(s.selection.begin(), s.selection.end(), given.begin(), given.end(), std::back_inserter(out)); break;
  }
  if (out == s.selection) return;
  s.selection = std::move(out);
  s.selectionStamp++;
}

void Session::selectAll() {
  std::vector<uint32_t> all;
  const std::vector<uint32_t>& hidden = impl_->hidden;
  for (uint32_t p = 0; p < pieceCount(); p++)
    if (!std::binary_search(hidden.begin(), hidden.end(), p)) all.push_back(p);
  select(all, SelectMode::Replace);
}
void Session::selectNone() { select({}, SelectMode::Replace); }
std::vector<uint32_t> Session::selection() const { return impl_->selection; }

void Session::hide(const std::vector<uint32_t>& pieces) {
  Impl& s = *impl_;
  const std::vector<uint32_t> given = known(pieces, pieceCount());
  std::vector<uint32_t> out;
  std::set_union(s.hidden.begin(), s.hidden.end(), given.begin(), given.end(), std::back_inserter(out));
  if (out == s.hidden) return;
  s.hidden = std::move(out);
  s.hiddenStamp++;
}
void Session::showAll() {
  if (impl_->hidden.empty()) return;
  impl_->hidden.clear();
  impl_->hiddenStamp++;
}
std::vector<uint32_t> Session::hidden() const { return impl_->hidden; }

Snapshot Session::snapshot() const {
  Impl& s = *impl_;
  if (s.snapshot && s.snapshotVersion == s.version && s.snapshotSelection == s.selectionStamp && s.snapshotHidden == s.hiddenStamp) return *s.snapshot;
  Snapshot out;
  out.version = s.version;
  out.pieces = pieceCount();
  out.selection = s.selection;
  out.undoName = undoName(), out.redoName = redoName();
  out.dirty = dirty();
  out.hidden = s.hidden.size();
  if (s.model && !s.selection.empty()) {
    // A submodel is shared when more than one use reaches it: count the uses by their chains.
    std::map<std::string, std::set<std::vector<bm::doc::ItemId>>> uses;
    for (uint32_t p = 0; p < s.refs.size(); p++) {
      const auto& path = s.model->pieces()[p].path;
      const auto& chain = s.refs[p].chain;
      if (!path.empty() && chain.size() >= 2) uses[path.back()].insert(std::vector<bm::doc::ItemId>(chain.begin(), chain.end() - 1));
    }
    const auto& colors = s.library->colors();
    for (size_t i = 0; i < s.selection.size() && i < 200; i++) {
      const uint32_t p = s.selection[i];
      const bm::Piece& piece = s.model->pieces()[p];
      PieceInfo info;
      info.piece = p;
      info.part = piece.part;
      if (const bm::ldraw::File* f = s.library->find(piece.part)) info.description = f->description;
      info.color = piece.color;
      if (const auto c = colors.find(piece.color); c != colors.end()) info.colorName = c->second.name;
      info.step = piece.step;
      for (const std::string& name : piece.path) info.submodelPath += (info.submodelPath.empty() ? "" : "/") + name;
      info.inSharedSubmodel = !piece.path.empty() && uses[piece.path.back()].size() > 1;
      info.position = {piece.world.t.x, piece.world.t.y, piece.world.t.z};
      out.selected.push_back(std::move(info));
    }
  }
  s.snapshot = out;
  s.snapshotVersion = s.version, s.snapshotSelection = s.selectionStamp, s.snapshotHidden = s.hiddenStamp;
  return out;
}

void Session::endGesture() {
  History& h = impl_->history;
  if (h.cursor > 0) h.done[h.cursor - 1].open = false;
}
bool Session::canUndo() const { return impl_->history.cursor > 0; }
bool Session::canRedo() const { return impl_->history.cursor < impl_->history.done.size(); }
std::string Session::undoName() const { return canUndo() ? impl_->history.done[impl_->history.cursor - 1].name : ""; }
std::string Session::redoName() const { return canRedo() ? impl_->history.done[impl_->history.cursor].name : ""; }
bool Session::dirty() const { return impl_->history.saved != static_cast<long>(impl_->history.cursor); }
void Session::markSaved() { impl_->history.saved = static_cast<long>(impl_->history.cursor); }
uint64_t Session::version() const { return impl_->version; }

}  // namespace bmapp

void bmappRetainSession(bmapp::Session* s) { s->refs_.fetch_add(1, std::memory_order_relaxed); }
void bmappReleaseSession(bmapp::Session* s) {
  if (s->refs_.fetch_sub(1, std::memory_order_acq_rel) == 1) delete s;
}
