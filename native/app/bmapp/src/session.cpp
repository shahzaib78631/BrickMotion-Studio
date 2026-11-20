#include "bmapp/session.h"
#include "animation_keys.h"
#include "bmapp/part_catalog.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <atomic>
#include <exception>
#include <sstream>
#include <stdexcept>
#include <fstream>
#include <iterator>
#include <map>
#include <set>
#include "bm/doc/source.h"
#include "bm/io.h"
#include "commands.h"
#include "bm/version.h"
#include "engine.h"
#include "session_impl.h"
#include "model_import_impl.h"

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

Session::Session() : impl_(std::make_shared<Impl>()) {}
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

namespace {
std::atomic<uint64_t> generations{0};

std::string readText(const std::filesystem::path& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) throw std::runtime_error("“" + path.filename().string() + "” could not be read.");
  std::ostringstream s;
  s << f.rdbuf();
  return s.str();
}
}  // namespace

/// Opens into a fresh state: `read` fills its source (and base), and only a whole success
/// replaces what the session had.
template <class Read>
static OpenResult openWith(std::shared_ptr<Session::Impl>& impl, const std::string& path, Read read) {
  OpenResult result;
  auto fresh = std::make_shared<Session::Impl>();
  fresh->file = path;
  fresh->ldraw = Session::ldrawDirectory();
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
    read(*fresh);
    reflatten(*fresh);
  } catch (const std::exception& e) {
    result.error = e.what();
    return result;
  }
  fresh->imported = !isProject(fresh->file);
  fresh->generation = ++generations;
  result.ok = true;
  result.warnings = describe(fresh->model->report());
  impl = std::move(fresh);
  return result;
}

OpenResult Session::open(const std::string& path) {
  return openWith(impl_, path, [](Impl& s) {
    s.source = bm::doc::fromFile(s.file);
    if (isProject(s.file)) s.base = bm::doc::readProjectFile(readText(s.file));
  });
}

OpenResult Session::newBlank() {
  return openWith(impl_, "Untitled.brickmotion", [](Impl& s) {
    s.source.root.steps.emplace_back();
  });
}

OpenResult Session::openBytes(const std::string& bytes, const std::string& path) {
  return openWith(impl_, path, [&](Impl& s) {
    s.base = bm::doc::readProjectFile(bytes);
    s.source = bm::doc::fromPlan(bm::io::readProject(bytes));
  });
}

void Session::adoptLoadedSession(const Session* loaded) {
  if (loaded && loaded->impl_->generation) impl_ = loaded->impl_;
}

uint64_t Session::generation() const { return impl_->generation; }

namespace {
/// The document as a project holds it. Plans have no colour 16 that takes its holder's colour,
/// so an LDraw import's 16 parts are given the colour their pieces show when all agree.
bm::doc::Source forProject(const Session::Impl& s) {
  bm::doc::Source out = s.source;
  // The web requires the plan's name; an import has none of its own: it takes the file's.
  if (!out.extra.is_object()) out.extra = nlohmann::ordered_json::object();
  if (!out.extra.contains("format")) out.extra["format"] = "brickmotion-plan";
  if (!out.extra.contains("version")) out.extra["version"] = 1;
  if (!out.extra.contains("name")) out.extra["name"] = s.file.stem().string();
  if (out.origin != bm::doc::Origin::LDraw || !s.model) return out;
  auto bake = [&](bm::doc::Def& def) {
    for (bm::doc::Step& step : def.steps)
      for (bm::doc::Item& item : step.items) {
        if (item.submodel || item.color != 16) continue;
        const auto it = s.piecesOf.find(item.id);
        if (it == s.piecesOf.end() || it->second.empty()) continue;
        std::set<int> colors;
        for (uint32_t p : it->second) colors.insert(s.model->pieces()[p].color);
        if (colors.size() != 1 || *colors.begin() == 16) continue;
        item.color = *colors.begin();
        item.colorText = std::to_string(item.color);
      }
  };
  bake(out.root);
  for (auto& [name, def] : out.submodels) bake(def);
  return out;
}
}  // namespace

std::string Session::projectBytes() const {
  const Impl& s = *impl_;
  return bm::doc::writeProject(s.base ? *s.base : bm::doc::Project{}, forProject(s), s.timelinesStale || dirty());
}
std::string Session::projectBytesWithPreview(const std::string& pngBase64) const {
  const Impl& s = *impl_;
  auto base = s.base ? *s.base : bm::doc::Project{};
  if (!base.json.is_object()) base.json = nlohmann::ordered_json::object();
  if (!pngBase64.empty()) base.json["brickmotionPreview"] = {{"version", 1}, {"png", pngBase64}};
  else if (dirty()) base.json.erase("brickmotionPreview");
  return bm::doc::writeProject(base, forProject(s), s.timelinesStale || dirty());
}
std::string Session::planBytes() const { return bm::doc::toPlan(forProject(*impl_)).json.dump(2) + "\n"; }

std::string Session::mpdBytes() const { return impl_->library ? bm::doc::writeMpd(impl_->source, *impl_->library) : ""; }

size_t Session::pieceCount() const { return impl_->model ? impl_->model->pieces().size() : 0; }

std::string Session::title() const { return impl_->file.stem().string(); }

bool Session::imported() const { return impl_->imported; }

PartMatch Session::partAt(uint32_t piece) const {
  if (!impl_->model || piece >= impl_->model->pieces().size()) return {};
  const auto& part = impl_->model->pieces()[piece].part;
  const auto* file = impl_->model->library().find(part);
  return {part, file && !file->description.empty() ? file->description : part, {}};
}
bool Session::isLocalPiece(uint32_t piece) const {
  return piece < impl_->refs.size() && impl_->refs[piece].chain.size() == 1;
}

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
bm::Xform engine(const PartPose& pose) {
  bm::Xform out;
  out.t = engine(pose.position);
  std::copy_n(pose.rotation.m, 9, out.r.m);
  return out;
}
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
/// With `selectNew` the pieces the edit made become the selection.
Changed edited(Session::Impl& s, uint64_t before, Changed c, bool selectNew = false) {
  if (c.version == before) return c;
  s.changes.push_back(c);
  while (s.changes.size() > Session::Impl::kChangesKept) s.changes.pop_front();
  if (c.structure) {
    s.structureVersion++;
    if (!c.removed.empty()) {
      const auto compact = [&](PieceList& list) {
        size_t kept = 0;
        for (uint32_t old : list) {
          const auto prior = std::lower_bound(c.removed.begin(), c.removed.end(), old);
          if (prior == c.removed.end() || *prior != old)
            list[kept++] = old - static_cast<uint32_t>(prior - c.removed.begin());
        }
        list.resize(kept);
      };
      compact(s.selection);
      compact(s.hidden);
    } else {
      std::map<std::vector<bm::doc::ItemId>, uint32_t> now;
      if (!s.selection.empty() || !s.hidden.empty())
        for (uint32_t p = 0; p < s.refs.size(); p++) now.emplace(s.refs[p].chain, p);
      if (selectNew) {
        std::set<std::vector<bm::doc::ItemId>> old;
        for (const bm::doc::PieceRef& r : s.previousRefs) old.insert(r.chain);
        s.selection.clear();
        for (uint32_t p = 0; p < s.refs.size(); p++)
          if (!old.count(s.refs[p].chain)) s.selection.push_back(p);
      } else {
        s.selection = carried(s.selection, s.previousRefs, now);
      }
      s.hidden = carried(s.hidden, s.previousRefs, now);
    }
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

#define BM_EDIT(call) BM_EDIT_SELECTING(call, false)
#define BM_EDIT_SELECTING(call, selectNew) \
  if (!impl_->model) return Changed{}; \
  const uint64_t before = impl_->version; \
  return edited(*impl_, before, call, selectNew)

Changed Session::move(const std::vector<uint32_t>& pieces, Vec3 delta, bool continuing) { BM_EDIT(moveCommand(*impl_, pieces, engine(delta), continuing)); }
Changed Session::rotate(const std::vector<uint32_t>& pieces, Vec3 axis, double degrees, Vec3 pivot, bool continuing) {
  BM_EDIT(rotateCommand(*impl_, pieces, engine(axis), degrees, engine(pivot), continuing));
}
Changed Session::recolor(const std::vector<uint32_t>& pieces, int code) { BM_EDIT(recolorCommand(*impl_, pieces, code)); }
Changed Session::remove(const std::vector<uint32_t>& pieces) { BM_EDIT(removeCommand(*impl_, pieces)); }
Changed Session::duplicate(const std::vector<uint32_t>& pieces, Vec3 offset) { BM_EDIT_SELECTING(duplicateCommand(*impl_, pieces, engine(offset)), true); }
std::string Session::copy(const std::vector<uint32_t>& pieces) const { return impl_->model ? copyText(*impl_, pieces) : ""; }
Changed Session::paste(const std::string& text, Vec3 offset) { BM_EDIT_SELECTING(pasteCommand(*impl_, focusedDef(*impl_), text, engine(offset)), true); }
Changed Session::placePart(const std::string& part, int color, const PartPose& pose, int step,
                           uint64_t generation, uint64_t version) {
  if (!impl_->model || impl_->generation != generation || impl_->version != version)
    return refusal(*impl_, "The model changed. Preview the placement again.");
  BM_EDIT_SELECTING(placePartCommand(*impl_, focusedDef(*impl_), part, color, engine(pose), step), true);
}
Changed Session::placeMoved(const PieceList& pieces, uint32_t anchor, const PartPose& pose,
                            uint64_t generation, uint64_t version) {
  if (!impl_->model || impl_->generation != generation || impl_->version != version)
    return refusal(*impl_, "The model changed. Preview the move again.");
  BM_EDIT(placeMovedCommand(*impl_, pieces, anchor, engine(pose)));
}
Changed Session::setGroup(const PieceList& pieces, const std::string& group) {
  BM_EDIT(setGroupCommand(*impl_, pieces, group));
}
Changed Session::importModel(const ModelImport* file, const std::string& into, uint64_t generation) {
  if (impl_->generation != generation) return refusal(*impl_, "The document changed before the import finished.");
  if (!file || !file->impl_->source) return refusal(*impl_, file ? file->error() : "The file could not be read.");
  BM_EDIT(importModelCommand(*impl_, into, *file->impl_->source, file->impl_->name));
}
StringList Session::groupNames() const {
  std::set<std::string> groups;
  const auto* def = impl_->source.def(focusedDef(*impl_));
  if (def)
    for (const auto& step : def->steps)
      for (const auto& item : step.items)
        if (auto group = groupOf(item); !group.empty()) groups.insert(std::move(group));
  return {groups.begin(), groups.end()};
}
StringList Session::groupsOf(const PieceList& pieces) const { return groupsOfItems(*impl_, pieces); }
void Session::selectGroup(const std::string& group) {
  if (group.empty()) return;
  PieceList selected;
  if (const auto* def = impl_->source.def(focusedDef(*impl_))) {
    for (const auto& step : def->steps) {
      for (const auto& item : step.items) {
        if (groupOf(item) != group) continue;
        if (const auto it = impl_->piecesOf.find(item.id); it != impl_->piecesOf.end())
          for (uint32_t p : it->second)
            if (!std::binary_search(impl_->hidden.begin(), impl_->hidden.end(), p)) selected.push_back(p);
      }
    }
  }
  select(selected, SelectMode::Replace);
}
Changed Session::replacePart(const std::vector<uint32_t>& pieces, const std::string& part) { BM_EDIT(replaceCommand(*impl_, pieces, part)); }
Changed Session::makeUnique(uint32_t piece) { BM_EDIT(makeUniqueCommand(*impl_, piece)); }
size_t Session::stepCount() const { return stepCountOf(*impl_, focusedDef(*impl_)); }
StepFields Session::stepFields(size_t at) const { return stepFieldsOf(*impl_, focusedDef(*impl_), at); }
Changed Session::insertStep(size_t at) { BM_EDIT(insertStepCommand(*impl_, focusedDef(*impl_), at)); }
Changed Session::deleteStep(size_t at) { BM_EDIT(deleteStepCommand(*impl_, focusedDef(*impl_), at)); }
Changed Session::moveStep(size_t from, size_t to) { BM_EDIT(moveStepCommand(*impl_, focusedDef(*impl_), from, to)); }
Changed Session::splitStep(size_t at, const std::vector<uint32_t>& pieces) { BM_EDIT(splitStepCommand(*impl_, focusedDef(*impl_), at, pieces)); }
Changed Session::mergeSteps(size_t first) { BM_EDIT(mergeStepsCommand(*impl_, focusedDef(*impl_), first)); }
Changed Session::setStepFields(size_t at, const StepFields& fields, bool continuing) {
  BM_EDIT(setStepFieldsCommand(*impl_, focusedDef(*impl_), at, fields, continuing));
}
MotionFields Session::motionFields(MotionScope scope, size_t step, const PieceList& pieces) const {
  return motionFieldsOf(*impl_, scope, step, pieces);
}
Changed Session::setMotionFields(MotionScope scope, size_t step, const PieceList& pieces, const MotionFields& fields) {
  BM_EDIT(setMotionFieldsCommand(*impl_, scope, step, pieces, fields));
}
Changed Session::turnWaitingPart(uint32_t piece, double degrees) {
  BM_EDIT(turnWaitingPartCommand(*impl_, piece, degrees));
}
Changed Session::setInsertionDirection(const PieceList& pieces, Vec3 direction) {
  BM_EDIT(setInsertionDirectionCommand(*impl_, pieces, engine(direction)));
}
Vec3 Session::insertionDirection(uint32_t piece) const {
  const auto d = insertionDirectionOf(*impl_, piece);
  return {d.x, d.y, d.z};
}
Changed Session::scale(const PieceList& pieces, Vec3 factor, Mat3 axes, Vec3 pivot, bool continuing) {
  bm::Mat3 basis;
  std::copy_n(axes.m, 9, basis.m);
  BM_EDIT(scaleCommand(*impl_, pieces, engine(factor), basis, engine(pivot), continuing));
}
KeyScene Session::keyScene() const { return readKeyScene(*impl_); }
std::vector<KeyTrack> Session::keyTracks() const { return readKeyTracks(*impl_); }
double Session::keyValue(uint32_t piece, KeyChannel channel, double frame) const {
  const auto tracks = readKeyTracks(*impl_);
  const auto track = std::find_if(tracks.begin(), tracks.end(), [&](const auto& row) { return row.object == piece; });
  if (track != tracks.end()) return sampleKeys(*track, channel, frame);
  return channel >= KeyChannel::ScaleX ? 1 : 0;
}
Changed Session::setKeyScene(const KeyScene& scene) { BM_EDIT(setKeySceneCommand(*impl_, scene)); }
Changed Session::setKeys(uint32_t piece, const KeyList& keys, bool continuing) {
  BM_EDIT(setKeysCommand(*impl_, piece, keys, continuing, false));
}
Changed Session::removeKeys(uint32_t piece, const KeyList& keys) {
  BM_EDIT(setKeysCommand(*impl_, piece, keys, false, true));
}
Changed Session::moveKey(uint32_t piece, KeyChannel channel, int from, int to) {
  BM_EDIT(moveKeyCommand(*impl_, piece, channel, from, to));
}
Changed Session::setBakedKeys(uint32_t piece, const KeyList& keys) {
  BM_EDIT(setKeysCommand(*impl_, piece, keys, false, false, true));
}
Changed Session::moveToStep(const std::vector<uint32_t>& pieces, size_t step) { BM_EDIT(moveToStepCommand(*impl_, focusedDef(*impl_), pieces, step)); }
Changed Session::reorderInStep(size_t step, size_t from, size_t to) { BM_EDIT(reorderInStepCommand(*impl_, focusedDef(*impl_), step, from, to)); }
Changed Session::reorderArrival(size_t step, size_t from, size_t to) { BM_EDIT(reorderInStepCommand(*impl_, focusedDef(*impl_), step, from, to, true)); }
Changed Session::regenerateSteps(const PieceList& buildOrder) { BM_EDIT(regenerateStepsCommand(*impl_, buildOrder)); }
Changed Session::focus(const StringList& path) { BM_EDIT(focusCommand(*impl_, path)); }
StringList Session::focusPath() const { return impl_->focus; }
std::string Session::focused() const { return focusedDef(*impl_); }
std::string Session::freeSubmodelName(const std::string& preferred) const { return freeName(*impl_, preferred); }
Changed Session::newSubmodel(const std::string& name) { BM_EDIT(newSubmodelCommand(*impl_, name)); }
Changed Session::makeSubmodel(const std::vector<uint32_t>& pieces, const std::string& name) {
  BM_EDIT_SELECTING(makeSubmodelCommand(*impl_, focusedDef(*impl_), pieces, name), true);
}
Changed Session::extract(uint32_t piece) { BM_EDIT_SELECTING(extractCommand(*impl_, focusedDef(*impl_), piece), true); }
Changed Session::moveToModel(const std::vector<uint32_t>& pieces, const std::string& submodel) {
  BM_EDIT_SELECTING(moveToModelCommand(*impl_, focusedDef(*impl_), pieces, submodel), true);
}
Changed Session::renameSubmodel(const std::string& from, const std::string& to) { BM_EDIT(renameSubmodelCommand(*impl_, from, to)); }
Changed Session::deleteSubmodel(const std::string& name) { BM_EDIT(deleteSubmodelCommand(*impl_, name)); }
Changed Session::undo() { BM_EDIT(undoCommand(*impl_)); }
Changed Session::redo() { BM_EDIT(redoCommand(*impl_)); }
#undef BM_EDIT
#undef BM_EDIT_SELECTING

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
void Session::show(const std::vector<uint32_t>& pieces) {
  Impl& s = *impl_;
  const std::vector<uint32_t> given = known(pieces, pieceCount());
  std::vector<uint32_t> out;
  std::set_difference(s.hidden.begin(), s.hidden.end(), given.begin(), given.end(), std::back_inserter(out));
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
  out.focus = focusedDef(s);
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
      const auto& partLibrary = s.model->library();
      info.inlinePart = partLibrary.isInline(piece.part);
      if (const bm::ldraw::File* f = partLibrary.find(piece.part)) info.description = f->description;
      info.color = piece.color;
      if (const auto c = colors.find(piece.color); c != colors.end()) info.colorName = colorDisplayName(c->second.name);
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
void Session::markSaved() {
  if (dirty()) impl_->timelinesStale = true;
  impl_->history.saved = static_cast<long>(impl_->history.cursor);
}
uint64_t Session::version() const { return impl_->version; }
size_t Session::undoDepth() const { return impl_->history.cursor; }

Mat3 Session::axesOf(uint32_t piece) const {
  Mat3 out;
  if (!impl_->model || piece >= impl_->model->pieces().size()) return out;
  const bm::Mat3& r = impl_->model->pieces()[piece].world.r;
  for (int c = 0; c < 3; c++) {
    const double len = std::sqrt(r.m[c] * r.m[c] + r.m[3 + c] * r.m[3 + c] + r.m[6 + c] * r.m[6 + c]);
    if (!(len > 1e-12)) return Mat3{};
    for (int row = 0; row < 3; row++) out.m[row * 3 + c] = r.m[row * 3 + c] / len;
  }
  return out;
}

std::vector<uint32_t> Session::usePieces(uint32_t piece) const {
  const Impl& s = *impl_;
  if (piece >= s.refs.size()) return {};
  const auto& chain = s.refs[piece].chain;
  if (chain.size() < 2) return {piece};
  std::vector<uint32_t> out = s.piecesOf.at(chain.front());
  std::sort(out.begin(), out.end());
  return out;
}

std::vector<PartMatch> Session::searchParts(const std::string& query, size_t limit) const {
  if (query.find_first_not_of(" \t\r\n\f\v") == std::string::npos) return {};
  return libraryParts(impl_->ldraw, query, "", limit);
}

}  // namespace bmapp

void bmappRetainSession(bmapp::Session* s) { s->refs_.fetch_add(1, std::memory_order_relaxed); }
void bmappReleaseSession(bmapp::Session* s) {
  if (s->refs_.fetch_sub(1, std::memory_order_acq_rel) == 1) delete s;
}
