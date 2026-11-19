#include "bmapp/session.h"

#include <algorithm>
#include <exception>
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

Changed Session::move(const std::vector<uint32_t>& pieces, Vec3 delta, bool continuing) {
  return impl_->model ? moveCommand(*impl_, pieces, engine(delta), continuing) : Changed{};
}
Changed Session::rotate(const std::vector<uint32_t>& pieces, Vec3 axis, double degrees, Vec3 pivot, bool continuing) {
  return impl_->model ? rotateCommand(*impl_, pieces, engine(axis), degrees, engine(pivot), continuing) : Changed{};
}
Changed Session::recolor(const std::vector<uint32_t>& pieces, int code) { return impl_->model ? recolorCommand(*impl_, pieces, code) : Changed{}; }
Changed Session::remove(const std::vector<uint32_t>& pieces) { return impl_->model ? removeCommand(*impl_, pieces) : Changed{}; }
Changed Session::duplicate(const std::vector<uint32_t>& pieces, Vec3 offset) {
  return impl_->model ? duplicateCommand(*impl_, pieces, engine(offset)) : Changed{};
}
std::string Session::copy(const std::vector<uint32_t>& pieces) const { return impl_->model ? copyText(*impl_, pieces) : ""; }
Changed Session::paste(const std::string& text, Vec3 offset) { return impl_->model ? pasteCommand(*impl_, text, engine(offset)) : Changed{}; }
Changed Session::replacePart(const std::vector<uint32_t>& pieces, const std::string& part) {
  return impl_->model ? replaceCommand(*impl_, pieces, part) : Changed{};
}
Changed Session::makeUnique(uint32_t piece) { return impl_->model ? makeUniqueCommand(*impl_, piece) : Changed{}; }
void Session::endGesture() {
  History& h = impl_->history;
  if (h.cursor > 0) h.done[h.cursor - 1].open = false;
}
bool Session::canUndo() const { return impl_->history.cursor > 0; }
bool Session::canRedo() const { return impl_->history.cursor < impl_->history.done.size(); }
std::string Session::undoName() const { return canUndo() ? impl_->history.done[impl_->history.cursor - 1].name : ""; }
std::string Session::redoName() const { return canRedo() ? impl_->history.done[impl_->history.cursor].name : ""; }
Changed Session::undo() { return undoCommand(*impl_); }
Changed Session::redo() { return redoCommand(*impl_); }
bool Session::dirty() const { return impl_->history.saved != static_cast<long>(impl_->history.cursor); }
void Session::markSaved() { impl_->history.saved = static_cast<long>(impl_->history.cursor); }
uint64_t Session::version() const { return impl_->version; }

}  // namespace bmapp

void bmappRetainSession(bmapp::Session* s) { s->refs_.fetch_add(1, std::memory_order_relaxed); }
void bmappReleaseSession(bmapp::Session* s) {
  if (s->refs_.fetch_sub(1, std::memory_order_acq_rel) == 1) delete s;
}
