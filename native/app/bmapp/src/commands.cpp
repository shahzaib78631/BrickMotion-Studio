#include "commands.h"
#include "bm/plan/staging.h"
#include "animation_keys.h"
#include "flight_bake_impl.h"
#include "inventory_import_impl.h"
#include "snap_mix_impl.h"
#include "move_preview.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <cstring>
#include <map>
#include <set>
#include <unordered_map>
#include <unordered_set>
#include "session_impl.h"
#include "structure.h"

namespace bmapp {

namespace {

using bm::Box;
using bm::Mat3;
using bm::Vec3;
using bm::Xform;
using bm::doc::Def;
using bm::doc::Item;
using bm::doc::ItemId;

constexpr double kStud = 20, kPlate = 8;

struct Loc {
  std::string def;
  size_t step = 0, index = 0;
};

std::unordered_map<ItemId, Loc> locate(const bm::doc::Source& source) {
  std::unordered_map<ItemId, Loc> out;
  auto add = [&](const std::string& name, const Def& def) {
    for (size_t si = 0; si < def.steps.size(); si++)
      for (size_t ii = 0; ii < def.steps[si].items.size(); ii++) out[def.steps[si].items[ii].id] = Loc{name, si, ii};
  };
  add("", source.root);
  for (const auto& [name, def] : source.submodels) add(name, def);
  return out;
}

Item& at(bm::doc::Source& source, const Loc& loc) { return source.def(loc.def)->steps[loc.step].items[loc.index]; }
const Item& at(const bm::doc::Source& source, const Loc& loc) { return source.def(loc.def)->steps[loc.step].items[loc.index]; }

std::string chainKey(const std::vector<ItemId>& chain, size_t through) {
  std::string key;
  for (size_t k = 0; k <= through; k++) key += std::to_string(chain[k]) + ",";
  return key;
}

std::vector<uint32_t> distinct(const Session::Impl& s, const std::vector<uint32_t>& pieces) {
  std::vector<uint32_t> out;
  std::unordered_set<uint32_t> seen;
  for (uint32_t p : pieces)
    if (p < s.refs.size() && seen.insert(p).second) out.push_back(p);
  return out;
}

std::string named(const char* verb, size_t count) {
  return count == 1 ? std::string(verb) + " Piece" : std::string(verb) + " " + std::to_string(count) + " Pieces";
}

// ---- the selection, as the items it edits ------------------------------------------------

struct Target {
  ItemId id = 0;
  Loc loc;
  Xform parent;  ///< world placement of the def the item is in, through the use it was picked in
};

/// Which items a selection edits. When every piece of one use is selected the use is edited;
/// otherwise each piece edits its own item in the deepest def. `partsOnly`: always the part's item.
std::vector<Target> resolve(const Session::Impl& s, const std::vector<uint32_t>& pieces, bool partsOnly) {
  const std::vector<uint32_t> chosen = distinct(s, pieces);
  std::unordered_map<std::string, uint32_t> selected;
  if (!partsOnly)
    for (uint32_t p : chosen) {
      const auto& chain = s.refs[p].chain;
      for (size_t k = 0; k + 1 < chain.size(); k++) selected[chainKey(chain, k)]++;
    }
  const std::unordered_map<ItemId, Loc> where = locate(s.source);
  std::vector<Target> out;
  std::unordered_set<ItemId> seen;
  for (uint32_t p : chosen) {
    const auto& chain = s.refs[p].chain;
    size_t level = chain.size() - 1;
    if (!partsOnly)
      for (size_t k = 0; k + 1 < chain.size(); k++) {
        const std::string key = chainKey(chain, k);
        if (selected[key] == s.useCount.at(key)) {
          level = k;
          break;
        }
      }
    if (!seen.insert(chain[level]).second) continue;  // reached through another selected use: once
    Target t;
    t.id = chain[level];
    t.loc = where.at(t.id);
    t.parent = Xform::identity();
    for (size_t k = 0; k < level; k++) t.parent = t.parent * s.local.at(chain[k]);
    out.push_back(std::move(t));
  }
  if (partsOnly) return out;
  // A whole use and part of another use of the same submodel: the whole use is edited, and the
  // items inside that submodel are left alone, so nothing moves twice.
  std::set<std::string> inside;
  std::vector<std::string> todo;
  for (const Target& t : out) {
    const Item& item = *std::find_if(s.source.def(t.loc.def)->steps[t.loc.step].items.begin(),
                                     s.source.def(t.loc.def)->steps[t.loc.step].items.end(), [&](const Item& i) { return i.id == t.id; });
    if (item.submodel) todo.push_back(item.name);
  }
  while (!todo.empty()) {
    const std::string name = todo.back();
    todo.pop_back();
    if (!inside.insert(name).second) continue;
    if (const Def* def = s.source.def(name))
      for (const auto& step : def->steps)
        for (const Item& i : step.items)
          if (i.submodel) todo.push_back(i.name);
  }
  std::erase_if(out, [&](const Target& t) { return !t.loc.def.empty() && inside.count(t.loc.def); });
  return out;
}

// ---- placements ----------------------------------------------------------------------------

Mat3 rotation(Vec3 axis, double degrees) {
  const double len = std::sqrt(axis.x * axis.x + axis.y * axis.y + axis.z * axis.z);
  if (len == 0) return Mat3{};
  const double x = axis.x / len, y = axis.y / len, z = axis.z / len;
  const double a = degrees * 3.14159265358979323846 / 180, c = std::cos(a), sn = std::sin(a), t = 1 - c;
  return Mat3{{t * x * x + c, t * x * y - sn * z, t * x * z + sn * y, t * x * y + sn * z, t * y * y + c, t * y * z - sn * x,
               t * x * z - sn * y, t * y * z + sn * x, t * z * z + c}};
}

bool whole(double v) { return std::abs(v - std::round(v)) < 1e-6; }

/// `before` placed at `local` in its def: grid when it was grid and the change is whole studs,
/// plates and quarter turns about y; otherwise exact.
Item placed(const Item& before, const Xform& local, const Box& body) {
  Item after = before;
  if (before.at.grid) {
    const double* m = local.r.m;
    const bool upright = whole(m[0]) && whole(m[2]) && std::abs(m[1]) < 1e-9 && std::abs(m[3]) < 1e-9 && std::abs(m[4] - 1) < 1e-9 &&
                         std::abs(m[5]) < 1e-9 && std::abs(m[6] + m[2]) < 1e-9 && std::abs(m[7]) < 1e-9 && std::abs(m[8] - m[0]) < 1e-9;
    if (upright) {
      const int c = static_cast<int>(std::lround(m[0])), sn = static_cast<int>(std::lround(m[2]));
      if (c * c + sn * sn == 1) {
        bm::doc::Placement grid;
        grid.grid = true;
        grid.rot = c == 1 ? 0 : sn == 1 ? 90 : c == -1 ? 180 : 270;
        const Vec3 origin = bm::doc::placeOnGrid(grid, body).t;
        const double dx = (local.t.x - origin.x) / kStud - before.at.x, dy = -(local.t.y - origin.y) / kPlate - before.at.y,
                     dz = (local.t.z - origin.z) / kStud - before.at.z;
        if (whole(dx) && whole(dy) && whole(dz)) {
          after.at.rot = grid.rot;
          after.at.x = before.at.x + std::round(dx), after.at.y = before.at.y + std::round(dy), after.at.z = before.at.z + std::round(dz);
          return after;
        }
      }
    }
  }
  after.at.grid = false;
  after.at.exact = local;
  return after;
}

/// `local` changed by a world transform, taken through the use whose world placement is `parent`.
Xform through(const Xform& parent, const Xform& world, const Xform& local) { return parent.inverse() * world * parent * local; }

int planColor(const Session::Impl& s, int code) {
  return s.source.origin == bm::doc::Origin::Plan && code == 16 ? bm::doc::kPlanDefaultColor : code;
}

bool validPose(const Xform& pose) {
  const double det = bm::determinant(pose.r);
  return std::isfinite(det) && std::abs(det) >= 1e-9 && std::isfinite(pose.t.x) && std::isfinite(pose.t.y) && std::isfinite(pose.t.z);
}

PieceList anchorFirst(const PieceList& pieces, uint32_t anchor) {
  PieceList ordered{anchor};
  for (uint32_t p : pieces) if (p != anchor) ordered.push_back(p);
  return ordered;
}

// ---- applying ------------------------------------------------------------------------------

ItemEdit edit(const std::string& def, size_t step, size_t index, std::optional<Item> was, std::optional<Item> now) {
  ItemEdit e;
  e.def = def, e.step = step, e.index = index;
  e.before = std::move(was), e.after = std::move(now);
  return e;
}

bool before(const ItemEdit& a, const ItemEdit& b) {
  return std::tie(a.def, a.step, a.index) < std::tie(b.def, b.step, b.index);
}

/// Makes `from` (the def as it is) into `to`.
void swapDef(bm::doc::Source& src, const std::string& name, size_t position, const std::optional<Def>& from, const std::optional<Def>& to) {
  if (from && to) *src.def(name) = *to;
  else if (to) src.submodels.insert(src.submodels.begin() + static_cast<long>(std::min(position, src.submodels.size())), {name, *to});
  else if (from) std::erase_if(src.submodels, [&](const auto& sub) { return sub.first == name; });
}

void renameFocus(Session::Impl& s, const Command& c, bool forward);

void apply(Session::Impl& s, const Command& c, bool forward) {
  bm::doc::Source& src = s.source;
  std::vector<const ItemEdit*> removed, changed, inserted;
  for (const ItemEdit& e : c.items) (e.before && e.after ? changed : e.before ? removed : inserted).push_back(&e);
  auto byPlace = [](const ItemEdit* a, const ItemEdit* b) { return before(*a, *b); };
  std::sort(removed.begin(), removed.end(), byPlace);
  std::sort(inserted.begin(), inserted.end(), byPlace);
  auto insert = [&](const ItemEdit& e, const Item& item) {
    auto& items = src.def(e.def)->steps[e.step].items;
    items.insert(items.begin() + static_cast<long>(e.index), item);
  };
  auto erase = [&](const ItemEdit& e) {
    auto& items = src.def(e.def)->steps[e.step].items;
    items.erase(items.begin() + static_cast<long>(e.index));
  };
  auto replace = [&](const Item& from, const Item& to) {
    const auto where = locate(src);
    at(src, where.at(from.id)) = to;
  };
  if (forward) {
    src.inlineParts.insert(src.inlineParts.end(), c.importedParts.begin(), c.importedParts.end());
    for (const DefEdit& d : c.defs) src.submodels.insert(src.submodels.begin() + static_cast<long>(d.position), {d.name, d.def});
    if (c.addedRootStep) src.def(c.stepDef)->steps.emplace_back();
    for (auto it = removed.rbegin(); it != removed.rend(); ++it) erase(**it);
    for (const ItemEdit* e : changed) replace(*e->before, *e->after);
    for (const ItemEdit* e : inserted) insert(*e, *e->after);
    for (const DefChange& d : c.wholeDefs) swapDef(src, d.name, d.position, d.before, d.after);
  } else {
    src.inlineParts.resize(src.inlineParts.size() - c.importedParts.size());
    for (auto it = c.wholeDefs.rbegin(); it != c.wholeDefs.rend(); ++it) swapDef(src, it->name, it->position, it->after, it->before);
    for (auto it = inserted.rbegin(); it != inserted.rend(); ++it) erase(**it);
    for (const ItemEdit* e : changed) replace(*e->after, *e->before);
    for (const ItemEdit* e : removed) insert(*e, *e->before);
    if (c.addedRootStep) src.def(c.stepDef)->steps.pop_back();
    for (auto it = c.defs.rbegin(); it != c.defs.rend(); ++it)
      std::erase_if(src.submodels, [&](const auto& sub) { return sub.first == it->name; });
  }
  const auto setField = [&](const Command::PlanField& field) {
    const auto& value = forward ? field.after : field.before;
    if (field.project && !s.base) s.base.emplace();
    auto& metadata = field.project ? s.base->json : src.extra;
    if (value.is_null()) {
      if (metadata.is_object()) metadata.erase(field.key);
    } else {
      if (!metadata.is_object()) metadata = nlohmann::ordered_json::object();
      metadata[field.key] = value;
    }
  };
  if (forward) {
    if (c.planField) setField(*c.planField);
    for (const auto& field : c.morePlanFields) setField(field);
  } else {
    for (auto it = c.morePlanFields.rbegin(); it != c.morePlanFields.rend(); ++it) setField(*it);
    if (c.planField) setField(*c.planField);
  }
  renameFocus(s, c, forward);
}

/// A rename takes the focus path with it, both ways.
void renameFocus(Session::Impl& s, const Command& c, bool forward) {
  if (c.renamedFrom.empty()) return;
  const std::string& from = forward ? c.renamedFrom : c.renamedTo;
  const std::string& to = forward ? c.renamedTo : c.renamedFrom;
  for (std::string& name : s.focus)
    if (name == from) name = to;
}

bool structural(const Command& c) {
  if (c.kind != Edit::Move && c.kind != Edit::Rotate && c.kind != Edit::Scale && c.kind != Edit::Recolor) return true;
  if (!c.defs.empty() || c.addedRootStep || !c.wholeDefs.empty()) return true;
  return std::any_of(c.items.begin(), c.items.end(), [](const ItemEdit& e) { return !e.before || !e.after; });
}

/// After a placement or colour edit: the items' placements and the pieces under them, in place.
Changed inPlace(Session::Impl& s, const std::vector<ItemId>& ids) {
  Changed out;
  const auto where = locate(s.source);
  std::set<uint32_t> affected;
  for (ItemId id : ids) {
    const auto found = where.find(id);
    if (found == where.end() || !s.local.count(id)) continue;
    const Item& item = at(s.source, found->second);
    s.local[id] = item.at.grid ? bm::doc::placeOnGrid(item.at, s.body.at(id)) : item.at.exact;
    if (const auto p = s.piecesOf.find(id); p != s.piecesOf.end()) affected.insert(p->second.begin(), p->second.end());
  }
  for (uint32_t p : affected) {
    const auto& chain = s.refs[p].chain;
    Xform world = Xform::identity();  // as doc::flatten multiplies, so the result is the same to the bit
    int color = 16;
    for (ItemId id : chain) {
      world = world * s.local.at(id);
      const Item& item = at(s.source, where.at(id));
      const int own = item.submodel && s.source.origin == bm::doc::Origin::Plan ? 16 : bm::doc::colorCode(item, *s.library);
      if (own != 16) color = own;
    }
    const bm::Piece& piece = s.model->pieces()[p];
    if (std::memcmp(&piece.world, &world, sizeof world) != 0) {
      s.model->setPlacement(p, world);
      out.moved.push_back(p);
    }
    if (piece.color != color) {
      s.model->setColor(p, color);
      out.recolored.push_back(p);
    }
  }
  return out;
}

Changed finish(Session::Impl& s, const Command& c) {
  Changed out;
  if (c.kind == Edit::Motion || c.kind == Edit::Keyframes || c.kind == Edit::SceneCamera || c.kind == Edit::SnapSound ||
      c.kind == Edit::Look || c.kind == Edit::CameraTrack || c.kind == Edit::WaitingSpot) {
    // These edits leave the editable model and its paths as they are.
    out.keyframesOnly = c.kind == Edit::Keyframes;
    out.sceneOnly = c.kind == Edit::SceneCamera || c.kind == Edit::SnapSound || c.kind == Edit::Look ||
        c.kind == Edit::CameraTrack || c.kind == Edit::WaitingSpot;
    out.cameraTrack = c.kind == Edit::CameraTrack;
    out.waitingSpot = c.kind == Edit::WaitingSpot;
  } else if (c.kind == Edit::InsertionDirection || c.kind == Edit::Staging || c.kind == Edit::BuildSettings) {
    ++s.planInputs;
    ++s.planTopology;
  } else if (c.kind == Edit::SetGroup || c.kind == Edit::StepFields) {
    ++s.structureVersion;
    if (c.kind == Edit::StepFields && !c.wholeDefs.empty()) {
      const auto& change = c.wholeDefs.front();
      const auto pin = [&](const auto& def) {
        const auto& fields = def->steps[c.stepIndex].extra;
        return fields.is_object() && fields.contains("pinOrder") && fields["pinOrder"].is_boolean() && fields["pinOrder"].template get<bool>();
      };
      if (pin(change.before) != pin(change.after)) {
        ++s.planInputs;
        ++s.planTopology;
      }
    }
  } else if (trimFocus(s) || structural(c)) {
    reflatten(s);
    out.structure = true;
    if (c.kind == Edit::Delete && s.previousRefs.size() > s.refs.size()) {
      size_t next = 0;
      for (size_t old = 0; old < s.previousRefs.size(); ++old) {
        if (next < s.refs.size() && s.previousRefs[old].chain == s.refs[next].chain) ++next;
        else out.removed.push_back(static_cast<uint32_t>(old));
      }
      if (next != s.refs.size()) out.removed.clear();
    }
  } else {
    std::vector<ItemId> ids;
    for (const ItemEdit& e : c.items) ids.push_back(e.after ? e.after->id : e.before->id);
    out = inPlace(s, ids);
    if (!out.moved.empty()) ++s.planInputs;
  }
  out.version = ++s.version;
  return out;
}

Changed push(Session::Impl& s, Command c) {
  History& h = s.history;
  if (!h.done.empty() && h.cursor > 0) h.done[h.cursor - 1].open = false;
  h.done.resize(h.cursor);
  if (h.saved > static_cast<long>(h.cursor)) h.saved = -1;
  apply(s, c, true);
  h.done.push_back(std::move(c));
  h.cursor = h.done.size();
  return finish(s, h.done.back());
}

/// Before an edit inside these defs: every grid-placed use of them, or of a def holding them,
/// is pinned where it is, since the grid rule places a use by its submodel's box.
void pinUses(const Session::Impl& s, const std::set<std::string>& defs, Command& c) {
  std::set<std::string> affected;
  for (const std::string& d : defs)
    if (!d.empty()) affected.insert(d);
  if (affected.empty()) return;
  for (bool grew = true; grew;) {
    grew = false;
    for (const auto& [name, def] : s.source.submodels) {
      if (affected.count(name)) continue;
      for (const auto& step : def.steps)
        for (const Item& i : step.items)
          if (i.submodel && affected.count(i.name) && affected.insert(name).second) grew = true;
    }
  }
  std::optional<std::unordered_map<ItemId, Xform>> outsideFocus;
  auto pin = [&](const std::string& defName, const Def& def) {
    for (size_t si = 0; si < def.steps.size(); si++)
      for (size_t ii = 0; ii < def.steps[si].items.size(); ii++) {
        const Item& i = def.steps[si].items[ii];
        if (!i.submodel || !i.at.grid || !affected.count(i.name)) continue;
        const Xform* local = nullptr;
        if (const auto found = s.local.find(i.id); found != s.local.end()) {
          local = &found->second;
        } else {
          if (!outsideFocus) outsideFocus = bm::doc::placements(s.source, *s.library, *s.full);
          if (const auto found = outsideFocus->find(i.id); found != outsideFocus->end()) local = &found->second;
        }
        if (!local) continue;
        Item after = i;
        after.at.grid = false;
        after.at.exact = *local;
        c.items.push_back(edit(defName, si, ii, i, after));
      }
  };
  pin("", s.source.root);
  for (const auto& [name, def] : s.source.submodels) pin(name, def);
}

/// The open drag at the top of the history, if `pieces` are what it moves.
Command* openGesture(Session::Impl& s, Edit kind, const std::vector<uint32_t>& pieces) {
  History& h = s.history;
  if (h.cursor == 0 || h.cursor != h.done.size()) return nullptr;
  Command& c = h.done.back();
  return c.open && c.kind == kind && c.pieces == pieces ? &c : nullptr;
}

/// Makes a drag's afters again from its befores, for its whole world transform so far.
Changed regrow(Session::Impl& s, Command& c, const Xform& world) {
  for (ItemEdit& e : c.items) {
    if (!e.target) continue;
    const Item next = placed(*e.before, through(e.parent, world, e.beforeLocal), e.body);
    at(s.source, locate(s.source).at(next.id)) = next;
    e.after = next;
  }
  return finish(s, c);
}

Changed transformCommand(Session::Impl& s, Edit kind, const char* verb, const std::vector<uint32_t>& pieces, const Xform& world,
                         bool continuing, Vec3 total, Vec3 axis, double degrees, Vec3 pivot) {
  const std::vector<Target> targets = resolve(s, pieces, false);
  if (targets.empty()) return unchanged(s);
  Command c;
  c.kind = kind;
  c.name = named(verb, distinct(s, pieces).size());
  c.open = continuing;
  c.pieces = pieces;
  c.total = total, c.axis = axis, c.pivot = pivot, c.degrees = degrees;
  std::set<std::string> defs;
  for (const Target& t : targets) defs.insert(t.loc.def);
  pinUses(s, defs, c);
  for (const Target& t : targets) {
    const Item& item = at(s.source, t.loc);
    ItemEdit e = edit(t.loc.def, t.loc.step, t.loc.index, item, std::nullopt);
    e.target = true;
    e.parent = t.parent;
    e.beforeLocal = s.local.at(t.id);
    e.body = s.body.count(t.id) ? s.body.at(t.id) : Box{};
    e.after = placed(item, through(t.parent, world, e.beforeLocal), e.body);
    c.items.push_back(std::move(e));
  }
  return push(s, std::move(c));
}

Xform turn(Vec3 axis, double degrees, Vec3 pivot) {
  const Xform r{rotation(axis, degrees), {}};
  return Xform{Mat3{}, pivot} * r * Xform{Mat3{}, Vec3{-pivot.x, -pivot.y, -pivot.z}};
}

void number(std::string& out, double v) {
  char buf[32];
  const auto r = std::to_chars(buf, buf + sizeof buf, v == 0 ? 0.0 : v);
  out += ' ';
  out.append(buf, r.ptr);
}

}  // namespace

std::string focusedDef(const Session::Impl& s) { return s.focus.empty() ? "" : s.focus.back(); }

namespace {
/// Does def `outer` use `inner` directly?
bool usesDirectly(const bm::doc::Source& src, const std::string& outer, const std::string& inner) {
  const Def* d = src.def(outer);
  if (!d) return false;
  for (const auto& step : d->steps)
    for (const Item& i : step.items)
      if (i.submodel && i.name == inner) return true;
  return false;
}

/// The longest valid start of a focus path. An unused definition can also be opened from the root.
std::vector<std::string> leading(const bm::doc::Source& src, const std::vector<std::string>& path) {
  std::vector<std::string> out;
  std::string outer;
  for (const std::string& name : path) {
    if (name.empty() || !src.def(name)) break;
    if (!usesDirectly(src, outer, name)) {
      const bool unused = outer.empty() && std::none_of(src.submodels.begin(), src.submodels.end(),
          [&](const auto& def) { return usesDirectly(src, def.first, name); });
      if (!unused) break;
    }
    out.push_back(name);
    outer = name;
  }
  return out;
}
}  // namespace

bool trimFocus(Session::Impl& s) {
  std::vector<std::string> kept = leading(s.source, s.focus);
  if (kept == s.focus) return false;
  s.focus = std::move(kept);
  return true;
}

Changed focusCommand(Session::Impl& s, const std::vector<std::string>& path) {
  std::vector<std::string> kept = leading(s.source, path);
  if (kept == s.focus) return unchanged(s);
  s.focus = std::move(kept);
  reflatten(s);
  s.previousRefs.clear();  // nothing carries over: every piece is another one now
  s.selection.clear(), s.hidden.clear();
  s.selectionStamp++, s.hiddenStamp++;
  Changed out;
  out.structure = true;
  out.version = ++s.version;
  return out;
}

void reflatten(Session::Impl& s) {
  bm::doc::Flat flat = bm::doc::flatten(s.source, *s.library, *s.full, focusedDef(s));
  if (s.model) *s.model = std::move(flat.model);
  else s.model = std::make_unique<bm::Model>(std::move(flat.model));
  s.previousRefs = std::move(s.refs);
  s.refs = std::move(flat.refs);
  s.local = std::move(flat.local);
  s.body = std::move(flat.body);
  ++s.planInputs;
  ++s.planTopology;
  s.piecesOf.clear();
  s.useCount.clear();
  for (uint32_t p = 0; p < s.refs.size(); p++) {
    const auto& chain = s.refs[p].chain;
    for (ItemId id : chain) s.piecesOf[id].push_back(p);
    for (size_t k = 0; k + 1 < chain.size(); k++) s.useCount[chainKey(chain, k)]++;
  }
}

Changed moveCommand(Session::Impl& s, const std::vector<uint32_t>& pieces, bm::Vec3 delta, bool continuing) {
  if (continuing)
    if (Command* c = openGesture(s, Edit::Move, pieces)) {
      c->total = c->total + delta;
      return regrow(s, *c, Xform{bm::Mat3{}, c->total});
    }
  return transformCommand(s, Edit::Move, "Move", pieces, Xform{bm::Mat3{}, delta}, continuing, delta, {}, 0, {});
}

Changed rotateCommand(Session::Impl& s, const std::vector<uint32_t>& pieces, bm::Vec3 axis, double degrees, bm::Vec3 pivot, bool continuing) {
  if (continuing)
    if (Command* c = openGesture(s, Edit::Rotate, pieces);
        c && c->axis.x == axis.x && c->axis.y == axis.y && c->axis.z == axis.z && c->pivot.x == pivot.x && c->pivot.y == pivot.y && c->pivot.z == pivot.z) {
      c->degrees += degrees;
      return regrow(s, *c, turn(axis, c->degrees, pivot));
    }
  return transformCommand(s, Edit::Rotate, "Rotate", pieces, turn(axis, degrees, pivot), continuing, {}, axis, degrees, pivot);
}

Changed recolorCommand(Session::Impl& s, const std::vector<uint32_t>& pieces, int code) {
  const std::vector<Target> targets = resolve(s, pieces, true);
  if (targets.empty()) return unchanged(s);
  Command c;
  c.kind = Edit::Recolor;
  c.name = named("Recolour", distinct(s, pieces).size());
  for (const Target& t : targets) {
    const Item& item = at(s.source, t.loc);
    Item after = item;
    after.colorText = std::to_string(code);
    after.color = planColor(s, code);
    c.items.push_back(edit(t.loc.def, t.loc.step, t.loc.index, item, after));
  }
  return push(s, std::move(c));
}

Changed removeCommand(Session::Impl& s, const std::vector<uint32_t>& pieces) {
  const std::vector<Target> targets = resolve(s, pieces, false);
  if (targets.empty()) return unchanged(s);
  Command c;
  c.kind = Edit::Delete;
  c.name = named("Delete", distinct(s, pieces).size());
  std::set<std::string> defs;
  for (const Target& t : targets) defs.insert(t.loc.def);
  pinUses(s, defs, c);
  for (const Target& t : targets) c.items.push_back(edit(t.loc.def, t.loc.step, t.loc.index, at(s.source, t.loc), std::nullopt));
  return push(s, std::move(c));
}

Changed duplicateCommand(Session::Impl& s, const std::vector<uint32_t>& pieces, bm::Vec3 offset) {
  const std::vector<Target> targets = resolve(s, pieces, false);
  if (targets.empty()) return unchanged(s);
  Command c;
  c.kind = Edit::Duplicate;
  c.name = named("Duplicate", distinct(s, pieces).size());
  std::set<std::string> defs;
  for (const Target& t : targets) defs.insert(t.loc.def);
  pinUses(s, defs, c);
  std::map<std::pair<std::string, size_t>, size_t> next;  // where the next copy goes in each step
  for (const Target& t : targets) {
    const Item& item = at(s.source, t.loc);
    const auto key = std::make_pair(t.loc.def, t.loc.step);
    if (!next.count(key)) next[key] = s.source.def(t.loc.def)->steps[t.loc.step].items.size();
    const Box body = s.body.count(t.id) ? s.body.at(t.id) : Box{};
    Item copy = placed(item, through(t.parent, Xform{bm::Mat3{}, offset}, s.local.at(t.id)), body);
    copy.id = s.source.newId();
    if (copy.extra.is_object()) copy.extra.erase("id");  // a plan's own piece id names the original
    c.items.push_back(edit(t.loc.def, t.loc.step, next[key]++, std::nullopt, copy));
  }
  return push(s, std::move(c));
}

std::string copyText(const Session::Impl& s, const std::vector<uint32_t>& pieces) {
  std::string out;
  for (uint32_t p : distinct(s, pieces)) {
    const bm::Piece& piece = s.model->pieces()[p];
    out += "1 " + std::to_string(piece.color);
    number(out, piece.world.t.x), number(out, piece.world.t.y), number(out, piece.world.t.z);
    for (double v : piece.world.r.m) number(out, v);
    out += " " + piece.part + "\n";
  }
  return out;
}

Changed pasteCommand(Session::Impl& s, const std::string& def, const std::string& text, bm::Vec3 offset) {
  const bm::ldraw::File file = bm::ldraw::parse(text, "clipboard.ldr");
  const Def& into = *s.source.def(def);
  Command c;
  c.kind = Edit::Paste;
  c.stepDef = def;
  if (into.steps.empty()) c.addedRootStep = true;
  const size_t step = c.addedRootStep ? 0 : into.steps.size() - 1;
  size_t index = c.addedRootStep ? 0 : into.steps[step].items.size();
  for (const bm::ldraw::Command& cmd : file.cmds) {
    if (cmd.type != bm::ldraw::Cmd::Ref) continue;
    Item item;
    item.id = s.source.newId();
    item.name = cmd.file;
    item.colorText = std::to_string(cmd.color);
    item.color = planColor(s, cmd.color);
    item.at.exact = Xform{bm::Mat3{}, offset} * cmd.xf;
    c.items.push_back(edit(def, step, index++, std::nullopt, item));
  }
  if (c.items.empty()) return unchanged(s);
  c.name = named("Paste", c.items.size());
  return push(s, std::move(c));
}

Changed placePartCommand(Session::Impl& s, const std::string& def, const std::string& part,
                         int color, const Xform& pose, int step, int before) {
  const std::string name = bm::ldraw::normalizeName(part);
  if (!name.ends_with(".dat") || !s.library->find(name)) return refusal(s, "This part is missing from the library.");
  if (s.model->library().isInline(name)) return refusal(s, "This model already defines a custom part with that name.");
  if (!validPose(pose)) return refusal(s, "This part has an invalid placement.");

  const auto& steps = s.source.def(def)->steps;
  if (step >= 0 && static_cast<size_t>(step) >= steps.size()) return refusal(s, "That build step no longer exists.");
  const size_t into = steps.empty() ? 0 : step < 0 ? steps.size() - 1 : static_cast<size_t>(step);
  const size_t count = steps.empty() ? 0 : steps[into].items.size();
  if (before >= 0 && static_cast<size_t>(before) > count) return refusal(s, "That arrival position no longer exists.");
  Command c;
  c.kind = Edit::PlacePart;
  c.name = "Place Part";
  c.stepDef = def;
  c.addedRootStep = steps.empty();
  pinUses(s, {def}, c);

  Item item;
  item.id = s.source.newId();
  item.name = name;
  item.color = planColor(s, color);
  item.colorText = std::to_string(item.color);
  item.at.exact = pose;
  c.items.push_back(edit(def, into, before < 0 ? count : static_cast<size_t>(before), std::nullopt, std::move(item)));
  return push(s, std::move(c));
}

Changed importInventoryCommand(Session::Impl& s, const std::string& def, int step,
                               const std::vector<InventoryPart>& parts) {
  if (parts.empty()) return unchanged(s);
  const auto& steps = s.source.def(def)->steps;
  if (step >= 0 && static_cast<size_t>(step) >= steps.size())
    return refusal(s, "That build step no longer exists.");
  const size_t into = steps.empty() ? 0 : step < 0 ? steps.size() - 1 : static_cast<size_t>(step);
  size_t index = steps.empty() ? 0 : steps[into].items.size();
  Command command;
  command.kind = Edit::Paste;
  command.name = named("Import", parts.size());
  command.stepDef = def;
  command.addedRootStep = steps.empty();
  command.items.reserve(parts.size());
  pinUses(s, {def}, command);
  for (const auto& part : parts) {
    Item item;
    item.id = s.source.newId();
    item.name = part.name;
    item.color = planColor(s, part.color);
    item.colorText = std::to_string(item.color);
    item.at.exact = Xform{bm::Mat3{}, part.position};
    command.items.push_back(edit(def, into, index++, std::nullopt, std::move(item)));
  }
  return push(s, std::move(command));
}

std::vector<MovingPiece> piecesAfterMove(const Session::Impl& s, const PieceList& pieces, uint32_t anchor) {
  if (anchor >= s.refs.size()) return {};
  const auto targets = resolve(s, anchorFirst(pieces, anchor), false);
  std::vector<MovingPiece> out;
  for (const Target& target : targets) {
    const auto occurrences = s.piecesOf.find(target.id);
    if (occurrences == s.piecesOf.end()) continue;
    const Xform fromRepresentative = target.parent.inverse();
    for (uint32_t p : occurrences->second) {
      Xform parent;
      for (ItemId item : s.refs[p].chain) {
        if (item == target.id) break;
        parent = parent * s.local.at(item);
      }
      out.push_back({p, parent * fromRepresentative});
    }
  }
  std::sort(out.begin(), out.end(), [](const MovingPiece& a, const MovingPiece& b) { return a.piece < b.piece; });
  return out;
}

Changed placeMovedCommand(Session::Impl& s, const PieceList& pieces, uint32_t anchor, const Xform& pose) {
  if (anchor >= s.refs.size() || !validPose(pose)) return refusal(s, "This selection has an invalid placement.");
  const Xform& previous = s.model->pieces()[anchor].world;
  const Xform delta = pose * previous.inverse();
  const bm::Mat3 unit;
  if (bm::length(delta.t) < 1e-6 &&
      std::equal(std::begin(delta.r.m), std::end(delta.r.m), std::begin(unit.m),
                 [](double a, double b) { return std::abs(a - b) < 1e-7; })) return unchanged(s);
  return transformCommand(s, Edit::Move, "Move", anchorFirst(pieces, anchor), delta, false, {}, {}, 0, {});
}

namespace {
Changed setPosesCommand(Session::Impl& s, const std::vector<std::pair<uint32_t, Xform>>& poses,
                        const std::string& one, const std::string& many) {
  std::vector<std::pair<Target, Xform>> work;
  std::set<ItemId> seen;
  PieceList pieces;
  for (const auto& [piece, pose] : poses) {
    if (piece >= s.refs.size() || !validPose(pose)) return refusal(s, "A piece has an invalid placement.");
    const auto targets = resolve(s, {piece}, true);
    if (targets.size() != 1 || !seen.insert(targets.front().id).second) continue;
    work.emplace_back(targets.front(), pose * s.model->pieces()[piece].world.inverse());
    pieces.push_back(piece);
  }
  if (work.empty()) return unchanged(s);
  Command c;
  c.kind = Edit::Move;
  c.name = work.size() == 1 ? one : many;
  if (const auto n = c.name.find("{n}"); n != std::string::npos) c.name.replace(n, 3, std::to_string(work.size()));
  c.pieces = pieces;
  std::set<std::string> defs;
  for (const auto& [target, delta] : work) defs.insert(target.loc.def);
  pinUses(s, defs, c);
  for (const auto& [target, delta] : work) {
    const Item& item = at(s.source, target.loc);
    ItemEdit e = edit(target.loc.def, target.loc.step, target.loc.index, item, std::nullopt);
    e.target = true;
    e.parent = target.parent;
    e.beforeLocal = s.local.at(target.id);
    e.body = s.body.count(target.id) ? s.body.at(target.id) : Box{};
    e.after = placed(item, through(target.parent, delta, e.beforeLocal), e.body);
    c.items.push_back(std::move(e));
  }
  return push(s, std::move(c));
}
}  // namespace

Changed seatPiecesCommand(Session::Impl& s, const std::vector<std::pair<uint32_t, Xform>>& poses) {
  return setPosesCommand(s, poses, "Seat Loose Piece", "Seat {n} Loose Pieces");
}

Changed resetPosesCommand(Session::Impl& s, const std::vector<std::pair<uint32_t, Xform>>& poses) {
  return setPosesCommand(s, poses, "Reset Transform", "Reset {n} Transforms");
}

std::string groupOf(const Item& item) {
  if (!item.extra.is_object()) return {};
  const auto assembly = item.extra.find("assembly");
  if (assembly == item.extra.end() || !assembly->is_object()) return {};
  const auto group = assembly->find("group");
  return group != assembly->end() && group->is_string() ? group->get<std::string>() : std::string{};
}

StringList groupsOfItems(const Session::Impl& s, const PieceList& pieces) {
  std::set<std::string> names;
  const std::string def = focusedDef(s);
  for (const auto& target : resolve(s, pieces, false)) {
    if (target.loc.def != def) continue;
    auto name = groupOf(at(s.source, target.loc));
    if (!name.empty()) names.insert(std::move(name));
  }
  return {names.begin(), names.end()};
}

Changed setGroupCommand(Session::Impl& s, const PieceList& pieces, const std::string& requested) {
  const auto first = requested.find_first_not_of(" \t\r\n");
  const auto last = requested.find_last_not_of(" \t\r\n");
  const std::string name = first == std::string::npos ? "" : requested.substr(first, last - first + 1);
  if (name.size() > 160) return refusal(s, "Use a shorter group name.");
  const auto targets = resolve(s, pieces, false);
  if (targets.empty()) return unchanged(s);
  Command c;
  c.kind = Edit::SetGroup;
  c.name = name.empty() ? "Remove from Group" : "Set Group";
  const std::string def = focusedDef(s);
  for (const auto& target : targets) {
    if (target.loc.def != def) return refusal(s, "Open the submodel to group the pieces inside it.");
    const Item& old = at(s.source, target.loc);
    if (groupOf(old) == name) continue;
    Item item = old;
    if (name.empty()) {
      auto& assembly = item.extra["assembly"];
      assembly.erase("group");
      if (assembly.empty()) item.extra.erase("assembly");
    } else {
      if (!item.extra.is_object()) item.extra = nlohmann::ordered_json::object();
      auto& assembly = item.extra["assembly"];
      if (!assembly.is_object()) assembly = nlohmann::ordered_json::object();
      assembly["group"] = name;
    }
    c.items.push_back(edit(target.loc.def, target.loc.step, target.loc.index, old, std::move(item)));
  }
  return c.items.empty() ? unchanged(s) : push(s, std::move(c));
}

Changed replaceCommand(Session::Impl& s, const std::vector<uint32_t>& pieces, const std::string& part) {
  std::string name = bm::ldraw::normalizeName(part);
  if (name.empty()) return unchanged(s);
  if (name.find('.') == std::string::npos) name += ".dat";
  const std::vector<Target> targets = resolve(s, pieces, true);
  if (targets.empty()) return unchanged(s);
  Command c;
  c.kind = Edit::ReplacePart;
  const size_t count = distinct(s, pieces).size();
  c.name = count == 1 ? "Replace Part" : "Replace Part of " + std::to_string(count) + " Pieces";
  std::set<std::string> defs;
  for (const Target& t : targets) defs.insert(t.loc.def);
  pinUses(s, defs, c);
  for (const Target& t : targets) {
    const Item& item = at(s.source, t.loc);
    Item after = item;
    after.name = name;
    c.items.push_back(edit(t.loc.def, t.loc.step, t.loc.index, item, after));
  }
  return push(s, std::move(c));
}

Changed makeUniqueCommand(Session::Impl& s, uint32_t piece) {
  if (piece >= s.refs.size() || s.refs[piece].chain.size() < 2) return unchanged(s);
  const auto& chain = s.refs[piece].chain;
  const ItemId useId = chain[chain.size() - 2];
  const Loc loc = locate(s.source).at(useId);
  const Item& use = at(s.source, loc);
  // "wheel.ldr" forks into "wheel 2.ldr", "cap" into "cap 2": the next free number.
  const size_t dot = use.name.rfind('.');
  const std::string stem = dot == std::string::npos ? use.name : use.name.substr(0, dot), ext = dot == std::string::npos ? "" : use.name.substr(dot);
  std::string fork;
  for (int n = 2;; n++) {
    fork = stem + " " + std::to_string(n) + ext;
    if (!s.source.def(fork)) break;
  }
  Def copy = *s.source.def(use.name);
  for (auto& step : copy.steps)
    for (Item& i : step.items) i.id = s.source.newId();
  size_t position = 0;
  while (position < s.source.submodels.size() && s.source.submodels[position].first != use.name) position++;
  Command c;
  c.kind = Edit::MakeUnique;
  c.name = "Make Unique";
  c.defs.push_back(DefEdit{fork, std::min(position + 1, s.source.submodels.size()), std::move(copy)});
  Item after = use;
  after.name = fork;
  c.items.push_back(edit(loc.def, loc.step, loc.index, use, after));
  return push(s, std::move(c));
}


// ---- steps -----------------------------------------------------------------------------------

std::string colorDisplayName(std::string name) {
  std::replace(name.begin(), name.end(), '_', ' ');
  return name;
}

Changed unchanged(const Session::Impl& s) {
  Changed out;
  out.version = s.version;
  return out;
}

Changed refusal(const Session::Impl& s, std::string reason) {
  Changed out = unchanged(s);
  out.refused = std::move(reason);
  return out;
}

namespace {

using Json = nlohmann::ordered_json;

/// The position of a submodel among the submodels (0 for the root).
size_t positionOf(const bm::doc::Source& src, const std::string& def) {
  for (size_t i = 0; i < src.submodels.size(); i++)
    if (src.submodels[i].first == def) return i;
  return 0;
}

/// Pushes a command that makes `def` into `after`.
Changed swapCommand(Session::Impl& s, Edit kind, std::string name, const std::string& def, Def after) {
  Command c;
  c.kind = kind;
  c.name = std::move(name);
  c.wholeDefs.push_back(DefChange{def, positionOf(s.source, def), *s.source.def(def), std::move(after)});
  return push(s, std::move(c));
}

/// A step's object with no editorial fields: what a new step starts from.
bm::doc::Step emptyStep() { return bm::doc::Step{}; }

std::string text(const Json& extra, const char* key) {
  return extra.is_object() && extra.contains(key) && extra[key].is_string() ? extra[key].get<std::string>() : "";
}

void setText(Json& extra, const char* key, const std::string& value) {
  if (!extra.is_object()) extra = Json::object();
  if (value.empty()) extra.erase(key);
  else extra[key] = value;
}

/// Trimmed and cut to at most `limit` bytes, never inside a UTF-8 character.
std::string tidy(const std::string& in, size_t limit) {
  const size_t first = in.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) return "";
  std::string out = in.substr(first, in.find_last_not_of(" \t\r\n") - first + 1);
  if (out.size() > limit) {
    size_t cut = limit;
    while (cut > 0 && (static_cast<unsigned char>(out[cut]) & 0xC0) == 0x80) cut--;
    out.resize(cut);
  }
  return out;
}

StepFields normalize(const StepFields& in) {
  StepFields out = in;
  out.title = tidy(in.title, 80);
  out.notes = tidy(in.notes, 1000);
  const double pause = std::isfinite(in.pauseAfter) ? std::clamp(in.pauseAfter, 0.0, 10.0) : 0.0;
  out.pauseAfter = std::round(pause * 10) / 10;
  return out;
}

bool arrivalPinned(const Item& item) {
  const auto assembly = item.extra.find("assembly");
  if (assembly == item.extra.end() || !assembly->is_object()) return false;
  const auto root = assembly->find("root");
  return root != assembly->end() && root->is_boolean() && root->get<bool>();
}

void setArrivalPin(Item& item, bool pinned) {
  if (pinned) {
    if (!item.extra.is_object()) item.extra = Json::object();
    auto& assembly = item.extra["assembly"];
    if (!assembly.is_object()) assembly = Json::object();
    assembly["root"] = true;
  } else if (auto assembly = item.extra.find("assembly"); assembly != item.extra.end() && assembly->is_object()) {
    assembly->erase("root");
    if (assembly->empty()) item.extra.erase(assembly);
  }
}

void writeFields(bm::doc::Step& step, const StepFields& f) {
  const auto pin = step.extra.find("pinOrder");
  const bool wasPinned = pin != step.extra.end() && pin->is_boolean() && pin->get<bool>();
  setText(step.extra, "title", f.title);
  setText(step.extra, "notes", f.notes);
  if (f.pauseAfter > 0) step.extra["pauseAfter"] = f.pauseAfter;
  else step.extra.erase("pauseAfter");
  if (f.pinOrder) step.extra["pinOrder"] = true;
  else step.extra.erase("pinOrder");
  if (wasPinned != f.pinOrder)
    for (Item& item : step.items) setArrivalPin(item, f.pinOrder);
}

StepFields readFields(const bm::doc::Step& step) {
  StepFields f;
  f.title = text(step.extra, "title");
  f.notes = text(step.extra, "notes");
  if (step.extra.is_object() && step.extra.contains("pauseAfter") && step.extra["pauseAfter"].is_number())
    f.pauseAfter = step.extra["pauseAfter"].get<double>();
  f.pinOrder = step.extra.is_object() && step.extra.value("pinOrder", false);
  return f;
}

/// Only steps' and items' fields can differ between `a` and `after` here: are they the same?
bool sameFields(const Def& a, const Def& b) {
  for (size_t i = 0; i < a.steps.size(); i++) {
    if (a.steps[i].extra != b.steps[i].extra) return false;
    for (size_t k = 0; k < a.steps[i].items.size(); k++)
      if (a.steps[i].items[k].extra != b.steps[i].items[k].extra) return false;
  }
  return true;
}

std::string joined(const std::string& a, const std::string& b) {
  if (a.empty()) return b;
  if (b.empty()) return a;
  return a + "\n" + b;
}

/// The items of `def` that hold `pieces`, as (step, index), sorted. `whole`: a use counts only
/// when every piece under it is chosen; `refused` is set when one is chosen only in part.
std::vector<std::pair<size_t, size_t>> itemsOf(const Session::Impl& s, const std::string& def, const std::vector<uint32_t>& pieces,
                                               bool whole, bool* partial = nullptr) {
  const auto where = locate(s.source);
  std::map<ItemId, size_t> chosen;  // item -> pieces chosen under it
  std::map<ItemId, size_t> under;   // item -> pieces under it through the same chain prefix
  for (uint32_t p : distinct(s, pieces)) {
    const auto& chain = s.refs[p].chain;
    for (size_t k = 0; k < chain.size(); k++) {
      const auto found = where.find(chain[k]);
      if (found == where.end() || found->second.def != def) continue;
      chosen[chain[k]]++;
      if (k + 1 < chain.size()) under[chain[k]] = s.useCount.at(chainKey(chain, k));
      else under[chain[k]] = 1;
      break;
    }
  }
  std::vector<std::pair<size_t, size_t>> out;
  for (const auto& [id, count] : chosen) {
    if (whole && count < under[id]) {
      if (partial) *partial = true;
      continue;
    }
    const Loc& loc = where.at(id);
    out.emplace_back(loc.step, loc.index);
  }
  std::sort(out.begin(), out.end());
  return out;
}

}  // namespace

size_t stepCountOf(const Session::Impl& s, const std::string& def) {
  const Def* d = s.source.def(def);
  return d ? d->steps.size() : 0;
}

StepFields stepFieldsOf(const Session::Impl& s, const std::string& def, size_t at) {
  const Def* d = s.source.def(def);
  return d && at < d->steps.size() ? readFields(d->steps[at]) : StepFields{};
}

Changed insertStepCommand(Session::Impl& s, const std::string& def, size_t at) {
  const Def* d = s.source.def(def);
  if (!d || at > d->steps.size()) return unchanged(s);
  Def after = *d;
  after.steps.insert(after.steps.begin() + static_cast<long>(at), emptyStep());
  return swapCommand(s, Edit::AddStep, "Insert Step", def, std::move(after));
}

Changed deleteStepCommand(Session::Impl& s, const std::string& def, size_t at) {
  const Def* d = s.source.def(def);
  if (!d || at >= d->steps.size()) return unchanged(s);
  if (d->steps.size() == 1 && !d->steps[0].items.empty()) return refusal(s, "A model needs at least one step.");
  Def after = *d;
  bm::doc::Step gone = std::move(after.steps[at]);
  after.steps.erase(after.steps.begin() + static_cast<long>(at));
  if (!gone.items.empty() && !after.steps.empty()) {
    bm::doc::Step& keep = after.steps[at == 0 ? 0 : at - 1];
    StepFields f = readFields(keep);
    const StepFields g = readFields(gone);
    if (at == 0) {
      keep.items.insert(keep.items.begin(), gone.items.begin(), gone.items.end());
      f.notes = joined(g.notes, f.notes);
    } else {
      keep.items.insert(keep.items.end(), gone.items.begin(), gone.items.end());
      f.notes = joined(f.notes, g.notes);
      f.pauseAfter = g.pauseAfter;  // the pause between them goes with the step
    }
    setText(keep.extra, "notes", f.notes);
    if (f.pauseAfter > 0) keep.extra["pauseAfter"] = f.pauseAfter;
    else if (keep.extra.is_object()) keep.extra.erase("pauseAfter");
  }
  return swapCommand(s, Edit::DeleteStep, "Delete Step", def, std::move(after));
}

Changed moveStepCommand(Session::Impl& s, const std::string& def, size_t from, size_t to) {
  const Def* d = s.source.def(def);
  if (!d || from >= d->steps.size() || to >= d->steps.size() || from == to) return unchanged(s);
  Def after = *d;
  bm::doc::Step moving = std::move(after.steps[from]);
  after.steps.erase(after.steps.begin() + static_cast<long>(from));
  after.steps.insert(after.steps.begin() + static_cast<long>(to), std::move(moving));
  return swapCommand(s, Edit::MoveStep, "Move Step", def, std::move(after));
}

static Changed splitStepItems(Session::Impl& s, const std::string& def, const Def& source, size_t at, const std::set<size_t>& chosen) {
  Def after = source;
  bm::doc::Step rest, split;
  rest.extra = after.steps[at].extra;
  if (rest.extra.is_object()) {
    for (const auto* field : {"pauseAfter", "motion", "pinOrder"})
      if (rest.extra.contains(field)) split.extra[field] = rest.extra[field];
    rest.extra.erase("pauseAfter");
  }
  for (size_t i = 0; i < after.steps[at].items.size(); i++) (chosen.count(i) ? split : rest).items.push_back(after.steps[at].items[i]);
  after.steps[at] = std::move(rest);
  after.steps.insert(after.steps.begin() + static_cast<long>(at + 1), std::move(split));
  return swapCommand(s, Edit::SplitStep, "Split Step", def, std::move(after));
}

Changed splitStepCommand(Session::Impl& s, const std::string& def, size_t at, const std::vector<uint32_t>& pieces) {
  const Def* d = s.source.def(def);
  if (!d || at >= d->steps.size()) return unchanged(s);
  std::set<size_t> chosen;
  for (const auto& [step, index] : itemsOf(s, def, pieces, false))
    if (step == at) chosen.insert(index);
  if (chosen.empty()) return refusal(s, "Choose some of the step's pieces to split off.");
  if (chosen.size() == d->steps[at].items.size()) return refusal(s, "Choose some of the step's pieces, not all of them.");
  return splitStepItems(s, def, *d, at, chosen);
}

Changed splitStepAtCommand(Session::Impl& s, const std::string& def, size_t step, size_t firstItem) {
  const Def* d = s.source.def(def);
  if (!d || step >= d->steps.size() || firstItem == 0 || firstItem >= d->steps[step].items.size()) return unchanged(s);
  std::set<size_t> suffix;
  for (size_t i = firstItem; i < d->steps[step].items.size(); ++i) suffix.insert(i);
  return splitStepItems(s, def, *d, step, suffix);
}

Changed mergeStepsCommand(Session::Impl& s, const std::string& def, size_t first) {
  const Def* d = s.source.def(def);
  if (!d || first + 1 >= d->steps.size()) return unchanged(s);
  Def after = *d;
  bm::doc::Step& keep = after.steps[first];
  const bm::doc::Step next = after.steps[first + 1];
  StepFields f = readFields(keep);
  const StepFields g = readFields(next);
  keep.items.insert(keep.items.end(), next.items.begin(), next.items.end());
  if (f.title.empty()) setText(keep.extra, "title", g.title);
  setText(keep.extra, "notes", joined(f.notes, g.notes));
  if (g.pauseAfter > 0) keep.extra["pauseAfter"] = g.pauseAfter;
  else if (keep.extra.is_object()) keep.extra.erase("pauseAfter");
  after.steps.erase(after.steps.begin() + static_cast<long>(first + 1));
  return swapCommand(s, Edit::MergeSteps, "Merge Steps", def, std::move(after));
}

Changed setStepFieldsCommand(Session::Impl& s, const std::string& def, size_t at, const StepFields& fields, bool continuing) {
  const Def* d = s.source.def(def);
  if (!d || at >= d->steps.size()) return unchanged(s);
  Def after = *d;
  writeFields(after.steps[at], normalize(fields));
  History& h = s.history;
  if (continuing && h.cursor > 0 && h.cursor == h.done.size()) {
    Command& c = h.done.back();
    if (c.open && c.kind == Edit::StepFields && c.stepIndex == at && c.wholeDefs.size() == 1 && c.wholeDefs[0].name == def) {
      *s.source.def(def) = after;
      c.wholeDefs[0].after = std::move(after);
      return finish(s, c);
    }
  }
  if (sameFields(*d, after)) return unchanged(s);
  Command c;
  c.kind = Edit::StepFields;
  c.name = "Edit Step";
  c.open = continuing;
  c.stepIndex = at;
  c.wholeDefs.push_back(DefChange{def, positionOf(s.source, def), *d, std::move(after)});
  return push(s, std::move(c));
}

namespace {

constexpr std::array<const char*, 4> motionEasing{"smooth", "gentle", "soft", "linear"};

const Json& fieldObject(const Json& parent, const char* key) {
  static const Json empty = Json::object();
  const auto it = parent.is_object() ? parent.find(key) : parent.end();
  return it != parent.end() && it->is_object() ? *it : empty;
}

void setFieldObject(Json& parent, const char* key, const Json& value) {
  if (value.empty()) {
    if (parent.is_object()) parent.erase(key);
  } else {
    if (!parent.is_object()) parent = Json::object();
    parent[key] = value;
  }
}

MotionFields readMotion(const Json& object) {
  MotionFields f;
  const auto number = [&](const char* key) {
    const auto it = object.find(key);
    return it != object.end() && it->is_number() ? it->get<double>() : -1;
  };
  f.time = number("time");
  f.landing = number("landing");
  f.hover = number("hover");
  if (const auto it = object.find("ease"); it != object.end() && it->is_string()) {
    for (size_t i = 0; i < motionEasing.size(); ++i) if (*it == motionEasing[i]) f.ease = static_cast<int>(i);
  }
  return f;
}

Json writeMotion(Json object, const MotionFields& f) {
  const auto put = [&](const char* key, double value, double low, double high) {
    if (!std::isfinite(value) || value < 0) object.erase(key);
    else object[key] = std::round(100 * std::clamp(value, low, high)) / 100;
  };
  put("time", f.time, 0.25, 4);
  put("landing", f.landing, 0.1, 0.7);
  put("hover", f.hover, 0, 0.4);
  if (f.ease >= 0 && static_cast<size_t>(f.ease) < motionEasing.size()) object["ease"] = motionEasing[f.ease];
  else object.erase("ease");
  return object;
}

}  // namespace

MotionFields motionFieldsOf(const Session::Impl& s, MotionScope scope, size_t step, const PieceList& pieces) {
  if (scope == MotionScope::Project) return readMotion(fieldObject(s.source.extra, "motion"));
  if (scope == MotionScope::Step) {
    const auto* def = s.source.def(focusedDef(s));
    if (def && step < def->steps.size()) return readMotion(fieldObject(def->steps[step].extra, "motion"));
  } else {
    const auto targets = resolve(s, pieces, true);
    if (!targets.empty()) return readMotion(fieldObject(fieldObject(at(s.source, targets.front().loc).extra, "assembly"), "motion"));
  }
  return {};
}

Changed setMotionFieldsCommand(Session::Impl& s, MotionScope scope, size_t step, const PieceList& pieces, const MotionFields& fields) {
  Command c;
  c.kind = Edit::Motion;
  c.name = "Edit Build Motion";
  if (scope == MotionScope::Project) {
    const auto& before = fieldObject(s.source.extra, "motion");
    const auto after = writeMotion(before, fields);
    if (before == after) return unchanged(s);
    c.planField = Command::PlanField{"motion", before.empty() ? Json{} : before, after.empty() ? Json{} : after};
  } else if (scope == MotionScope::Step) {
    const std::string name = focusedDef(s);
    const auto* def = s.source.def(name);
    if (!def || step >= def->steps.size()) return unchanged(s);
    Def newDef = *def;
    auto& stepData = newDef.steps[step].extra;
    const auto changed = writeMotion(fieldObject(stepData, "motion"), fields);
    if (fieldObject(stepData, "motion") == changed) return unchanged(s);
    setFieldObject(stepData, "motion", changed);
    c.wholeDefs.push_back({name, positionOf(s.source, name), *def, std::move(newDef)});
  } else {
    for (const auto& target : resolve(s, pieces, true)) {
      const auto& old = at(s.source, target.loc);
      Item item = old;
      Json assembly = fieldObject(item.extra, "assembly");
      setFieldObject(assembly, "motion", writeMotion(fieldObject(assembly, "motion"), fields));
      setFieldObject(item.extra, "assembly", assembly);
      if (item.extra != old.extra)
        c.items.push_back(edit(target.loc.def, target.loc.step, target.loc.index, old, std::move(item)));
    }
    if (c.items.empty()) return unchanged(s);
  }
  return push(s, std::move(c));
}

Changed setSequenceDurationCommand(Session::Impl& s, SequenceSegment segment, double seconds) {
  if (!std::isfinite(seconds)) return unchanged(s);
  const char* key = nullptr;
  std::string_view label;
  switch (segment) {
    case SequenceSegment::Intro: key = "introSeconds"; label = "Intro"; break;
    case SequenceSegment::Build: key = "buildSeconds"; label = "Build"; break;
    case SequenceSegment::Hero: key = "outroSeconds"; label = "Hero"; break;
  }
  if (!key) return unchanged(s);
  const double min = segment == SequenceSegment::Build ? 1.0 : 0.2;
  const double max = segment == SequenceSegment::Build ? 1800.0 : 120.0;
  const double duration = std::round(std::clamp(seconds, min, max) * 10) / 10;
  const Json settings = s.base ? fieldObject(s.base->json, "settings") : Json::object();
  Json updated = settings, video = fieldObject(settings, "video");
  if (video.contains(key) && video[key] == duration) return unchanged(s);
  video[key] = duration;
  setFieldObject(updated, "video", video);
  Command command;
  command.kind = Edit::Motion;
  command.name = "Resize " + std::string(label);
  command.planField = Command::PlanField{"settings", settings.empty() ? Json{} : settings, updated, true};
  return push(s, std::move(command));
}

StagingSettings stagingSettingsOf(const Session::Impl& s) {
  StagingSettings out;
  if (!s.base) return out;
  const auto& video = fieldObject(fieldObject(s.base->json, "settings"), "video");
  const auto read = [&](const char* key, std::string& output, auto parsed) {
    const auto value = video.find(key);
    if (value != video.end() && value->is_string()) {
      const auto text = value->get<std::string>();
      if (bm::plan::staging::parse(text, parsed)) output = text;
    }
  };
  using namespace bm::plan::staging;
  read("floorStyle", out.layout, Style::Packed);
  read("floorSort", out.group, Sort::Step);
  read("floorSides", out.sides, Sides::FrontBack);
  read("floorMatch", out.match, Match::Fill);
  // As the web: the frame shape follows the project's video format until one is chosen.
  static const std::pair<const char*, double> formats[] = {{"9:16", 9.0 / 16}, {"4:5", 4.0 / 5}, {"1:1", 1}, {"16:9", 16.0 / 9}};
  out.aspect = 9.0 / 16;
  if (const auto format = video.find("format"); format != video.end() && format->is_string())
    for (const auto& [name, aspect] : formats)
      if (*format == name) out.aspect = aspect;
  if (const auto value = video.find("floorAspect"); value != video.end() && value->is_number()) {
    const double aspect = value->get<double>();
    if (std::isfinite(aspect) && aspect >= 0.25 && aspect <= 4) out.aspect = aspect;
  }
  return out;
}

namespace {

/// The settings field Build Staging writes, or nothing when `settings` are as saved; false when
/// they are not valid.
bool stagingSettingsField(const Session::Impl& s, const StagingSettings& settings, std::optional<Command::PlanField>& field) {
  using namespace bm::plan::staging;
  Style layout;
  Sort group;
  Sides sides;
  Match match;
  if (!parse(settings.layout, layout) || !parse(settings.group, group) || !parse(settings.sides, sides) ||
      !parse(settings.match, match) || !std::isfinite(settings.aspect) || settings.aspect < 0.25 || settings.aspect > 4)
    return false;
  const auto existing = stagingSettingsOf(s);
  if (settings.layout == existing.layout && settings.group == existing.group && settings.sides == existing.sides &&
      settings.match == existing.match && (settings.aspect == existing.aspect || settings.layout != "camera-frame"))
    return true;
  const Json before = s.base ? fieldObject(s.base->json, "settings") : Json::object();
  Json after = before, video = fieldObject(before, "video");
  video["floorStyle"] = settings.layout;
  video["floorSort"] = settings.group;
  video["floorSides"] = settings.sides;
  video["floorMatch"] = settings.match;
  // Only the camera frame has a shape; other layouts leave the project's format in charge.
  if (settings.layout == "camera-frame") video["floorAspect"] = settings.aspect;
  else video.erase("floorAspect");
  setFieldObject(after, "video", video);
  field = Command::PlanField{"settings", before.empty() ? Json{} : before, std::move(after), true};
  return true;
}

/// The stagingTurns field for a turn (wrapped as the web's setStagingTurn), or nothing when it
/// is the turn saved; false for a turn that is not a number.
bool stagingTurnField(const Session::Impl& s, double degrees, std::optional<Command::PlanField>& field, double& turn);

}  // namespace

Changed setStagingSettingsCommand(Session::Impl& s, const StagingSettings& settings) {
  std::optional<Command::PlanField> field;
  if (!stagingSettingsField(s, settings, field)) return refusal(s, "Choose a valid staging layout and frame shape.");
  if (!field) return unchanged(s);
  Command command;
  command.kind = Edit::Staging;
  command.name = "Change Staging";
  command.planField = std::move(field);
  return push(s, std::move(command));
}

double stagingTurnOf(const Session::Impl& s) {
  const auto turns = s.source.extra.find("stagingTurns");
  if (turns == s.source.extra.end() || !turns->is_object()) return 0;
  const auto turn = turns->find(focusedDef(s));
  if (turn == turns->end() || !turn->is_number()) return 0;
  const double value = turn->get<double>();
  return std::isfinite(value) ? std::clamp(value, -180.0, 180.0) : 0;
}

namespace {

bool stagingTurnField(const Session::Impl& s, double degrees, std::optional<Command::PlanField>& field, double& turn) {
  if (!std::isfinite(degrees)) return false;
  // As the web's setStagingTurn: wrapped to (-180, 180], a tenth of a degree.
  turn = std::round((std::fmod(std::fmod(degrees, 360) + 540, 360) - 180) * 10) / 10;
  if (turn == -180) turn = 180;
  if (turn == 0) turn = 0;  // never -0
  if (turn == stagingTurnOf(s)) return true;
  const auto found = s.source.extra.find("stagingTurns");
  const Json before = found != s.source.extra.end() ? *found : Json{};
  Json after = before.is_object() ? before : Json::object();
  if (turn != 0) after[focusedDef(s)] = turn;
  else after.erase(focusedDef(s));
  field = Command::PlanField{"stagingTurns", before, after.empty() ? Json{} : std::move(after)};
  return true;
}

}  // namespace

Changed setStagingTurnCommand(Session::Impl& s, double degrees) {
  std::optional<Command::PlanField> field;
  double turn = 0;
  if (!stagingTurnField(s, degrees, field, turn)) return refusal(s, "Choose a finite turn.");
  if (!field) return unchanged(s);
  Command command;
  command.kind = Edit::Staging;
  command.name = turn != 0 ? "Turn Staging Area" : "Reset Staging Turn";
  command.planField = std::move(field);
  return push(s, std::move(command));
}

namespace {
const char* clockKey(CameraClock clock) { return clock == CameraClock::Timeline ? "timeline" : "build"; }

/// cameraTracks with the focused model's track for `clock` set to `track`; the rest as it was.
Json withCameraTrack(const Session::Impl& s, CameraClock clock, Json track) {
  const auto found = s.source.extra.find("cameraTracks");
  Json after = found != s.source.extra.end() && found->is_object() ? *found : Json::object();
  Json& model = after[focusedDef(s)];
  if (!model.is_object()) model = Json::object();
  model[clockKey(clock)] = std::move(track);
  return after;
}
}  // namespace

Json cameraTrackOf(const Session::Impl& s, CameraClock clock) {
  const auto tracks = s.source.extra.find("cameraTracks");
  if (tracks == s.source.extra.end() || !tracks->is_object()) return {};
  const auto model = tracks->find(focusedDef(s));
  if (model == tracks->end() || !model->is_object()) return {};
  const auto track = model->find(clockKey(clock));
  return track != model->end() && track->is_object() ? *track : Json{};
}

Changed setCameraTrackCommand(Session::Impl& s, CameraClock clock, Json track, std::string name, bool continuing,
                              const std::string& group) {
  if (track == cameraTrackOf(s, clock)) return unchanged(s);
  const auto found = s.source.extra.find("cameraTracks");
  const Json before = found != s.source.extra.end() ? *found : Json{};
  // the whole map is written back, so other models and the other clock are kept as they are
  Json after = withCameraTrack(s, clock, std::move(track));
  const std::string tag = std::string(clockKey(clock)) + "/" + group;
  if (continuing && s.history.cursor > 0 && s.history.cursor == s.history.done.size()) {
    auto& c = s.history.done[s.history.cursor - 1];
    if (c.kind == Edit::CameraTrack && c.open && c.planField && c.planField->key == "cameraTracks" && c.name == name &&
        c.morePlanFields.empty() && c.group == tag) {
      c.planField->after = after;
      s.source.extra["cameraTracks"] = std::move(after);
      return finish(s, c);
    }
  }
  Command command;
  command.kind = Edit::CameraTrack;
  command.name = std::move(name);
  command.planField = Command::PlanField{"cameraTracks", before, std::move(after)};
  // a field edit stays open, so the rest of a drag (continuing) grows it; any other edit closes it
  command.open = !group.empty();
  command.group = tag;
  return push(s, std::move(command));
}

Changed autoDirectCommand(Session::Impl& s, CameraClock clock, Json track) {
  const auto found = s.source.extra.find("cameraTracks");
  const Json before = found != s.source.extra.end() ? *found : Json{};
  Json after = withCameraTrack(s, clock, std::move(track));
  const Json settingsBefore = s.base ? fieldObject(s.base->json, "settings") : Json::object();
  Json settingsAfter = settingsBefore;
  settingsAfter["exportCamera"] = "track";  // the video uses the track just written
  if (after == before && settingsAfter == settingsBefore) return unchanged(s);
  Command command;
  command.kind = Edit::CameraTrack;
  command.name = "Auto-Direct Camera";
  command.planField = Command::PlanField{"cameraTracks", before, std::move(after)};
  if (settingsAfter != settingsBefore)
    command.morePlanFields.push_back({"settings", settingsBefore.empty() ? Json{} : settingsBefore, std::move(settingsAfter), true});
  return push(s, std::move(command));
}

namespace {

/// Calls `found(def, step, index, item)` for each item, in every model of the file, that waits
/// turned (floorTurn) or dragged (floorShift) on the floor: where the web keeps them, on the item,
/// so a submodel's piece is put back in every copy.
template <typename Found>
void eachMovedWaitingPart(const Session::Impl& s, Found found) {
  const auto scan = [&](const std::string& name, const Def& def) {
    for (size_t step = 0; step < def.steps.size(); ++step)
      for (size_t index = 0; index < def.steps[step].items.size(); ++index) {
        const auto& item = def.steps[step].items[index];
        const auto& assembly = fieldObject(item.extra, "assembly");
        const auto turn = assembly.find("floorTurn");
        const bool turned = turn != assembly.end() && turn->is_number() && std::abs(std::remainder(turn->get<double>(), 360)) > 1e-6;
        if (turned || assembly.contains("floorShift")) found(name, step, index, item);
      }
  };
  scan("", s.source.root);
  for (const auto& [name, def] : s.source.submodels) scan(name, def);
}

}  // namespace

size_t movedWaitingPartsOf(const Session::Impl& s) {
  size_t count = 0;
  eachMovedWaitingPart(s, [&](const std::string&, size_t, size_t, const Item&) { ++count; });
  return count;
}

namespace {

std::vector<ItemEdit> putBackEdits(const Session::Impl& s) {
  std::vector<ItemEdit> edits;
  eachMovedWaitingPart(s, [&](const std::string& def, size_t step, size_t index, const Item& before) {
    Item after = before;
    Json assembly = fieldObject(after.extra, "assembly");
    assembly.erase("floorTurn");
    assembly.erase("floorShift");
    setFieldObject(after.extra, "assembly", assembly);
    edits.push_back(edit(def, step, index, before, std::move(after)));
  });
  return edits;
}

const char* putBackName(size_t parts) { return parts == 1 ? "Put Back Waiting Part" : "Put Back Waiting Parts"; }

}  // namespace

Changed putBackWaitingPartsCommand(Session::Impl& s) {
  Command command;
  command.kind = Edit::Motion;  // a turn replans (orientWaitingParts checks the turned pose is clear)
  command.items = putBackEdits(s);
  if (command.items.empty()) return unchanged(s);
  command.name = putBackName(command.items.size());
  return push(s, std::move(command));
}

Changed applyStagingCommand(Session::Impl& s, const StagingSettings& settings, double degrees, bool straighten) {
  std::optional<Command::PlanField> layout, turnField;
  double turn = 0;
  if (!stagingSettingsField(s, settings, layout)) return refusal(s, "Choose a valid staging layout and frame shape.");
  if (!stagingTurnField(s, degrees, turnField, turn)) return refusal(s, "Choose a finite turn.");
  Command command;
  command.kind = Edit::Staging;  // replans, as each part would
  if (straighten) command.items = putBackEdits(s);
  const int parts = (layout ? 1 : 0) + (turnField ? 1 : 0) + (command.items.empty() ? 0 : 1);
  if (parts == 0) return unchanged(s);
  if (parts > 1 || layout) command.name = "Change Staging";
  else if (turnField) command.name = turn != 0 ? "Turn Staging Area" : "Reset Staging Turn";
  else command.name = putBackName(command.items.size());
  if (layout) command.planField = std::move(layout);
  if (turnField) {
    if (command.planField) command.morePlanFields.push_back(std::move(*turnField));
    else command.planField = std::move(turnField);
  }
  return push(s, std::move(command));
}

namespace {

double sceneNumber(const Json& object, const char* key, double fallback) {
  const auto value = object.find(key);
  return value != object.end() && value->is_number() ? value->get<double>() : fallback;
}

std::string sceneString(const Json& object, const char* key) {
  const auto value = object.find(key);
  return value != object.end() && value->is_string() ? value->get<std::string>() : std::string{};
}

bool sceneFlag(const Json& object, const char* key, bool fallback) {
  const auto value = object.find(key);
  return value != object.end() && value->is_boolean() ? value->get<bool>() : fallback;
}

Json scenePoint(bmapp::Vec3 v) { return Json::array({v.x / kStud, -v.y / kStud, -v.z / kStud}); }

bmapp::Vec3 scenePoint(const Json& object, const char* key) {
  const auto value = object.find(key);
  if (value != object.end() && value->is_array() && value->size() == 3 &&
      std::all_of(value->begin(), value->end(), [](const Json& n) { return n.is_number(); })) {
    return {(*value)[0].get<double>() * kStud, (*value)[1].get<double>() * -kStud,
            (*value)[2].get<double>() * -kStud};
  }
  return {NAN, NAN, NAN};
}

bool validScenePose(const SceneCamera& camera) {
  const auto validPoint = [](bmapp::Vec3 v) {
    return std::abs(v.x) <= 1e9 && std::abs(v.y) <= 1e9 && std::abs(v.z) <= 1e9;
  };
  return validPoint(camera.position) && validPoint(camera.target) &&
      std::hypot(camera.position.x - camera.target.x, camera.position.y - camera.target.y,
                 camera.position.z - camera.target.z) >= 1e-3 &&
      camera.fieldOfView >= 8 && camera.fieldOfView <= 130 && std::isfinite(camera.farClip) &&
      camera.nearClip >= 1e-3 && camera.farClip > camera.nearClip;
}

Changed updateSceneSetup(Session::Impl& s, const char* label, const Json& before, Json after) {
  if (before == after) return unchanged(s);
  Command command;
  command.kind = Edit::SceneCamera;
  command.name = label;
  command.planField = Command::PlanField{"sceneSetup", before.empty() ? Json{} : before, std::move(after)};
  return push(s, std::move(command));
}

}  // namespace

SceneCameras sceneCamerasOf(const Session::Impl& s) {
  SceneCameras out;
  const auto& setup = fieldObject(s.source.extra, "sceneSetup");
  out.activeId = sceneString(setup, "activeCameraId");
  out.useForVideo = sceneFlag(setup, "useCameraForVideo", true);
  const auto cameras = setup.find("cameras");
  if (cameras == setup.end() || !cameras->is_array()) return out;
  for (const auto& item : *cameras) {
    if (!item.is_object()) continue;
    SceneCamera camera;
    camera.id = sceneString(item, "id");
    camera.name = sceneString(item, "name");
    camera.position = scenePoint(item, "position");
    camera.target = scenePoint(item, "target");
    camera.fieldOfView = sceneNumber(item, "fov", 42);
    camera.nearClip = sceneNumber(item, "near", 0.05) * kStud;
    camera.farClip = sceneNumber(item, "far", 5000) * kStud;
    camera.orthographic = sceneFlag(item, "orthographic", false);
    if (!camera.id.empty() && validScenePose(camera)) out.cameras.push_back(std::move(camera));
  }
  return out;
}

Changed saveSceneCameraCommand(Session::Impl& s, const SceneCamera& camera) {
  if (camera.id.empty() || camera.name.empty() || !validScenePose(camera))
    return refusal(s, "The camera needs a name and a valid position, target and lens.");
  const auto& before = fieldObject(s.source.extra, "sceneSetup");
  auto after = before;
  auto& cameras = after["cameras"];
  if (!cameras.is_array()) cameras = Json::array();
  auto saved = std::find_if(cameras.begin(), cameras.end(), [&](const auto& item) {
    return item.is_object() && sceneString(item, "id") == camera.id;
  });
  const bool adding = saved == cameras.end();
  Json item = adding ? Json::object() : *saved;
  item["kind"] = "camera";
  item["id"] = camera.id;
  item["name"] = camera.name;
  item["position"] = scenePoint(camera.position);
  item["target"] = scenePoint(camera.target);
  item["fov"] = camera.fieldOfView;
  item["near"] = camera.nearClip / kStud;
  item["far"] = camera.farClip / kStud;
  if (camera.orthographic) item["orthographic"] = true;
  else item.erase("orthographic");
  if (adding) cameras.push_back(std::move(item));
  else *saved = std::move(item);
  if (adding && sceneString(after, "activeCameraId").empty()) {
    after["activeCameraId"] = camera.id;
    after["useCameraForVideo"] = true;
  }
  // SceneSetup objects written by the web editor always carry these fields.
  if (!after.contains("lights")) after["lights"] = Json::array();
  if (!after.contains("useCameraForVideo")) after["useCameraForVideo"] = true;
  if (!after.contains("useLightsForVideo")) after["useLightsForVideo"] = true;
  if (!after.contains("includeStudioLights")) after["includeStudioLights"] = true;
  if (!after.contains("region")) after["region"] = nullptr;
  if (!after.contains("cropToRegion")) after["cropToRegion"] = false;
  if (!after.contains("exposure")) after["exposure"] = 1;
  return updateSceneSetup(s, adding ? "Save Camera" : "Update Camera", before, std::move(after));
}

Changed removeSceneCameraCommand(Session::Impl& s, const std::string& id) {
  const auto& before = fieldObject(s.source.extra, "sceneSetup");
  auto after = before;
  auto cameras = after.find("cameras");
  if (cameras == after.end() || !cameras->is_array()) return unchanged(s);
  const auto found = std::find_if(cameras->begin(), cameras->end(), [&](const auto& item) {
    return item.is_object() && sceneString(item, "id") == id;
  });
  if (found == cameras->end()) return unchanged(s);
  cameras->erase(found);
  if (sceneString(after, "activeCameraId") == id) after["activeCameraId"] = nullptr;
  return updateSceneSetup(s, "Remove Camera", before, std::move(after));
}

Changed activateSceneCameraCommand(Session::Impl& s, const std::string& id) {
  const auto& before = fieldObject(s.source.extra, "sceneSetup");
  auto after = before;
  if (id.empty()) {
    after["useCameraForVideo"] = false;
  } else {
    const auto saved = sceneCamerasOf(s);
    if (std::none_of(saved.cameras.begin(), saved.cameras.end(), [&](const auto& item) { return item.id == id; }))
      return unchanged(s);
    after["activeCameraId"] = id;
    after["useCameraForVideo"] = true;
  }
  return updateSceneSetup(s, "Change Default Video Camera", before, std::move(after));
}

std::string exportCameraOf(const Session::Impl& s) {
  // the web's default, and what it falls back to for anything it does not know
  const Json settings = s.base ? fieldObject(s.base->json, "settings") : Json::object();
  const auto found = settings.find("exportCamera");
  if (found == settings.end() || !found->is_string()) return "track";
  const auto value = found->get<std::string>();
  return value == "automatic" || value == "buildView" ? value : "track";
}

Changed setExportCameraCommand(Session::Impl& s, const std::string& camera) {
  if (camera != "automatic" && camera != "buildView" && camera != "track") return refusal(s, "Choose a video camera.");
  if (camera == exportCameraOf(s)) return unchanged(s);
  const Json before = s.base ? fieldObject(s.base->json, "settings") : Json::object();
  Json after = before;
  after["exportCamera"] = camera;
  Command command;
  command.kind = Edit::CameraTrack;
  command.name = camera == "track" ? "Film Videos with the Camera Track" : camera == "buildView" ? "Film Videos from the Viewport Angle"
                                                                         : "Film Videos with the Automatic Camera";
  command.planField = Command::PlanField{"settings", before.empty() ? Json{} : before, std::move(after), true};
  return push(s, std::move(command));
}

SnapMix snapMixOf(const Session::Impl& s) {
  return s.base ? readSnapMix(fieldObject(fieldObject(s.base->json, "settings"), "video")) : SnapMix{};
}

Changed setSnapMixCommand(Session::Impl& s, const SnapMix& mix) {
  if (!validSnapMix(mix)) return refusal(s, "The snap mix has a setting outside its valid range.");
  if (mix == snapMixOf(s)) return unchanged(s);
  const Json before = s.base ? fieldObject(s.base->json, "settings") : Json::object();
  Json after = before, video = fieldObject(before, "video");
  writeSnapMix(video, mix);
  setFieldObject(after, "video", video);
  Command command;
  command.kind = Edit::SnapSound;
  command.name = "Change Snap Sound";
  command.planField = Command::PlanField{"settings", before.empty() ? Json{} : before, std::move(after), true};
  return push(s, std::move(command));
}


// ---- Look and build settings ----

namespace {

const ScenePresets kScenes = [] {
  const auto c = [](int r, int g, int b) { return bmapp::Vec3{r / 255.0, g / 255.0, b / 255.0}; };
  struct Row { const char *id, *label, *hint; SceneCollection collection; int rgb[3]; bool floor; };
  static const Row rows[] = {
  {"photo-grey", "Reference grey", "Mid-grey tabletop, angled softbox and short contact shadows", SceneCollection::Photo, {159, 161, 164}, true},
  {"slate-blue", "Slate blue", "Blue paper backdrop with cool fill and sculpted shadows", SceneCollection::Photo, {78, 95, 128}, true},
  {"porcelain", "Porcelain", "Light neutral sweep with high-key diffused illumination", SceneCollection::Photo, {220, 220, 218}, true},
  {"sage", "Sage paper", "Muted olive backdrop with clean daylight and soft edge light", SceneCollection::Photo, {168, 175, 153}, true},
  {"sandstone", "Warm catalog", "Beige tabletop with a warm key and subtle cool bounce", SceneCollection::Photo, {209, 194, 172}, true},
  {"catalog-cream", "Catalog cream", "BrickLink-style warm cream backdrop, glossy plastic and soft short shadows", SceneCollection::Photo, {240, 226, 180}, true},
  {"graphite", "Graphite", "Dark matte editorial set with bright rim separation", SceneCollection::Photo, {47, 53, 62}, true},
  {"eyesight", "BrickLink studio", "EyeSight default set: teal studio backdrop and the BrickLink Studio three-light rig", SceneCollection::Photo, {146, 192, 206}, true},
  {"bricklink-white", "BrickLink product", "EyeSight product shot: a uniform white world with a high key and a low side light, fitted to EyeSight renders", SceneCollection::Photo, {255, 255, 255}, true},
  {"eyesight-reference", "EyeSight lighting", "Fitted four-softbox ABS lighting; plain studs match the reference geometry", SceneCollection::Photo, {255, 255, 255}, true},
  {"lavender", "Lavender", "Saturated lilac sweep with tinted overhead shadows", SceneCollection::Render, {151, 130, 231}, true},
  {"render-grey", "Render grey", "Cool light grey seamless with soft overhead light", SceneCollection::Render, {177, 179, 184}, true},
  {"steel-grey", "Steel grey", "Mid cool grey seamless, a touch darker and crisper", SceneCollection::Render, {160, 162, 168}, true},
  {"powder-blue", "Powder blue", "Soft sky-blue sweep for bright, airy shots", SceneCollection::Render, {158, 196, 238}, true},
  {"mint", "Mint", "Fresh pastel green seamless", SceneCollection::Render, {160, 219, 196}, true},
  {"peach", "Peach", "Warm pastel orange with soft warm bounce", SceneCollection::Render, {245, 190, 164}, true},
  {"blush", "Blush pink", "Pastel pink sweep for playful sets", SceneCollection::Render, {241, 175, 198}, true},
  {"butter", "Butter yellow", "Pale warm yellow seamless", SceneCollection::Render, {243, 223, 149}, true},
  {"cobalt", "Cobalt", "Bold saturated blue backdrop for strong contrast", SceneCollection::Render, {57, 98, 220}, true},
  {"catalog-pink", "Pop pink", "Vivid pink collectible backdrop with neutral softbox light", SceneCollection::Render, {255, 74, 169}, true},
  {"catalog-cyan", "Catalog cyan", "Bright cyan-blue collectible backdrop with a soft grounded shadow", SceneCollection::Render, {0, 135, 184}, true},
  {"catalog-ocean", "Ocean blue", "Deep blue backdrop with a brighter blue floor for character portraits", SceneCollection::Render, {0, 106, 164}, true},
  {"catalog-amber", "Amber glow", "Golden floor rising into burnt orange for warm character portraits", SceneCollection::Render, {220, 137, 0}, true},
  {"catalog-olive", "Olive gold", "Muted antique-gold backdrop with soft neutral light", SceneCollection::Render, {156, 138, 59}, true},
  {"catalog-ember", "Ember orange", "Fiery orange floor and deep red backdrop for bold character renders", SceneCollection::Render, {225, 58, 0}, true},
  {"soft", "Soft studio", "Neutral grey, soft contact shadows", SceneCollection::Classic, {183, 182, 191}, true},
  {"classic", "Bright studio", "Plain light backdrop, lit floor", SceneCollection::Classic, {237, 237, 239}, true},
  {"white", "White seamless", "Product-shot white with a glossy floor", SceneCollection::Classic, {245, 245, 247}, true},
  {"dark", "Dark spotlight", "Charcoal backdrop with a pool of light", SceneCollection::Classic, {42, 43, 48}, true},
  {"black", "Black stage", "Pure black, no floor: bright bricks floating in the dark, as in the KenBrick videos", SceneCollection::Classic, {0, 0, 0}, false},
  {"warm", "Warm paper", "Soft beige, gentle warm light", SceneCollection::Classic, {234, 225, 209}, true},
  {"sky", "Sky blue", "Fresh light-blue gradient", SceneCollection::Classic, {201, 220, 240}, true},
  {"night", "Midnight", "Deep navy with a cool spotlight", SceneCollection::Classic, {17, 21, 36}, true},
  {"chroma", "Green screen", "Flat chroma green for compositing, no floor", SceneCollection::Classic, {0, 177, 64}, false},
  };
  ScenePresets out;
  for (const Row& row : rows) {
    ScenePreset scene;
    scene.id = row.id, scene.label = row.label, scene.hint = row.hint, scene.collection = row.collection;
    scene.background = c(row.rgb[0], row.rgb[1], row.rgb[2]);
    scene.floor = row.floor;
    out.push_back(std::move(scene));
  }
  return out;
}();

template <class E, size_t N>
using Names = std::array<std::pair<E, const char*>, N>;
constexpr Names<Shading, 7> kShadingNames{{{Shading::Standard, "standard"}, {Shading::Studio, "studio"},
    {Shading::Neural, "neural"}, {Shading::HybridRT, "hybrid-rt"}, {Shading::ScreenSpaceGI, "ssgi"},
    {Shading::PathTraced, "path-traced"}, {Shading::RealTimePathTraced, "realtime-path-traced"}}};
constexpr Names<BuildOrder, 2> kOrderNames{{{BuildOrder::TakeApart, "take-apart"}, {BuildOrder::BottomUp, "bottom-up"}}};
constexpr Names<FlightShape, 3> kFlightNames{{{FlightShape::Automatic, "auto"}, {FlightShape::Web, "web"}, {FlightShape::Arc, "arc"}}};

template <class E, size_t N>
void readName(const Json& object, const char* key, const Names<E, N>& names, E& out) {
  const auto it = object.find(key);
  if (it == object.end() || !it->is_string()) return;
  for (const auto& [value, name] : names)
    if (*it == name) out = value;
}

template <class E, size_t N>
const char* nameOf(const Names<E, N>& names, E value) {
  for (const auto& [v, name] : names)
    if (v == value) return name;
  return names[0].second;
}

void readNumber(const Json& object, const char* key, double low, double high, double& out) {
  const auto it = object.find(key);
  if (it != object.end() && it->is_number() && std::isfinite(it->get<double>()))
    out = std::clamp(it->get<double>(), low, high);
}

bool within(double value, double low, double high) { return std::isfinite(value) && value >= low && value <= high; }

const Json& settingsOf(const Session::Impl& s) {
  static const Json empty = Json::object();
  return s.base ? fieldObject(s.base->json, "settings") : empty;
}

Changed updateSettings(Session::Impl& s, Edit kind, const char* name, const Json& before, Json after) {
  if (after == before) return unchanged(s);
  Command command;
  command.kind = kind;
  command.name = name;
  command.planField = Command::PlanField{"settings", before.empty() ? Json{} : before, std::move(after), true};
  return push(s, std::move(command));
}

}  // namespace

const ScenePresets& scenePresets() { return kScenes; }

const ScenePreset* scenePreset(const std::string& id) {
  const auto found = std::find_if(kScenes.begin(), kScenes.end(), [&](const auto& scene) { return scene.id == id; });
  return found == kScenes.end() ? nullptr : &*found;
}

RenderLook renderLookOf(const Session::Impl& s) {
  RenderLook look;
  const Json& settings = settingsOf(s);
  const Json& video = fieldObject(settings, "video");
  const Json& materials = fieldObject(video, "materials");
  const Json& native = fieldObject(fieldObject(settings, "native"), "look");
  if (const auto it = video.find("studioLook"); it != video.end() && it->is_string() && scenePreset(it->get<std::string>()))
    look.scene = it->get<std::string>();
  if (const auto it = video.find("edgeLines"); it != video.end() && it->is_boolean()) look.edges = it->get<bool>();
  const Json& ao = fieldObject(materials, "ao");
  if (const auto it = ao.find("enabled"); it != ao.end() && it->is_boolean()) look.ambientOcclusion = it->get<bool>();
  // The web's floor kind: "none" has no floor, "auto" is the scene's own.
  const auto floor = materials.find("floor");
  const bool automatic = floor == materials.end() || !floor->is_string() || *floor == "auto";
  if (automatic) look.floor = look.scene.empty() || scenePreset(look.scene)->floor;
  else look.floor = *floor != "none";
  double samples = look.pathSamples;
  readNumber(video, "pathSamples", 8, 1024, samples);
  look.pathSamples = static_cast<int>(std::lround(samples));
  readName(native, "shading", kShadingNames, look.shading);
  const auto flag = [&](const char* key, bool& out) {
    if (const auto it = native.find(key); it != native.end() && it->is_boolean()) out = it->get<bool>();
  };
  flag("shadows", look.shadows);
  flag("raytracedGlass", look.raytracedGlass);
  flag("worldGiOcclusion", look.worldGiOcclusion);
  flag("lightsFollowCamera", look.lightsFollowCamera);
  flag("smoothCurves", look.smoothCurves);
  flag("roundedEdges", look.roundedEdges);
  flag("softStudRoots", look.softStudRoots);
  return look;
}

Changed setRenderLookCommand(Session::Impl& s, const RenderLook& look) {
  if (!look.scene.empty() && !scenePreset(look.scene)) return refusal(s, "Choose one of the listed scenes.");
  if (look.pathSamples < 8 || look.pathSamples > 1024) return refusal(s, "Path tracing takes 8 to 1024 samples.");
  const RenderLook current = renderLookOf(s);
  const Json& before = settingsOf(s);
  Json after = before, video = fieldObject(before, "video"), native = fieldObject(before, "native");
  Json materials = fieldObject(video, "materials"), own = fieldObject(native, "look");
  // Only what changed is written, so a web project keeps every key it had.
  if (look.scene != current.scene) {
    if (look.scene.empty()) video.erase("studioLook");
    else video["studioLook"] = look.scene;
  }
  if (look.edges != current.edges) video["edgeLines"] = look.edges;
  if (look.ambientOcclusion != current.ambientOcclusion) {
    Json ao = fieldObject(materials, "ao");
    ao["enabled"] = look.ambientOcclusion;
    if (!ao.contains("strength")) ao["strength"] = nullptr;
    if (!ao.contains("radius")) ao["radius"] = nullptr;
    materials["ao"] = ao;
  }
  // A changed scene may bring its own floor; the floor is written only when it was asked for.
  const bool sceneFloor = look.scene.empty() || scenePreset(look.scene)->floor;
  const bool floorAsked = look.floor != current.floor || (look.scene != current.scene && look.floor != sceneFloor);
  if (floorAsked) materials["floor"] = look.floor == sceneFloor ? "auto" : look.floor ? "shadow" : "none";
  if (look.pathSamples != current.pathSamples) video["pathSamples"] = look.pathSamples;
  if (look.shading != current.shading) own["shading"] = nameOf(kShadingNames, look.shading);
  const auto flag = [&](const char* key, bool wanted, bool had) { if (wanted != had) own[key] = wanted; };
  flag("shadows", look.shadows, current.shadows);
  flag("raytracedGlass", look.raytracedGlass, current.raytracedGlass);
  flag("worldGiOcclusion", look.worldGiOcclusion, current.worldGiOcclusion);
  flag("lightsFollowCamera", look.lightsFollowCamera, current.lightsFollowCamera);
  flag("smoothCurves", look.smoothCurves, current.smoothCurves);
  flag("roundedEdges", look.roundedEdges, current.roundedEdges);
  flag("softStudRoots", look.softStudRoots, current.softStudRoots);
  setFieldObject(video, "materials", materials);
  setFieldObject(native, "look", own);
  setFieldObject(after, "video", video);
  setFieldObject(after, "native", native);
  return updateSettings(s, Edit::Look, "Change Look", before, std::move(after));
}

BuildSettings buildSettingsOf(const Session::Impl& s) {
  BuildSettings b;
  const Json& build = fieldObject(fieldObject(settingsOf(s), "native"), "build");
  if (const auto it = build.find("planner"); it != build.end() && *it == "standard") b.standardPlanner = true;
  readName(build, "order", kOrderNames, b.order);
  readName(build, "flight", kFlightNames, b.flight);
  if (const auto it = build.find("cleanGrownUnits"); it != build.end() && it->is_boolean()) b.cleanGrownUnits = it->get<bool>();
  readNumber(build, "piecesPerSecond", 0.25, 12, b.piecesPerSecond);
  readNumber(build, "gap", 0, 2, b.gap);
  readNumber(build, "stepPause", 0, 5, b.stepPause);
  readNumber(build, "clearance", 4, 200, b.clearance);
  readNumber(build, "corner", 0, 80, b.corner);
  readNumber(fieldObject(settingsOf(s), "video"), "targetSeconds", 0, 3600, b.videoSeconds);
  return b;
}

Changed setBuildSettingsCommand(Session::Impl& s, const BuildSettings& b) {
  if (!within(b.piecesPerSecond, 0.25, 12) || !within(b.gap, 0, 2) || !within(b.stepPause, 0, 5) ||
      !within(b.clearance, 4, 200) || !within(b.corner, 0, 80))
    return refusal(s, "A build setting is outside its valid range.");
  const Json& before = settingsOf(s);
  Json after = before, native = fieldObject(before, "native");
  // Defaults are left out: a project that never changed them has no `build` object.
  const BuildSettings d;
  Json build = Json::object();
  if (b.standardPlanner) build["planner"] = "standard";
  if (b.order != d.order) build["order"] = nameOf(kOrderNames, b.order);
  if (b.flight != d.flight) build["flight"] = nameOf(kFlightNames, b.flight);
  if (b.cleanGrownUnits) build["cleanGrownUnits"] = true;
  const auto number = [&](const char* key, double value, double standard) {
    if (value != standard) build[key] = std::round(value * 1000) / 1000;
  };
  number("piecesPerSecond", b.piecesPerSecond, d.piecesPerSecond);
  number("gap", b.gap, d.gap);
  number("stepPause", b.stepPause, d.stepPause);
  number("clearance", b.clearance, d.clearance);
  number("corner", b.corner, d.corner);
  setFieldObject(native, "build", build);
  setFieldObject(after, "native", native);
  return updateSettings(s, Edit::BuildSettings, "Change Build Settings", before, std::move(after));
}
Changed turnWaitingPartCommand(Session::Impl& s, uint32_t piece, double degrees) {
  if (!std::isfinite(degrees) || piece >= s.refs.size()) return unchanged(s);
  const auto targets = resolve(s, {piece}, true);
  if (targets.empty() || s.refs[piece].chain.size() != 1) return unchanged(s);
  const auto& target = targets.front().loc;
  const auto& before = at(s.source, target);
  Json assembly = fieldObject(before.extra, "assembly");
  const auto saved = assembly.find("floorTurn");
  const double existing = saved != assembly.end() && saved->is_number() ? saved->get<double>() : 0;
  const double turn = std::remainder(std::remainder(degrees, 360) + std::remainder(existing, 360), 360);
  if (std::abs(turn) < 1e-6) assembly.erase("floorTurn");
  else assembly["floorTurn"] = turn < 0 ? turn + 360 : turn;
  Item after = before;
  setFieldObject(after.extra, "assembly", assembly);
  if (after.extra == before.extra) return unchanged(s);
  Command command;
  command.kind = Edit::Motion;
  command.name = "Turn Waiting Part";
  command.items.push_back(edit(target.def, target.step, target.index, before, std::move(after)));
  return push(s, std::move(command));
}

namespace {

/// assembly.floorShift, [x, z] studs in the web's world; zero when absent or malformed.
std::array<double, 2> floorShiftField(const Json& assembly) {
  const auto it = assembly.find("floorShift");
  if (it == assembly.end() || !it->is_array() || it->size() != 2 || !(*it)[0].is_number() || !(*it)[1].is_number()) return {0, 0};
  const double x = (*it)[0].get<double>(), z = (*it)[1].get<double>();
  return std::isfinite(x) && std::isfinite(z) ? std::array<double, 2>{x, z} : std::array<double, 2>{0, 0};
}

}  // namespace

Changed shiftWaitingPartCommand(Session::Impl& s, uint32_t piece, bm::Vec3 delta) {
  if (!std::isfinite(delta.x) || !std::isfinite(delta.z) || piece >= s.refs.size()) return unchanged(s);
  const auto targets = resolve(s, {piece}, true);
  if (targets.empty()) return unchanged(s);
  const auto& target = targets.front().loc;
  const auto& before = at(s.source, target);
  if (before.submodel) return unchanged(s);
  Json assembly = fieldObject(before.extra, "assembly");
  // as the web's shiftOnFloor: added to the drag before, in studs of the web's x and z (LDU -z)
  const auto old = floorShiftField(assembly);
  const auto round = [](double v) { return std::round(v * 1000) / 1000; };
  const double x = round(old[0] + delta.x / 20), z = round(old[1] - delta.z / 20);
  if (std::abs(x) > 1e5 || std::abs(z) > 1e5) return refusal(s, "That is too far from the model to wait.");
  if (x == 0 && z == 0) assembly.erase("floorShift");
  else assembly["floorShift"] = Json::array({x, z});
  Item after = before;
  setFieldObject(after.extra, "assembly", assembly);
  if (after.extra == before.extra) return unchanged(s);
  Command command;
  command.kind = Edit::WaitingSpot;
  command.name = "Move Waiting Part";
  command.items.push_back(edit(target.def, target.step, target.index, before, std::move(after)));
  return push(s, std::move(command));
}

bm::Vec3 waitingShiftOf(const Session::Impl& s, uint32_t piece) {
  if (piece >= s.refs.size()) return {};
  const auto targets = resolve(s, {piece}, true);
  if (targets.empty()) return {};
  const auto shift = floorShiftField(fieldObject(at(s.source, targets.front().loc).extra, "assembly"));
  return {shift[0] * 20, 0, -shift[1] * 20};
}

bm::Vec3 insertionDirectionOf(const Session::Impl& s, uint32_t piece) {
  const auto targets = resolve(s, {piece}, true);
  if (targets.empty()) return {};
  const auto& t = targets.front();
  const auto& assembly = fieldObject(at(s.source, t.loc).extra, "assembly");
  const auto direction = assembly.find("insertionAxis");
  if (direction == assembly.end() || !direction->is_array() || direction->size() != 3 ||
      !std::all_of(direction->begin(), direction->end(), [](const auto& v) { return v.is_number(); })) return {};
  const bm::Vec3 local{(*direction)[0].get<double>(), (*direction)[1].get<double>(), (*direction)[2].get<double>()};
  return bm::normalized(t.parent.r * local);
}

Changed setInsertionDirectionCommand(Session::Impl& s, const PieceList& pieces, bm::Vec3 direction) {
  const double magnitude = bm::length(direction);
  if (!std::isfinite(magnitude)) return refusal(s, "Choose a finite direction.");
  Command c;
  c.kind = Edit::InsertionDirection;
  c.name = magnitude > 1e-8 ? "Set Insertion Direction" : "Reset Insertion Direction";
  for (const auto& target : resolve(s, pieces, true)) {
    const auto& before = at(s.source, target.loc);
    Item item = before;
    Json assembly = fieldObject(item.extra, "assembly");
    const bm::Vec3 local = bm::normalized(target.parent.inverse().r * direction);
    if (magnitude > 1e-8) assembly["insertionAxis"] = Json::array({local.x, local.y, local.z});
    else assembly.erase("insertionAxis");
    setFieldObject(item.extra, "assembly", assembly);
    if (item.extra != before.extra)
      c.items.push_back(edit(target.loc.def, target.loc.step, target.loc.index, before, std::move(item)));
  }
  return c.items.empty() ? unchanged(s) : push(s, std::move(c));
}

Changed scaleCommand(Session::Impl& s, const PieceList& pieces, bm::Vec3 factor, bm::Mat3 axes, bm::Vec3 pivot, bool continuing) {
  if (!std::isfinite(factor.x) || !std::isfinite(factor.y) || !std::isfinite(factor.z) ||
      std::min({factor.x, factor.y, factor.z}) <= 0 || std::abs(bm::determinant(axes)) < 1e-8)
    return refusal(s, "Choose positive scale factors.");
  const auto multiply = [](bm::Vec3 a, bm::Vec3 b) {
    return bm::Vec3{std::clamp(a.x * b.x, 0.05, 20.0), std::clamp(a.y * b.y, 0.05, 20.0), std::clamp(a.z * b.z, 0.05, 20.0)};
  };
  const auto change = [&](bm::Vec3 factors) {
    const bm::Mat3 basis{{factors.x, 0, 0, 0, factors.y, 0, 0, 0, factors.z}};
    const bm::Mat3 matrix = axes * basis * bm::inverse(axes);
    return bm::Xform{matrix, pivot - matrix * pivot};
  };
  if (continuing) {
    if (Command* c = openGesture(s, Edit::Scale, pieces)) {
      c->total = multiply(c->total, factor);
      return regrow(s, *c, change(c->total));
    }
  }
  factor = multiply({1, 1, 1}, factor);
  if (factor == bm::Vec3{1, 1, 1}) return unchanged(s);
  return transformCommand(s, Edit::Scale, "Scale", pieces, change(factor), continuing, factor, {}, 0, pivot);
}

namespace {

Command animationEdit(const Session::Impl& s, std::string name, Json next) {
  Command c;
  c.kind = Edit::Keyframes;
  c.name = std::move(name);
  const auto& prior = animationObject(s);
  c.planField = Command::PlanField{"animation", prior.empty() ? Json{} : prior, std::move(next)};
  return c;
}

Json editableAnimation(const Session::Impl& s) {
  Json next = animationObject(s);
  const auto scene = readKeyScene(s);
  next["fps"] = scene.fps;
  next["startFrame"] = scene.first;
  next["endFrame"] = scene.last;
  if (!next.contains("tracks") || !next["tracks"].is_array()) next["tracks"] = Json::array();
  return next;
}

std::string keyTarget(const Session::Impl& s, uint32_t piece, const Loc& location, const Json& tracks, bool submodel = false) {
  if (!submodel && s.refs[piece].chain.size() > 1) {
    const auto leaf = qualifiedKeyTarget(animationItemIds(s.source), s.refs[piece].chain);
    const auto& original = s.model->pieces()[piece].id;
    for (const auto& track : tracks) {
      if (text(track, "model") != location.def || text(track, "source") != "baked-flight") continue;
      auto target = text(track, "target");
      if (target == leaf || target == original) return target;
    }
  }
  return text(at(s.source, location).extra, "id");
}

}  // namespace

void prepareBakeEdit(FlightBake::Impl& bake, const Session::Impl& s, const PieceList& pieces) {
  bake.generation = s.generation;
  bake.version = s.version;
  bake.scope = focusedDef(s);
  if (pieces.size() > 2000) {
    bake.result = FlightBakeResult{0, 0, "This bake would exceed the 2,000-track project limit."};
    return;
  }
  bake.command = animationEdit(s, bake.detach ? "Bake All and Detach Build" : "Bake Selected Flights", editableAnimation(s));
  const auto locations = locate(s.source);
  auto ids = animationItemIds(s.source);
  std::unordered_set<std::string> taken;
  for (const auto& [item, id] : ids) taken.insert(id);
  std::unordered_set<std::string> targets;
  for (size_t i = 0; i < pieces.size(); ++i) {
    const auto& chain = s.refs[pieces[i]].chain;
    for (const ItemId item : chain) {
      if (ids.contains(item)) continue;
      std::string id = "flight-" + std::to_string(item);
      while (!taken.insert(id).second) id += "-new";
      ids.emplace(item, id);
      const auto& location = locations.at(item);
      const auto& prior = at(s.source, location);
      Item after = prior;
      setText(after.extra, "id", id);
      bake.command.items.push_back(edit(location.def, location.step, location.index, prior, std::move(after)));
    }
    auto target = qualifiedKeyTarget(ids, chain);
    if (target.empty() || !targets.insert(target).second) {
      bake.result = FlightBakeResult{0, 0, "Two pieces share an animation ID. Give each piece a unique ID before baking."};
      return;
    }
    auto& captured = bake.targets[i];
    captured.id = std::move(target);
    if (auto prior = s.model->pieces()[pieces[i]].id; prior != captured.id) captured.previousId = std::move(prior);
  }
  for (const auto& target : bake.targets)
    if (!target.previousId.empty()) targets.insert(target.previousId);
  const auto& tracks = bake.command.planField->after["tracks"];
  bake.replace = std::any_of(tracks.begin(), tracks.end(), [&](const Json& track) {
    return text(track, "kind") == "object" && text(track, "model") == bake.scope &&
           targets.contains(text(track, "target"));
  });
}

Changed applyBakeEdit(Session::Impl& s, FlightBake::Impl& bake) {
  const std::lock_guard lock(bake.mutex);
  if (s.generation != bake.generation || s.version != bake.version)
    return refusal(s, "The model or animation changed during the bake. Run the bake again.");
  if (!bake.result || !bake.result->error.empty() || !bake.command.planField) return unchanged(s);
  Command command = std::move(bake.command);
  bake.command.planField.reset();
  return push(s, std::move(command));
}

Changed setKeySceneCommand(Session::Impl& s, const KeyScene& scene) {
  if (scene.fps < 1 || scene.fps > 120 || scene.first < 0 || scene.last > 20000 || scene.first >= scene.last)
    return refusal(s, "Choose a frame rate from 1 to 120 and an increasing frame range.");
  const auto before = readKeyScene(s);
  Json next = editableAnimation(s);
  for (auto& track : next["tracks"]) {
    if (!track.is_object() || !track.contains("channels") || !track["channels"].is_object()) continue;
    for (auto& lane : track["channels"]) {
      if (!lane.is_array()) continue;
      Json retimed = Json::array();
      for (auto key : lane) {
        if (!key.is_object() || !key.contains("frame") || !key["frame"].is_number_integer()) continue;
        const int original = key["frame"].get<int>();
        const int frame = scene.fps == before.fps ? original :
            before.first + static_cast<int>(std::lround((original - before.first) * (static_cast<double>(scene.fps) / before.fps)));
        if (frame < scene.first || frame > scene.last) return refusal(s, "The range must include every existing key.");
        key["frame"] = frame;
        if (!retimed.empty() && retimed.back()["frame"] == frame) retimed.back() = std::move(key);
        else retimed.push_back(std::move(key));
      }
      lane = std::move(retimed);
    }
  }
  next["fps"] = scene.fps;
  next["startFrame"] = scene.first;
  next["endFrame"] = scene.last;
  auto& layers = next["buildLayers"];
  if (!layers.is_object()) layers = Json::object();
  const std::string model = focusedDef(s);
  for (auto& layer : layers) {
    if (!layer.is_object() || !layer.contains("startFrame") || !layer["startFrame"].is_number_integer()) continue;
    const int old = layer["startFrame"].get<int>();
    const int converted = before.first + static_cast<int>(std::lround((old - before.first) * (static_cast<double>(scene.fps) / before.fps)));
    layer["startFrame"] = std::clamp(converted, scene.first, scene.last);
  }
  if (scene.buildLinked) {
    const double speed = std::isfinite(scene.buildSpeed) ? std::clamp(scene.buildSpeed, 0.1, 4.0) : 1;
    layers[model] = {{"startFrame", std::clamp(scene.buildStart, scene.first, scene.last)}, {"speed", speed}};
  } else {
    layers.erase(model);
  }
  if (layers.empty()) next.erase("buildLayers");
  if (next == animationObject(s)) return unchanged(s);
  return push(s, animationEdit(s, "Edit Animation Scene", std::move(next)));
}

Changed setKeysCommand(Session::Impl& s, uint32_t piece, const KeyList& keys, bool continuing, bool remove,
                       bool baked, const KeyScene* openedFlight, bool submodel, const char* name) {
  if (!s.model || piece >= s.refs.size() || keys.empty()) return unchanged(s);
  const auto& chain = s.refs[piece].chain;
  if (chain.empty()) return unchanged(s);
  if (baked && chain.size() != 1) return refusal(s, "Open the submodel to bake an individual flight.");
  const auto where = locate(s.source);
  const Loc& location = where.at(chain.front());
  const auto& old = at(s.source, location);
  if (location.def != focusedDef(s)) return unchanged(s);
  Item ready = old;
  Json next = editableAnimation(s);
  if (submodel && !old.submodel) return unchanged(s);
  std::string target = keyTarget(s, piece, location, next["tracks"], submodel);
  if (target.empty()) {
    if (remove) return unchanged(s);
    target = s.model->pieces()[piece].id;
    if (old.submodel) target = target.substr(0, target.find('/'));
    setText(ready.extra, "id", target);
  }
  auto scene = readKeyScene(s);
  if (openedFlight) {
    const auto& requested = *openedFlight;
    if (requested.fps != scene.fps || requested.first != scene.first || requested.last < scene.last ||
        requested.last > 20000 || requested.buildStart < scene.first || requested.buildStart > requested.last ||
        !requested.buildLinked || !std::isfinite(requested.buildSpeed) || requested.buildSpeed < 0.1 || requested.buildSpeed > 4)
      return refusal(s, "The editable flight is outside the animation scene.");
    scene = requested;
    next["endFrame"] = scene.last;
    auto& layers = next["buildLayers"];
    if (!layers.is_object()) layers = Json::object();
    layers[location.def] = {{"startFrame", scene.buildStart}, {"speed", scene.buildSpeed}};
  }
  auto& tracks = next["tracks"];
  auto track = std::find_if(tracks.begin(), tracks.end(), [&](const auto& row) {
    return text(row, "model") == location.def && text(row, "target") == target;
  });
  if (track == tracks.end()) {
    if (remove) return unchanged(s);
    if (tracks.size() >= 2000) return refusal(s, "The project already has 2,000 animated objects.");
    tracks.push_back({{"kind", "object"}, {"model", location.def}, {"target", target}, {"channels", Json::object()}});
    track = std::prev(tracks.end());
  }
  if (baked) (*track)["source"] = "baked-flight";
  auto& channels = (*track)["channels"];
  if (!channels.is_object()) channels = Json::object();
  for (const auto& key : keys) {
    const auto channel = static_cast<size_t>(key.channel);
    size_t curve = static_cast<size_t>(key.interpolation);
    if (channel >= kKeyChannels.size() || curve >= kKeyInterpolation.size() || !std::isfinite(key.value) ||
        key.frame < scene.first || key.frame > scene.last) continue;
    if (key.channel == KeyChannel::Visibility) curve = static_cast<size_t>(KeyInterpolation::Hold);
    auto& lane = channels[kKeyChannels[channel]];
    if (!lane.is_array()) lane = Json::array();
    const auto existing = std::lower_bound(lane.begin(), lane.end(), key.frame, [](const auto& item, int frame) {
      return item.is_object() && item.value("frame", -1) < frame;
    });
    const bool same = existing != lane.end() && existing->is_object() && existing->value("frame", -1) == key.frame;
    if (remove && same) lane.erase(existing);
    if (!remove) {
      if (!same && lane.size() >= 5000) return refusal(s, "This property already has 5,000 keys.");
      const double value = key.channel == KeyChannel::Visibility ? (key.value >= 0.5 ? 1 : 0) :
          key.channel >= KeyChannel::ScaleX ? std::clamp(key.value, 0.001, 100.0) : std::clamp(key.value, -1e6, 1e6);
      const Json row = {{"frame", key.frame}, {"value", value}, {"interpolation", kKeyInterpolation[curve]}};
      if (same) *existing = row;
      else lane.insert(existing, row);
    }
    if (lane.empty()) channels.erase(kKeyChannels[channel]);
  }
  if (channels.empty()) tracks.erase(track);
  if (next == animationObject(s)) return unchanged(s);
  const int frame = keys.front().frame;
  if (continuing && s.history.cursor > 0 && s.history.cursor == s.history.done.size()) {
    auto& c = s.history.done[s.history.cursor - 1];
    if (c.kind == Edit::Keyframes && c.open && c.planField && c.pieces == PieceList{piece} &&
        c.stepIndex == static_cast<size_t>(frame)) {
      c.planField->after = std::move(next);
      s.source.extra["animation"] = c.planField->after;
      return finish(s, c);
    }
  }
  auto c = animationEdit(s, name ? name : baked ? "Bake Build Motion" : remove ? "Delete Keyframes" : "Set Keyframes", std::move(next));
  c.pieces = {piece};
  c.open = continuing;
  c.stepIndex = static_cast<size_t>(frame);
  if (old.extra != ready.extra) c.items.push_back(edit(location.def, location.step, location.index, old, std::move(ready)));
  return push(s, std::move(c));
}

namespace {

constexpr KeyChannel kLocation[3] = {KeyChannel::PositionX, KeyChannel::PositionY, KeyChannel::PositionZ};

/// A piece's flight open as keys (a baked track of its own), or nothing.
std::optional<KeyTrack> openFlightTrack(const Session::Impl& s, uint32_t piece) {
  auto track = readKeyTrack(s, piece);
  if (!track || !track->baked || track->members.size() != 1) return std::nullopt;
  return track;
}

/// The frames that hold a location key, first to last.
std::vector<int> locationFrames(const KeyTrack& track) {
  std::set<int> frames;
  for (const auto& key : track.keys)
    if (key.channel <= KeyChannel::PositionZ) frames.insert(key.frame);
  return {frames.begin(), frames.end()};
}

/// flightPath.ts fullPathKeys: every location channel keyed at each of its path points and at
/// `extra`, each at the value it has there, so moving or adding a point leaves the rest of the
/// path as it was. A key takes the curve of the key before it on its channel (linear first).
KeyList fullPathKeys(const KeyTrack& track, const std::vector<int>& extra) {
  std::vector<int> frames = locationFrames(track);
  frames.insert(frames.end(), extra.begin(), extra.end());
  std::sort(frames.begin(), frames.end());
  frames.erase(std::unique(frames.begin(), frames.end()), frames.end());
  KeyList out;
  for (const KeyChannel channel : kLocation) {
    std::vector<const Keyframe*> lane;
    for (const auto& key : track.keys)
      if (key.channel == channel) lane.push_back(&key);
    std::sort(lane.begin(), lane.end(), [](const Keyframe* a, const Keyframe* b) { return a->frame < b->frame; });
    for (const int frame : frames) {
      const auto at = std::lower_bound(lane.begin(), lane.end(), frame, [](const Keyframe* k, int f) { return k->frame < f; });
      if (at != lane.end() && (*at)->frame == frame) continue;
      const KeyInterpolation curve = at == lane.begin() ? KeyInterpolation::Linear : (*std::prev(at))->interpolation;
      out.push_back({channel, frame, sampleKeys(track, channel, frame), curve});
    }
  }
  return out;
}

}  // namespace

Changed addFlightPathPointCommand(Session::Impl& s, uint32_t piece, int frame) {
  const auto track = openFlightTrack(s, piece);
  if (!track) return refusal(s, "Open the part's flight as keys to edit its path.");
  const auto frames = locationFrames(*track);
  if (frames.size() < 2 || frame <= frames.front() || frame >= frames.back()) return refusal(s, "Add a path point between the first and the last.");
  if (std::binary_search(frames.begin(), frames.end(), frame)) return unchanged(s);
  return setKeysCommand(s, piece, fullPathKeys(*track, {frame}), false, false, false, nullptr, false, "Add Path Point");
}

Changed setFlightPathPointCommand(Session::Impl& s, uint32_t piece, int frame, bm::Vec3 location, bool continuing) {
  if (!std::isfinite(location.x) || !std::isfinite(location.y) || !std::isfinite(location.z)) return unchanged(s);
  const auto track = openFlightTrack(s, piece);
  if (!track) return refusal(s, "Open the part's flight as keys to edit its path.");
  KeyList keys = fullPathKeys(*track, {frame});
  std::erase_if(keys, [&](const Keyframe& key) { return key.frame == frame; });
  const double values[3] = {location.x, location.y, location.z};
  for (int i = 0; i < 3; ++i) {
    const auto& lane = track->keys;
    const auto same = std::find_if(lane.begin(), lane.end(), [&](const Keyframe& k) { return k.channel == kLocation[i] && k.frame == frame; });
    const auto before = std::find_if(lane.rbegin(), lane.rend(), [&](const Keyframe& k) { return k.channel == kLocation[i] && k.frame < frame; });
    const KeyInterpolation curve = same != lane.end() ? same->interpolation : before != lane.rend() ? before->interpolation : KeyInterpolation::Linear;
    keys.push_back({kLocation[i], frame, std::round(values[i] * 1000) / 1000, curve});
  }
  // the drag's own step: keyed by the moved point's frame, so it is that frame's keys first
  std::stable_partition(keys.begin(), keys.end(), [&](const Keyframe& key) { return key.frame == frame; });
  return setKeysCommand(s, piece, keys, continuing, false, false, nullptr, false, "Move Path Point");
}

Changed deleteFlightPathPointCommand(Session::Impl& s, uint32_t piece, int frame) {
  const auto track = openFlightTrack(s, piece);
  if (!track) return refusal(s, "Open the part's flight as keys to edit its path.");
  const auto frames = locationFrames(*track);
  if (!std::binary_search(frames.begin(), frames.end(), frame)) return unchanged(s);
  if (frames.size() <= 2 || frame == frames.front() || frame == frames.back())
    return refusal(s, "The first and last path points hold the start and the seat.");
  KeyList keys;
  for (const KeyChannel channel : kLocation) keys.push_back({channel, frame, 0, KeyInterpolation::Linear});
  return setKeysCommand(s, piece, keys, false, true, false, nullptr, false, "Delete Path Point");
}

Changed updateFlightCommand(Session::Impl& s, uint32_t piece, const FlightPoseList* route) {
  if (piece >= s.refs.size() || s.refs[piece].chain.empty()) return unchanged(s);
  const auto& chain = s.refs[piece].chain;
  const bool nested = chain.size() > 1;
  if (nested && route) return refusal(s, "Open the containing submodel to save an edited route for its definition.");
  const auto locations = locate(s.source);
  const Loc& location = locations.at(chain.front());
  if (location.def != focusedDef(s)) return unchanged(s);
  const Item& before = at(s.source, location);
  Item after = before;
  Json assembly = nested ? Json::object() : fieldObject(before.extra, "assembly");
  bool custom = assembly.erase("flight") > 0;
  if (route) {
    if (route->size() < 2 || route->size() > 256) return refusal(s, "The selected flight has no editable motion.");
    Json poses = Json::array();
    for (const auto& pose : *route) {
      const double length = std::hypot(std::hypot(pose.qx, pose.qy), std::hypot(pose.qz, pose.qw));
      if (!std::isfinite(length) || length < 1e-9 || !std::isfinite(pose.position.x) ||
          !std::isfinite(pose.position.y) || !std::isfinite(pose.position.z))
        return refusal(s, "The flight contains an invalid pose.");
      poses.push_back({pose.position.x, pose.position.y, pose.position.z,
                       pose.qx / length, pose.qy / length, pose.qz / length, pose.qw / length});
    }
    poses.back() = {0, 0, 0, 0, 0, 0, 1};
    assembly["flight"] = std::move(poses);
    custom = true;
  }
  if (custom) setFieldObject(after.extra, "assembly", assembly);

  const auto id = nested ? qualifiedKeyTarget(animationItemIds(s.source), chain) : text(before.extra, "id");
  const std::string legacyId = nested ? s.model->pieces()[piece].id : "";
  Json next = editableAnimation(s);
  auto& tracks = next["tracks"];
  const auto track = std::find_if(tracks.begin(), tracks.end(), [&](const auto& row) {
    if (text(row, "model") != location.def || text(row, "kind") != "object" || text(row, "source") != "baked-flight") return false;
    const auto target = text(row, "target");
    return (!id.empty() && target == id) || (!legacyId.empty() && target == legacyId);
  });
  if (track == tracks.end() && !custom) return unchanged(s);
  if (track != tracks.end()) tracks.erase(track);
  const auto scene = readKeyScene(s);
  if (!scene.buildLinked) {
    auto& layers = next["buildLayers"];
    if (!layers.is_object()) layers = Json::object();
    layers[location.def] = {{"startFrame", scene.first}, {"speed", 1.0}};
  }
  auto command = animationEdit(s, route ? "Use Flight in Build" : "Return Flight to Planner", std::move(next));
  if (custom) {
    command.kind = Edit::InsertionDirection;
    command.items.push_back(edit(location.def, location.step, location.index, before, std::move(after)));
  }
  return push(s, std::move(command));
}

Changed moveKeyCommand(Session::Impl& s, uint32_t piece, KeyChannel channel, int from, int to) {
  const auto index = static_cast<size_t>(channel);
  if (piece >= s.refs.size() || s.refs[piece].chain.empty() || index >= kKeyChannels.size() || from == to) return unchanged(s);
  const auto range = readKeyScene(s);
  if (to < range.first || to > range.last) return refusal(s, "The key must stay within the scene range.");
  const auto locations = locate(s.source);
  const auto& location = locations.at(s.refs[piece].chain.front());
  Json next = editableAnimation(s);
  const std::string id = keyTarget(s, piece, location, next["tracks"]);
  if (id.empty()) return unchanged(s);
  for (auto& track : next["tracks"]) {
    if (text(track, "target") != id || text(track, "model") != location.def ||
        !track.contains("channels") || !track["channels"].is_object()) continue;
    const auto channel = track["channels"].find(kKeyChannels[index]);
    if (channel == track["channels"].end() || !channel->is_array()) return unchanged(s);
    const auto source = std::find_if(channel->begin(), channel->end(), [&](const auto& row) {
      return row.is_object() && row.value("frame", -1) == from;
    });
    if (source == channel->end()) return unchanged(s);
    auto moved = *source;
    moved["frame"] = to;
    Json lane = Json::array();
    bool inserted = false;
    for (const auto& key : *channel) {
      if (!(key.is_object() && key.contains("frame") && key["frame"].is_number_integer())) continue;
      const int when = key["frame"].get<int>();
      if (when == from || when == to) continue;
      if (!inserted && when > to) {
        lane.push_back(moved);
        inserted = true;
      }
      lane.push_back(key);
    }
    if (!inserted) lane.push_back(std::move(moved));
    *channel = std::move(lane);
    return push(s, animationEdit(s, "Move Keyframe", std::move(next)));
  }
  return unchanged(s);
}

Changed moveKeysCommand(Session::Impl& s, uint32_t piece, const KeyList& keys, int offset, bool submodel) {
  if (piece >= s.refs.size() || s.refs[piece].chain.empty() || keys.empty() || offset == 0) return unchanged(s);
  const auto range = readKeyScene(s);
  std::map<size_t, std::set<int>> selected;
  for (const auto& key : keys) {
    const auto channel = static_cast<size_t>(key.channel);
    const int64_t destination = static_cast<int64_t>(key.frame) + offset;
    if (channel >= kKeyChannels.size() || destination < range.first || destination > range.last)
      return refusal(s, "The selected keys must stay within the scene range.");
    selected[channel].insert(key.frame);
  }
  const auto locations = locate(s.source);
  const auto& location = locations.at(s.refs[piece].chain.front());
  if (submodel && !at(s.source, location).submodel) return unchanged(s);
  Json next = editableAnimation(s);
  const std::string id = keyTarget(s, piece, location, next["tracks"], submodel);
  if (id.empty()) return unchanged(s);
  for (auto& track : next["tracks"]) {
    if (text(track, "target") != id || text(track, "model") != location.def ||
        !track.contains("channels") || !track["channels"].is_object()) continue;
    auto& channels = track["channels"];
    for (const auto& [channel, frames] : selected) {
      auto lane = channels.find(kKeyChannels[channel]);
      if (lane == channels.end() || !lane->is_array()) return unchanged(s);
      std::map<int, Json> moved;
      std::map<int, Json> remaining;
      for (const auto& key : *lane) {
        if (!key.is_object() || !key.contains("frame") || !key["frame"].is_number_integer()) continue;
        const int frame = key["frame"].get<int>();
        if (frames.contains(frame)) {
          auto relocated = key;
          relocated["frame"] = frame + offset;
          moved[frame + offset] = std::move(relocated);
        } else {
          remaining[frame] = key;
        }
      }
      if (moved.size() != frames.size()) return unchanged(s);
      for (auto& [frame, key] : moved) remaining[frame] = std::move(key);
      Json replacement = Json::array();
      for (auto& [frame, key] : remaining) replacement.push_back(std::move(key));
      *lane = std::move(replacement);
    }
    return push(s, animationEdit(s, "Move Keyframes", std::move(next)));
  }
  return unchanged(s);
}

Changed editKeyRowsCommand(Session::Impl& s, const KeyRowPicks& picks, bool remove, int offset) {
  if (picks.empty() || (!remove && offset == 0)) return unchanged(s);
  const auto range = readKeyScene(s);
  const auto locations = locate(s.source);
  const auto model = focusedDef(s);
  Json next = editableAnimation(s);
  auto& tracks = next["tracks"];
  std::map<std::pair<uint32_t, bool>, std::set<int>> byObject;
  for (const auto& pick : picks) {
    if (pick.piece >= s.refs.size() || s.refs[pick.piece].chain.empty()) return unchanged(s);
    const int64_t destination = static_cast<int64_t>(pick.frame) + offset;
    if (pick.frame < range.first || pick.frame > range.last || destination < range.first || destination > range.last)
      return refusal(s, "The selected keys must stay within the scene range.");
    byObject[{pick.piece, pick.submodel}].insert(pick.frame);
  }
  std::unordered_map<std::string, std::set<int>> byTrack;
  for (const auto& [object, frames] : byObject) {
    const auto [piece, submodel] = object;
    const auto& location = locations.at(s.refs[piece].chain.front());
    if (submodel && !at(s.source, location).submodel) return unchanged(s);
    const std::string id = keyTarget(s, piece, location, tracks, submodel);
    if (id.empty() || location.def != model) return unchanged(s);
    byTrack[id].insert(frames.begin(), frames.end());
  }
  bool changed = false;
  for (auto& track : tracks) {
    if (text(track, "kind") != "object" || text(track, "model") != model) continue;
    const auto found = byTrack.find(text(track, "target"));
    if (found == byTrack.end() || !track.contains("channels") || !track["channels"].is_object()) continue;
    const auto& frames = found->second;
    std::set<int> existing;
    auto& channels = track["channels"];
    for (const auto* channel : kKeyChannels) {
      const auto lane = channels.find(channel);
      if (lane == channels.end() || !lane->is_array()) continue;
      std::map<int, Json> remaining;
      std::vector<std::pair<int, Json>> moved;
      bool touched = false;
      for (const auto& row : *lane) {
        if (!row.is_object() || !row.contains("frame") || !row["frame"].is_number_integer()) continue;
        const int frame = row["frame"].get<int>();
        if (!frames.contains(frame)) {
          remaining[frame] = row;
          continue;
        }
        touched = true;
        existing.insert(frame);
        if (!remove) {
          auto newRow = row;
          newRow["frame"] = frame + offset;
          moved.emplace_back(frame + offset, std::move(newRow));
        }
      }
      if (!touched) continue;
      for (auto& [frame, row] : moved) remaining[frame] = std::move(row);
      if (remaining.empty()) {
        channels.erase(lane);
      } else {
        Json replacement = Json::array();
        for (auto& [frame, row] : remaining) replacement.push_back(std::move(row));
        *lane = std::move(replacement);
      }
    }
    if (frames != existing) return refusal(s, "Some selected keys have changed. Select them again to edit.");
    byTrack.erase(found);
    if (channels.empty()) track = nullptr;
    changed = true;
  }
  if (!changed || !byTrack.empty()) return unchanged(s);
  tracks.erase(std::remove(tracks.begin(), tracks.end(), nullptr), tracks.end());
  return push(s, animationEdit(s, remove ? "Delete Object Keys" : "Move Object Keys", std::move(next)));
}

Changed moveToStepCommand(Session::Impl& s, const std::string& def, const std::vector<uint32_t>& pieces, size_t step, bool insert) {
  const Def* d = s.source.def(def);
  if (!d || step > d->steps.size()) return unchanged(s);
  bool partial = false;
  const auto chosen = itemsOf(s, def, pieces, true, &partial);
  if (chosen.empty()) {
    if (partial) return refusal(s, "Pieces inside a submodel move with it. Open the submodel to change its steps.");
    return unchanged(s);
  }
  Def after = *d;
  std::vector<Item> moving;
  moving.reserve(chosen.size());
  for (auto it = chosen.rbegin(); it != chosen.rend(); ++it) {
    auto& items = after.steps[it->first].items;
    moving.push_back(std::move(items[it->second]));
    items.erase(items.begin() + static_cast<long>(it->second));
  }
  std::reverse(moving.begin(), moving.end());
  if (insert || step == after.steps.size()) after.steps.insert(after.steps.begin() + static_cast<long>(step), emptyStep());
  auto& target = after.steps[step].items;
  target.insert(target.end(), std::make_move_iterator(moving.begin()), std::make_move_iterator(moving.end()));
  const std::string destination = insert ? " to New Step" : " to Step " + std::to_string(step + 1);
  return swapCommand(s, Edit::MoveToStep, named("Move", moving.size()) + destination, def, std::move(after));
}

Changed reorderInStepCommand(Session::Impl& s, const std::string& def, size_t step, size_t from, size_t to, bool pin) {
  const Def* d = s.source.def(def);
  if (!d || step >= d->steps.size()) return unchanged(s);
  const auto& items = d->steps[step].items;
  if (from >= items.size() || to >= items.size() || (from == to && !pin)) return unchanged(s);
  Def after = *d;
  auto& list = after.steps[step].items;
  Item moving = std::move(list[from]);
  list.erase(list.begin() + static_cast<long>(from));
  list.insert(list.begin() + static_cast<long>(to), std::move(moving));
  if (pin) {
    auto fields = readFields(after.steps[step]);
    fields.pinOrder = true;
    writeFields(after.steps[step], fields);
  }
  return swapCommand(s, Edit::ReorderInStep, pin ? "Set Arrival Order" : "Reorder Step", def, std::move(after));
}

Changed setArrivalPinnedCommand(Session::Impl& s, const PieceList& pieces, bool pinned) {
  const std::string def = focusedDef(s);
  const Def* d = s.source.def(def);
  if (!d) return unchanged(s);
  bool partial = false;
  const auto chosen = itemsOf(s, def, pieces, true, &partial);
  if (partial) return refusal(s, "Open the submodel to pin one of its parts.");
  if (std::none_of(chosen.begin(), chosen.end(), [&](const auto& location) {
        return arrivalPinned(d->steps[location.first].items[location.second]) != pinned;
      })) return unchanged(s);
  Def after = *d;
  for (const auto& [step, index] : chosen) setArrivalPin(after.steps[step].items[index], pinned);
  return swapCommand(s, Edit::ReorderInStep, pinned ? "Pin Arrival" : "Release Arrival", def, std::move(after));
}

PieceList Session::arrivalPins() const {
  const auto& s = *impl_;
  PieceList out;
  const Def* def = s.source.def(focusedDef(s));
  if (!def) return out;
  for (const auto& step : def->steps)
    for (const auto& item : step.items) {
      if (!arrivalPinned(item)) continue;
      const auto found = s.piecesOf.find(item.id);
      if (found == s.piecesOf.end()) continue;
      for (uint32_t p : found->second)
        if (!s.refs[p].chain.empty() && s.refs[p].chain.front() == item.id) out.push_back(p);
    }
  return out;
}

Changed moveArrivalCommand(Session::Impl& s, const PieceList& pieces, size_t step, size_t before, bool force) {
  const std::string def = focusedDef(s);
  const Def* d = s.source.def(def);
  if (!d || step >= d->steps.size() || before > d->steps[step].items.size()) return unchanged(s);
  bool partial = false;
  const auto chosen = itemsOf(s, def, pieces, true, &partial);
  if (partial) return refusal(s, "Open the submodel to move one of its parts.");
  if (chosen.empty()) return unchanged(s);
  Def after = *d;
  std::vector<Item> moving;
  moving.reserve(chosen.size());
  size_t removedBefore = 0;
  for (auto it = chosen.rbegin(); it != chosen.rend(); ++it) {
    auto& source = after.steps[it->first].items;
    moving.push_back(std::move(source[it->second]));
    source.erase(source.begin() + static_cast<long>(it->second));
    if (it->first == step && it->second < before) ++removedBefore;
  }
  std::reverse(moving.begin(), moving.end());
  if (force)
    for (Item& item : moving) setArrivalPin(item, true);
  auto& target = after.steps[step].items;
  target.insert(target.begin() + static_cast<long>(before - removedBefore),
                std::make_move_iterator(moving.begin()), std::make_move_iterator(moving.end()));
  if (chosen.front().first == step && chosen.back().first == step) {
    const auto& original = d->steps[step].items;
    if (std::equal(target.begin(), target.end(), original.begin(), [](const Item& a, const Item& b) {
          return a.id == b.id && arrivalPinned(a) == arrivalPinned(b);
        })) return unchanged(s);
  }
  return swapCommand(s, Edit::ReorderInStep, force ? "Move and Pin Arrival" : "Move Arrival", def, std::move(after));
}

Changed regenerateStepsCommand(Session::Impl& s, const PieceList& buildOrder) {
  const std::string scope = focusedDef(s);
  const Def* def = s.source.def(scope);
  if (!def || buildOrder.empty()) return unchanged(s);
  std::unordered_map<ItemId, size_t> order;
  for (size_t i = 0; i < buildOrder.size(); ++i)
    if (buildOrder[i] < s.refs.size() && !s.refs[buildOrder[i]].chain.empty())
      order.try_emplace(s.refs[buildOrder[i]].chain.front(), i);

  Def next = *def;
  next.steps.clear();
  std::vector<Item> draft;
  const auto emit = [&] {
    if (draft.empty()) return;
    const size_t absent = buildOrder.size();
    const auto rank = [&](const Item& item) {
      const auto found = order.find(item.id);
      return found == order.end() ? absent : found->second;
    };
    std::stable_sort(draft.begin(), draft.end(), [&](const Item& a, const Item& b) { return rank(a) < rank(b); });
    constexpr size_t itemsPerStep = 12;
    for (size_t i = 0; i < draft.size(); i += itemsPerStep) {
      bm::doc::Step step;
      step.extra = {{"auto", true}};
      const auto begin = draft.begin() + static_cast<std::ptrdiff_t>(i);
      const auto end = begin + static_cast<std::ptrdiff_t>(std::min(itemsPerStep, draft.size() - i));
      step.items.assign(std::make_move_iterator(begin), std::make_move_iterator(end));
      next.steps.push_back(std::move(step));
    }
    draft.clear();
  };
  for (const auto& step : def->steps) {
    Json authored = step.extra;
    if (authored.is_object()) authored.erase("auto");
    if (!authored.empty()) {
      emit();
      next.steps.push_back(step);  // preserve a named, timed, noted or pinned section as authored
    } else {
      draft.insert(draft.end(), step.items.begin(), step.items.end());
    }
  }
  emit();
  if (next.steps.empty()) next.steps.emplace_back();
  const auto same = [](const bm::doc::Step& a, const bm::doc::Step& b) {
    return a.extra == b.extra && a.items.size() == b.items.size() &&
           std::equal(a.items.begin(), a.items.end(), b.items.begin(), [](const Item& x, const Item& y) { return x.id == y.id; });
  };
  if (def->steps.size() == next.steps.size() && std::equal(def->steps.begin(), def->steps.end(), next.steps.begin(), same))
    return unchanged(s);
  return swapCommand(s, Edit::ReorderInStep, "Regenerate Build Steps", scope, std::move(next));
}

// ---- submodels -------------------------------------------------------------------------------

namespace {

/// Whole-def edits gathered for one command: working copies, then added and removed defs.
struct Draft {
  explicit Draft(Session::Impl& session) : s(session) {}
  Session::Impl& s;
  std::vector<std::string> order;
  std::map<std::string, Def> copies;
  std::vector<DefChange> later;  ///< additions and removals, after the content changes
  std::string renamedFrom, renamedTo;

  Def& edit(const std::string& name) {
    if (!copies.count(name)) {
      order.push_back(name);
      copies.emplace(name, *s.source.def(name));
    }
    return copies.at(name);
  }
  void add(const std::string& name, Def def, size_t position) { later.push_back(DefChange{name, position, std::nullopt, std::move(def)}); }
  void remove(const std::string& name) { later.push_back(DefChange{name, positionOf(s.source, name), *s.source.def(name), std::nullopt}); }
  Changed commit(Edit kind, std::string name) {
    Command c;
    c.kind = kind;
    c.name = std::move(name);
    for (const std::string& n : order) c.wholeDefs.push_back(DefChange{n, positionOf(s.source, n), *s.source.def(n), copies.at(n)});
    for (DefChange& d : later) c.wholeDefs.push_back(std::move(d));
    c.renamedFrom = renamedFrom, c.renamedTo = renamedTo;
    return push(s, std::move(c));
  }
};

/// Every def that holds `name`, at any depth, and `name` itself.
std::set<std::string> holders(const bm::doc::Source& src, const std::string& name) {
  std::set<std::string> out{name};
  for (bool grew = true; grew;) {
    grew = false;
    auto look = [&](const std::string& defName, const Def& def) {
      if (out.count(defName)) return;
      for (const auto& step : def.steps)
        for (const Item& i : step.items)
          if (i.submodel && out.count(i.name)) {
            out.insert(defName);
            grew = true;
            return;
          }
    };
    look("", src.root);
    for (const auto& [n, d] : src.submodels) look(n, d);
  }
  return out;
}

/// Does def `outer` hold `inner` (or is it `inner`)?
bool holds(const bm::doc::Source& src, const std::string& outer, const std::string& inner) { return holders(src, inner).count(outer) > 0; }

/// Grid-placed uses of these defs, or of defs holding them, made exact where they are: the grid
/// rule places a use by its submodel's box, which the edit is about to change.
void pin(Draft& d, const std::set<std::string>& defs) {
  std::set<std::string> affected;
  for (const std::string& name : defs)
    if (!name.empty())
      for (const std::string& h : holders(d.s.source, name)) affected.insert(h);
  affected.erase("");
  auto look = [&](const std::string& defName, const Def& def) {
    for (size_t si = 0; si < def.steps.size(); si++)
      for (size_t ii = 0; ii < def.steps[si].items.size(); ii++) {
        const Item& i = def.steps[si].items[ii];
        if (!i.submodel || !i.at.grid || !affected.count(i.name) || !d.s.local.count(i.id)) continue;
        Item& mine = d.edit(defName).steps[si].items[ii];
        mine.at.grid = false;
        mine.at.exact = d.s.local.at(i.id);
      }
  };
  look("", d.s.source.root);
  for (const auto& [n, def] : d.s.source.submodels) look(n, def);
}

std::string nameProblem(const Session::Impl& s, const std::string& name) {
  if (name.empty()) return "A submodel needs a name.";
  if (name.size() >= 4 && name.compare(name.size() - 4, 4, ".dat") == 0) return "A submodel's name can't end in .dat.";
  if (s.source.def(name)) return "There is already a submodel named " + name + ".";
  return "";
}

/// A plan id for a new item in `def`: `stem`, else stem-2, -3, ...
std::string freshPlanId(const Def& def, const std::string& stem) {
  const std::set<std::string> taken = planIds(def);
  if (!taken.count(stem)) return stem;
  for (int n = 2;; n++)
    if (std::string id = stem + "-" + std::to_string(n); !taken.count(id)) return id;
}

size_t usesOf(const bm::doc::Source& src, const std::string& name) {
  size_t n = 0;
  auto count = [&](const Def& def) {
    for (const auto& step : def.steps)
      for (const Item& i : step.items) n += i.submodel && i.name == name;
  };
  count(src.root);
  for (const auto& [k, d] : src.submodels) count(d);
  return n;
}

/// Where def `target`'s frame is, in `def`'s, through its first use there; none when unused.
std::optional<Xform> frameOf(const Session::Impl& s, const std::string& def, const std::string& target, int depth = 0) {
  const Def* d = s.source.def(def);
  if (!d || depth > 64) return std::nullopt;
  for (const auto& step : d->steps)
    for (const Item& i : step.items) {
      if (!i.submodel || !s.local.count(i.id)) continue;
      const Xform here = s.local.at(i.id);
      if (i.name == target) return here;
      if (const auto inner = frameOf(s, i.name, target, depth + 1)) return here * *inner;
    }
  return std::nullopt;
}

constexpr const char* kPartial = "Pieces inside a submodel move with it. Open the submodel to change its steps.";

}  // namespace

std::string freeName(const Session::Impl& s, const std::string& preferred) {
  const std::string stem = preferred.empty() ? "Submodel" : preferred;
  if (!s.source.def(stem)) return stem;
  for (int n = 2;; n++)
    if (std::string name = stem + " " + std::to_string(n); !s.source.def(name)) return name;
}

Changed importModelCommand(Session::Impl& s, const std::string& into, const bm::doc::Source& incoming,
                           const std::string& name) {
  const Def* target = s.source.def(into);
  if (!target) return refusal(s, "The destination model no longer exists.");
  if (incoming.root.steps.empty()) return refusal(s, "There are no build steps in this file.");
  Command command;
  command.kind = Edit::ImportModel;
  command.name = "Import Model";
  pinUses(s, {into}, command);
  auto normalized = bm::ldraw::normalizeName;
  std::set<std::string> usedNames{normalized(s.source.rootName)};
  std::set<std::string> usedParts, usedIds;
  auto reserve = [&](const Def& def) {
    for (const auto& step : def.steps) {
      for (const Item& item : step.items) {
        if (!item.submodel) usedParts.insert(normalized(item.name));
        if (item.extra.contains("id") && item.extra["id"].is_string())
          usedIds.insert(item.extra["id"].get<std::string>());
      }
    }
  };
  reserve(s.source.root);
  for (const auto& [n, def] : s.source.submodels) {
    usedNames.insert(normalized(n));
    reserve(def);
  }
  for (const auto& part : s.source.inlineParts) {
    usedParts.insert(part.name);
    for (const auto& line : part.cmds) if (line.type == bm::ldraw::Cmd::Ref) usedParts.insert(line.file);
  }
  auto reserveName = [&](std::string base) {
    if (base.empty()) base = "Imported Model";
    if (normalized(base).ends_with(".dat")) base += ".ldr";
    if (usedNames.insert(normalized(base)).second) return base;
    for (int i = 2;; ++i) {
      const std::string candidate = base + " " + std::to_string(i);
      if (usedNames.insert(normalized(candidate)).second) return candidate;
    }
  };
  const std::string rootName = reserveName(name);
  std::map<std::string, std::string> models, parts;
  if (!incoming.rootName.empty()) models[incoming.rootName] = rootName;
  for (const auto& [old, _] : incoming.submodels) models[old] = reserveName(old);
  for (const auto& file : incoming.inlineParts) {
    if (parts.contains(file.name)) continue;
    std::string mapped = file.name;
    for (int n = 1; usedParts.contains(mapped) || s.library->resolve(mapped); ++n)
      mapped = "bm-import-" + std::to_string(n) + "-" + std::filesystem::path(file.name).filename().string();
    usedParts.insert(mapped);
    parts.emplace(file.name, mapped);
    command.importedParts.push_back(file);
  }
  for (auto& file : command.importedParts) {
    file.name = parts.at(file.name);
    for (auto& line : file.cmds)
      if (line.type == bm::ldraw::Cmd::Ref)
        if (const auto found = parts.find(line.file); found != parts.end()) line.file = found->second;
  }

  auto freshId = [&](Item& item) {
    item.id = s.source.newId();
    std::string id = "bm-import-" + std::to_string(item.id);
    while (!usedIds.insert(id).second) id += "-1";
    if (!item.extra.is_object()) item.extra = nlohmann::ordered_json::object();
    item.extra["id"] = id;
  };
  auto clone = [&](Def def) {
    for (auto& step : def.steps) {
      for (Item& item : step.items) {
        freshId(item);
        if (item.submodel) {
          auto found = models.find(item.name);
          if (found == models.end()) found = models.emplace(item.name, reserveName(item.name)).first;
          item.name = found->second;
        } else if (auto found = parts.find(item.name); found != parts.end()) {
          item.name = found->second;
        }
      }
    }
    return def;
  };
  size_t position = s.source.submodels.size();
  command.defs.push_back({rootName, position++, clone(incoming.root)});
  for (const auto& [old, def] : incoming.submodels) command.defs.push_back({models.at(old), position++, clone(def)});
  Item instance;
  instance.submodel = true;
  instance.name = rootName;
  freshId(instance);
  Def changed = *target;
  auto step = emptyStep();
  step.extra["title"] = "Add " + rootName;
  step.items.push_back(std::move(instance));
  changed.steps.push_back(std::move(step));
  command.wholeDefs.push_back({into, positionOf(s.source, into), *target, std::move(changed)});
  return push(s, std::move(command));
}

Changed newSubmodelCommand(Session::Impl& s, const std::string& name) {
  if (std::string why = nameProblem(s, name); !why.empty()) return refusal(s, why);
  Draft d{s};
  Def def;
  def.steps.emplace_back();
  d.add(name, std::move(def), s.source.submodels.size());
  return d.commit(Edit::NewSubmodel, "New Submodel");
}

Changed makeSubmodelCommand(Session::Impl& s, const std::string& def, const std::vector<uint32_t>& pieces, const std::string& name) {
  if (std::string why = nameProblem(s, name); !why.empty()) return refusal(s, why);
  bool partial = false;
  const auto chosen = itemsOf(s, def, pieces, true, &partial);
  if (chosen.empty() && partial) return refusal(s, kPartial);
  if (chosen.size() < 2) return refusal(s, "Choose at least two pieces.");
  Draft d{s};
  Def& here = d.edit(def);
  // The anchor: the lowest corner of their boxes, down to the stud and plate grid.
  Box box;
  for (const auto& [si, ii] : chosen) {
    const Item& item = here.steps[si].items[ii];
    if (s.local.count(item.id)) box.merge((s.body.count(item.id) ? s.body.at(item.id) : Box{}).transformed(s.local.at(item.id)));
  }
  bm::Vec3 anchor;
  if (!box.empty()) anchor = {std::floor(box.min.x / kStud) * kStud, std::floor(box.min.y / kPlate) * kPlate, std::floor(box.min.z / kStud) * kStud};
  const Xform use{bm::Mat3{}, anchor}, into = use.inverse();
  Def made;
  size_t lastStep = SIZE_MAX;
  for (const auto& [si, ii] : chosen) {
    if (si != lastStep) made.steps.emplace_back(), lastStep = si;
    const Item& item = here.steps[si].items[ii];
    const Xform local = s.local.count(item.id) ? s.local.at(item.id) : item.at.exact;
    made.steps.back().items.push_back(placed(item, into * local, s.body.count(item.id) ? s.body.at(item.id) : Box{}));
  }
  const auto [firstStep, firstIndex] = chosen.front();
  for (auto it = chosen.rbegin(); it != chosen.rend(); ++it) {
    auto& items = here.steps[it->first].items;
    items.erase(items.begin() + static_cast<long>(it->second));
  }
  Item u;
  u.id = s.source.newId();
  u.submodel = true;
  u.name = name;
  u.at.exact = use;
  u.extra = nlohmann::ordered_json::object();
  u.extra["id"] = freshPlanId(here, name);
  auto& target = here.steps[firstStep].items;
  target.insert(target.begin() + static_cast<long>(std::min(firstIndex, target.size())), std::move(u));
  keepRefsInside(here);
  keepRefsInside(made);
  d.add(name, std::move(made), s.source.submodels.size());
  return d.commit(Edit::MakeSubmodel, "Make Submodel");
}

Changed extractCommand(Session::Impl& s, const std::string& def, uint32_t piece) {
  if (piece >= s.refs.size()) return unchanged(s);
  const auto where = locate(s.source);
  const auto& chain = s.refs[piece].chain;
  size_t level = chain.size();
  for (size_t k = 0; k < chain.size(); k++)
    if (const auto f = where.find(chain[k]); f != where.end() && f->second.def == def) {
      level = k;
      break;
    }
  if (level + 1 >= chain.size()) return refusal(s, "This piece is not inside a submodel.");
  const Loc loc = where.at(chain[level]);
  Draft d{s};
  Def& here = d.edit(def);
  const Item use = here.steps[loc.step].items[loc.index];
  const Xform frame = s.local.at(use.id);
  std::vector<Item> copies;
  for (const auto& step : s.source.def(use.name)->steps)
    for (const Item& item : step.items) {
      const Xform local = s.local.count(item.id) ? s.local.at(item.id) : item.at.exact;
      Item copy = placed(item, frame * local, s.body.count(item.id) ? s.body.at(item.id) : Box{});
      copy.id = s.source.newId();
      copies.push_back(std::move(copy));
    }
  auto& items = here.steps[loc.step].items;
  items.erase(items.begin() + static_cast<long>(loc.index));
  repairIds(copies, planIds(here));
  items.insert(items.begin() + static_cast<long>(loc.index), copies.begin(), copies.end());
  keepRefsInside(here);
  return d.commit(Edit::Extract, "Extract " + use.name);
}

Changed moveToModelCommand(Session::Impl& s, const std::string& def, const std::vector<uint32_t>& pieces, const std::string& target) {
  if (target == def) return unchanged(s);
  if (target.empty() || !s.source.def(target)) return refusal(s, "There is no submodel named " + target + ".");
  const std::optional<Xform> frame = frameOf(s, def, target);
  if (!frame) return refusal(s, target + " is not used in this model.");
  bool partial = false;
  const auto chosen = itemsOf(s, def, pieces, true, &partial);
  if (chosen.empty()) return partial ? refusal(s, kPartial) : unchanged(s);
  const Def& source = *s.source.def(def);
  std::set<std::string> moving;
  for (const auto& [si, ii] : chosen) {
    const Item& item = source.steps[si].items[ii];
    if (item.submodel && holds(s.source, item.name, target)) return refusal(s, "A submodel can't hold itself.");
    if (item.extra.is_object() && item.extra.contains("id") && item.extra["id"].is_string()) moving.insert(item.extra["id"].get<std::string>());
  }
  const std::set<std::pair<size_t, size_t>> chosenSet(chosen.begin(), chosen.end());
  for (const auto& at : referencing(source, moving))
    if (!chosenSet.count(at)) return refusal(s, source.steps[at.first].items[at.second].name + " depends on a piece being moved.");
  Draft d{s};
  pin(d, {def, target});
  Def& here = d.edit(def);
  const Xform into = frame->inverse();
  std::vector<Item> items;
  for (const auto& [si, ii] : chosen) {
    const Item& item = here.steps[si].items[ii];
    const Xform local = s.local.count(item.id) ? s.local.at(item.id) : item.at.exact;
    items.push_back(placed(item, into * local, s.body.count(item.id) ? s.body.at(item.id) : Box{}));
  }
  for (auto it = chosen.rbegin(); it != chosen.rend(); ++it) {
    auto& list = here.steps[it->first].items;
    list.erase(list.begin() + static_cast<long>(it->second));
  }
  Def& there = d.edit(target);
  if (there.steps.empty()) there.steps.emplace_back();
  repairIds(items, planIds(there));
  auto& last = there.steps.back().items;
  last.insert(last.end(), items.begin(), items.end());
  keepRefsInside(here);
  keepRefsInside(there);
  return d.commit(Edit::MoveToModel, named("Move", items.size()) + " to " + target);
}

Changed renameSubmodelCommand(Session::Impl& s, const std::string& from, const std::string& to) {
  if (from.empty() || !s.source.def(from)) return unchanged(s);
  if (from == to) return unchanged(s);
  if (std::string why = nameProblem(s, to); !why.empty()) return refusal(s, why);
  Draft d{s};
  auto rename = [&](const std::string& defName, const Def& def) {
    for (size_t si = 0; si < def.steps.size(); si++)
      for (size_t ii = 0; ii < def.steps[si].items.size(); ii++)
        if (def.steps[si].items[ii].submodel && def.steps[si].items[ii].name == from) d.edit(defName).steps[si].items[ii].name = to;
  };
  rename("", s.source.root);
  for (const auto& [n, def] : s.source.submodels) rename(n, def);
  const size_t position = positionOf(s.source, from);
  d.remove(from);
  d.add(to, *s.source.def(from), position);
  d.renamedFrom = from, d.renamedTo = to;
  return d.commit(Edit::RenameSubmodel, "Rename " + from);
}

Changed deleteSubmodelCommand(Session::Impl& s, const std::string& name) {
  if (name.empty() || !s.source.def(name)) return unchanged(s);
  if (const size_t n = usesOf(s.source, name); n > 0)
    return refusal(s, name + " is used " + (n == 1 ? std::string("once") : std::to_string(n) + " times") + ". Remove its uses first.");
  Draft d{s};
  d.remove(name);
  return d.commit(Edit::DeleteSubmodel, "Delete " + name);
}

Changed undoCommand(Session::Impl& s) {
  History& h = s.history;
  if (h.cursor == 0) return unchanged(s);
  Command& c = h.done[--h.cursor];
  c.open = false;
  apply(s, c, false);
  return finish(s, c);
}

Changed redoCommand(Session::Impl& s) {
  History& h = s.history;
  if (h.cursor == h.done.size()) return unchanged(s);
  Command& c = h.done[h.cursor++];
  apply(s, c, true);
  return finish(s, c);
}

}  // namespace bmapp
