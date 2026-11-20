// What the panes list: the outline, the steps and their items, colours; and Select Similar.
#include <algorithm>
#include <set>
#include <unordered_map>
#include "commands.h"
#include "session_impl.h"

namespace bmapp {

namespace {
using bm::doc::Def;
using bm::doc::Item;
using bm::doc::ItemId;

/// Parts under each def, at any depth (a loop counts nothing), made once per call.
struct Counter {
  const bm::doc::Source& src;
  std::unordered_map<std::string, size_t> done;
  std::set<std::string> walking;

  size_t of(const std::string& name) {
    if (const auto it = done.find(name); it != done.end()) return it->second;
    const Def* d = src.def(name);
    if (!d || !walking.insert(name).second) return 0;
    size_t n = 0;
    for (const auto& step : d->steps)
      for (const Item& i : step.items) n += i.submodel ? of(i.name) : 1;
    walking.erase(name);
    return done[name] = n;
  }
  size_t of(const Item& i) { return i.submodel ? of(i.name) : 1; }
};

std::unordered_map<std::string, size_t> useCounts(const bm::doc::Source& src) {
  std::unordered_map<std::string, size_t> out;
  auto count = [&](const Def& d) {
    for (const auto& step : d.steps)
      for (const Item& i : step.items)
        if (i.submodel) out[i.name]++;
  };
  count(src.root);
  for (const auto& [n, d] : src.submodels) count(d);
  return out;
}

const Item* findItem(const bm::doc::Source& src, ItemId id) {
  auto in = [&](const Def& d) -> const Item* {
    for (const auto& step : d.steps)
      for (const Item& i : step.items)
        if (i.id == id) return &i;
    return nullptr;
  };
  if (const Item* i = in(src.root)) return i;
  for (const auto& [n, d] : src.submodels)
    if (const Item* i = in(d)) return i;
  return nullptr;
}

/// The use items of a row id ("root" none).
std::vector<ItemId> chainOf(const std::string& id) {
  std::vector<ItemId> out;
  if (id == "root" || id.rfind("unused/", 0) == 0) return out;
  size_t start = 0;
  while (start <= id.size()) {
    const size_t slash = id.find('/', start);
    const std::string part = id.substr(start, slash == std::string::npos ? std::string::npos : slash - start);
    try {
      out.push_back(std::stoull(part));
    } catch (...) {
      return {};
    }
    if (slash == std::string::npos) break;
    start = slash + 1;
  }
  return out;
}
}  // namespace

uint64_t Session::structureVersion() const { return impl_->structureVersion + (impl_->generation << 32); }

std::vector<OutlineRow> Session::outline() const {
  const Impl& s = *impl_;
  if (s.outline && s.outlineStamp == structureVersion()) return *s.outline;
  std::vector<OutlineRow> rows;
  Counter count{s.source, {}, {}};
  const auto uses = useCounts(s.source);
  std::set<std::string> walking;
  // Each use under `def`, depth first, in step order.
  auto walk = [&](auto& self, const std::string& def, const std::string& prefix, int parent, int depth) -> void {
    const Def* d = s.source.def(def);
    if (!d || !walking.insert(def).second) return;
    for (const auto& step : d->steps)
      for (const Item& i : step.items) {
        if (!i.submodel) continue;
        OutlineRow r;
        r.id = prefix.empty() ? std::to_string(i.id) : prefix + "/" + std::to_string(i.id);
        r.def = i.name;
        r.name = i.name;
        r.group = groupOf(i);
        r.depth = depth;
        r.parent = parent;
        r.pieces = count.of(i.name);
        r.uses = uses.count(i.name) ? uses.at(i.name) : 0;
        r.shared = r.uses > 1;
        r.useItem = i.id;
        rows.push_back(r);
        const std::string id = r.id;
        self(self, i.name, id, static_cast<int>(rows.size()) - 1, depth + 1);
      }
    walking.erase(def);
  };
  OutlineRow root;
  root.id = "root";
  root.name = s.file.stem().string();
  root.pieces = count.of(std::string());
  rows.push_back(root);
  walk(walk, "", "", 0, 1);
  for (const auto& [name, def] : s.source.submodels) {
    if (uses.count(name)) continue;
    OutlineRow r;
    r.id = "unused/" + name;
    r.def = name;
    r.name = name;
    r.pieces = count.of(name);
    r.unused = true;
    rows.push_back(r);
    walk(walk, name, r.id, static_cast<int>(rows.size()) - 1, 1);
  }
  s.outline = rows;
  s.outlineStamp = structureVersion();
  return rows;
}

std::vector<StepRow> Session::steps() const {
  const Impl& s = *impl_;
  if (s.steps && s.stepsStamp == structureVersion()) return *s.steps;
  auto rows = stepsOfSubmodel(focusedDef(s));
  s.steps = rows;
  s.stepsStamp = structureVersion();
  return rows;
}

std::vector<StepRow> Session::stepsOfSubmodel(const std::string& definition) const {
  const Impl& s = *impl_;
  std::vector<StepRow> rows;
  const Def* d = s.source.def(definition);
  Counter count{s.source, {}, {}};
  if (d)
    for (size_t k = 0; k < d->steps.size(); k++) {
      const StepFields f = stepFieldsOf(s, definition, k);
      StepRow r;
      r.index = k;
      r.title = f.title, r.notes = f.notes, r.pauseAfter = f.pauseAfter, r.pinOrder = f.pinOrder;
      const auto& extra = d->steps[k].extra;
      r.automatic = extra.is_object() && extra.value("auto", false);
      r.items = d->steps[k].items.size();
      for (const Item& i : d->steps[k].items) {
        r.pieces += count.of(i);
        r.submodels += i.submodel;
      }
      rows.push_back(std::move(r));
    }
  return rows;
}

std::vector<ItemRow> Session::stepItems(size_t step) const {
  const Impl& s = *impl_;
  const Def* d = s.source.def(focusedDef(s));
  std::vector<ItemRow> rows;
  if (!d || step >= d->steps.size()) return rows;
  const auto& colors = s.library->colors();
  for (size_t k = 0; k < d->steps[step].items.size(); k++) {
    const Item& i = d->steps[step].items[k];
    ItemRow r;
    r.item = i.id;
    r.name = i.name;
    r.group = groupOf(i);
    r.submodel = i.submodel;
    r.step = step, r.index = k;
    if (i.submodel) {
      r.description = "Submodel";
    } else {
      if (const bm::ldraw::File* f = s.library->find(i.name)) r.description = f->description;
      r.color = bm::doc::colorCode(i, *s.library);
      if (const auto c = colors.find(r.color); c != colors.end()) r.colorName = colorDisplayName(c->second.name);
    }
    if (const auto p = s.piecesOf.find(i.id); p != s.piecesOf.end()) {
      for (uint32_t piece : p->second)
        if (s.refs[piece].chain.front() == i.id) r.pieces.push_back(piece);
    }
    rows.push_back(std::move(r));
  }
  return rows;
}

std::vector<uint32_t> Session::piecesOfRow(const std::string& outlineId) const {
  const Impl& s = *impl_;
  if (outlineId.rfind("unused/", 0) == 0) return {};
  const std::vector<ItemId> chain = chainOf(outlineId);
  if (outlineId != "root" && chain.empty()) return {};
  // The row's uses that lead to the focused def must be the focus path; the rest are inside it.
  if (chain.size() < s.focus.size()) return {};
  for (size_t k = 0; k < s.focus.size(); k++) {
    const Item* use = findItem(s.source, chain[k]);
    if (!use || use->name != s.focus[k]) return {};
  }
  const std::vector<ItemId> inside(chain.begin() + static_cast<long>(s.focus.size()), chain.end());
  std::vector<uint32_t> out;
  if (inside.empty()) {
    for (uint32_t p = 0; p < s.refs.size(); p++) out.push_back(p);
    return out;
  }
  const auto found = s.piecesOf.find(inside.back());
  if (found == s.piecesOf.end()) return {};
  for (uint32_t p : found->second) {
    const auto& c = s.refs[p].chain;
    if (c.size() >= inside.size() && std::equal(inside.begin(), inside.end(), c.begin())) out.push_back(p);
  }
  std::sort(out.begin(), out.end());
  return out;
}

std::vector<uint32_t> Session::piecesOfStep(size_t step) const {
  std::vector<uint32_t> out;
  for (const ItemRow& r : stepItems(step)) out.insert(out.end(), r.pieces.begin(), r.pieces.end());
  std::sort(out.begin(), out.end());
  return out;
}

void Session::selectSimilar(Similar kind) {
  const Impl& s = *impl_;
  if (!s.model) return;
  const auto& pieces = s.model->pieces();
  std::set<std::string> parts;
  std::set<int> colors, steps;
  std::set<std::pair<std::string, int>> both;
  for (uint32_t p : s.selection) {
    parts.insert(pieces[p].part), colors.insert(pieces[p].color), steps.insert(pieces[p].step);
    both.emplace(pieces[p].part, pieces[p].color);
  }
  if (s.selection.empty()) return;
  const std::set<uint32_t> hidden(s.hidden.begin(), s.hidden.end());
  std::vector<uint32_t> out;
  for (uint32_t p = 0; p < pieces.size(); p++) {
    if (hidden.count(p)) continue;
    const bm::Piece& piece = pieces[p];
    const bool like = kind == Similar::Part    ? parts.count(piece.part) > 0
                      : kind == Similar::Color ? colors.count(piece.color) > 0
                      : kind == Similar::Step  ? steps.count(piece.step) > 0
                                               : both.count({piece.part, piece.color}) > 0;
    if (like) out.push_back(p);
  }
  select(out, SelectMode::Replace);
}

std::vector<ColorInfo> Session::colors() const {
  std::vector<ColorInfo> out;
  if (!impl_->library) return out;
  for (const auto& [code, c] : impl_->library->colors()) {
    if (code == 16 || code == 24) continue;
    ColorInfo info;
    info.code = code;
    info.name = colorDisplayName(c.name);
    info.rgb = c.rgb;
    info.alpha = c.alpha;
    using F = bm::ldraw::Finish;
    info.group = c.alpha < 1 || c.finish == F::Trans                                   ? 1
                 : c.finish == F::Chrome || c.finish == F::Metal || c.finish == F::Pearl ? 2
                 : c.finish == F::Rubber                                                 ? 3
                                                                                         : 0;
    out.push_back(std::move(info));
  }
  std::sort(out.begin(), out.end(), [](const ColorInfo& a, const ColorInfo& b) { return std::tie(a.group, a.code) < std::tie(b.group, b.code); });
  return out;
}

}  // namespace bmapp
