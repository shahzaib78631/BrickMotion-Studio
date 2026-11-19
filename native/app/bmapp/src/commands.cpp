#include "commands.h"

#include <algorithm>
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
    for (const DefEdit& d : c.defs) src.submodels.insert(src.submodels.begin() + static_cast<long>(d.position), {d.name, d.def});
    if (c.addedRootStep) src.def(c.stepDef)->steps.emplace_back();
    for (auto it = removed.rbegin(); it != removed.rend(); ++it) erase(**it);
    for (const ItemEdit* e : changed) replace(*e->before, *e->after);
    for (const ItemEdit* e : inserted) insert(*e, *e->after);
    for (const DefChange& d : c.wholeDefs) swapDef(src, d.name, d.position, d.before, d.after);
  } else {
    for (auto it = c.wholeDefs.rbegin(); it != c.wholeDefs.rend(); ++it) swapDef(src, it->name, it->position, it->after, it->before);
    for (auto it = inserted.rbegin(); it != inserted.rend(); ++it) erase(**it);
    for (const ItemEdit* e : changed) replace(*e->after, *e->before);
    for (const ItemEdit* e : removed) insert(*e, *e->before);
    if (c.addedRootStep) src.def(c.stepDef)->steps.pop_back();
    for (auto it = c.defs.rbegin(); it != c.defs.rend(); ++it)
      std::erase_if(src.submodels, [&](const auto& sub) { return sub.first == it->name; });
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
  if (c.kind != Edit::Move && c.kind != Edit::Rotate && c.kind != Edit::Recolor) return true;
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
  if (trimFocus(s) || structural(c)) {
    reflatten(s);
    out.structure = true;
  } else {
    std::vector<ItemId> ids;
    for (const ItemEdit& e : c.items) ids.push_back(e.after ? e.after->id : e.before->id);
    out = inPlace(s, ids);
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
  auto pin = [&](const std::string& defName, const Def& def) {
    for (size_t si = 0; si < def.steps.size(); si++)
      for (size_t ii = 0; ii < def.steps[si].items.size(); ii++) {
        const Item& i = def.steps[si].items[ii];
        if (!i.submodel || !i.at.grid || !affected.count(i.name) || !s.local.count(i.id)) continue;
        Item after = i;
        after.at.grid = false;
        after.at.exact = s.local.at(i.id);
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

/// The longest start of `path` in which each def is used by the one before (the root first).
std::vector<std::string> leading(const bm::doc::Source& src, const std::vector<std::string>& path) {
  std::vector<std::string> out;
  std::string outer;
  for (const std::string& name : path) {
    if (name.empty() || !src.def(name) || !usesDirectly(src, outer, name)) break;
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

void writeFields(bm::doc::Step& step, const StepFields& f) {
  setText(step.extra, "title", f.title);
  setText(step.extra, "notes", f.notes);
  if (f.pauseAfter > 0) step.extra["pauseAfter"] = f.pauseAfter;
  else step.extra.erase("pauseAfter");
  if (f.pinOrder) step.extra["pinOrder"] = true;
  else step.extra.erase("pinOrder");
  // A pinned step's pieces carry the web's per-piece force flag (assembly.root).
  for (Item& item : step.items) {
    if (!item.extra.is_object()) item.extra = Json::object();
    if (f.pinOrder) {
      item.extra["assembly"]["root"] = true;
    } else if (item.extra.contains("assembly") && item.extra["assembly"].is_object()) {
      item.extra["assembly"].erase("root");
      if (item.extra["assembly"].empty()) item.extra.erase("assembly");
    }
  }
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

Changed splitStepCommand(Session::Impl& s, const std::string& def, size_t at, const std::vector<uint32_t>& pieces) {
  const Def* d = s.source.def(def);
  if (!d || at >= d->steps.size()) return unchanged(s);
  std::set<size_t> chosen;
  for (const auto& [step, index] : itemsOf(s, def, pieces, false))
    if (step == at) chosen.insert(index);
  if (chosen.empty()) return refusal(s, "Choose some of the step's pieces to split off.");
  if (chosen.size() == d->steps[at].items.size()) return refusal(s, "Choose some of the step's pieces, not all of them.");
  Def after = *d;
  bm::doc::Step rest, split;
  rest.extra = after.steps[at].extra;
  for (size_t i = 0; i < after.steps[at].items.size(); i++) (chosen.count(i) ? split : rest).items.push_back(after.steps[at].items[i]);
  after.steps[at] = std::move(rest);
  after.steps.insert(after.steps.begin() + static_cast<long>(at + 1), std::move(split));
  return swapCommand(s, Edit::SplitStep, "Split Step", def, std::move(after));
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

Changed moveToStepCommand(Session::Impl& s, const std::string& def, const std::vector<uint32_t>& pieces, size_t step) {
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
  for (auto it = chosen.rbegin(); it != chosen.rend(); ++it) {
    auto& items = after.steps[it->first].items;
    moving.insert(moving.begin(), items[it->second]);
    items.erase(items.begin() + static_cast<long>(it->second));
  }
  if (step == after.steps.size()) after.steps.push_back(emptyStep());
  auto& target = after.steps[step].items;
  target.insert(target.end(), moving.begin(), moving.end());
  return swapCommand(s, Edit::MoveToStep, named("Move", moving.size()) + " to Step " + std::to_string(step + 1), def, std::move(after));
}

Changed reorderInStepCommand(Session::Impl& s, const std::string& def, size_t step, size_t from, size_t to) {
  const Def* d = s.source.def(def);
  if (!d || step >= d->steps.size()) return unchanged(s);
  const auto& items = d->steps[step].items;
  if (from >= items.size() || to >= items.size() || from == to) return unchanged(s);
  Def after = *d;
  auto& list = after.steps[step].items;
  Item moving = std::move(list[from]);
  list.erase(list.begin() + static_cast<long>(from));
  list.insert(list.begin() + static_cast<long>(to), std::move(moving));
  return swapCommand(s, Edit::ReorderInStep, "Reorder Step", def, std::move(after));
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
