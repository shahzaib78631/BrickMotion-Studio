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
    if (c.addedRootStep) src.root.steps.emplace_back();
    for (auto it = removed.rbegin(); it != removed.rend(); ++it) erase(**it);
    for (const ItemEdit* e : changed) replace(*e->before, *e->after);
    for (const ItemEdit* e : inserted) insert(*e, *e->after);
  } else {
    for (auto it = inserted.rbegin(); it != inserted.rend(); ++it) erase(**it);
    for (const ItemEdit* e : changed) replace(*e->after, *e->before);
    for (const ItemEdit* e : removed) insert(*e, *e->before);
    if (c.addedRootStep) src.root.steps.pop_back();
    for (auto it = c.defs.rbegin(); it != c.defs.rend(); ++it)
      std::erase_if(src.submodels, [&](const auto& sub) { return sub.first == it->name; });
  }
}

bool structural(const Command& c) {
  if (c.kind != Edit::Move && c.kind != Edit::Rotate && c.kind != Edit::Recolor) return true;
  if (!c.defs.empty() || c.addedRootStep) return true;
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
  if (structural(c)) {
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
  if (targets.empty()) return Changed{false, {}, {}, s.version};
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

void reflatten(Session::Impl& s) {
  bm::doc::Flat flat = bm::doc::flatten(s.source, *s.library, *s.full);
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
  if (targets.empty()) return Changed{false, {}, {}, s.version};
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
  if (targets.empty()) return Changed{false, {}, {}, s.version};
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
  if (targets.empty()) return Changed{false, {}, {}, s.version};
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

Changed pasteCommand(Session::Impl& s, const std::string& text, bm::Vec3 offset) {
  const bm::ldraw::File file = bm::ldraw::parse(text, "clipboard.ldr");
  Command c;
  c.kind = Edit::Paste;
  if (s.source.root.steps.empty()) c.addedRootStep = true;
  const size_t step = c.addedRootStep ? 0 : s.source.root.steps.size() - 1;
  size_t index = c.addedRootStep ? 0 : s.source.root.steps[step].items.size();
  for (const bm::ldraw::Command& cmd : file.cmds) {
    if (cmd.type != bm::ldraw::Cmd::Ref) continue;
    Item item;
    item.id = s.source.newId();
    item.name = cmd.file;
    item.colorText = std::to_string(cmd.color);
    item.color = planColor(s, cmd.color);
    item.at.exact = Xform{bm::Mat3{}, offset} * cmd.xf;
    c.items.push_back(edit("", step, index++, std::nullopt, item));
  }
  if (c.items.empty()) return Changed{false, {}, {}, s.version};
  c.name = named("Paste", c.items.size());
  return push(s, std::move(c));
}

Changed replaceCommand(Session::Impl& s, const std::vector<uint32_t>& pieces, const std::string& part) {
  std::string name = bm::ldraw::normalizeName(part);
  if (name.empty()) return Changed{false, {}, {}, s.version};
  if (name.find('.') == std::string::npos) name += ".dat";
  const std::vector<Target> targets = resolve(s, pieces, true);
  if (targets.empty()) return Changed{false, {}, {}, s.version};
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
  if (piece >= s.refs.size() || s.refs[piece].chain.size() < 2) return Changed{false, {}, {}, s.version};
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

Changed undoCommand(Session::Impl& s) {
  History& h = s.history;
  if (h.cursor == 0) return Changed{false, {}, {}, s.version};
  Command& c = h.done[--h.cursor];
  c.open = false;
  apply(s, c, false);
  return finish(s, c);
}

Changed redoCommand(Session::Impl& s) {
  History& h = s.history;
  if (h.cursor == h.done.size()) return Changed{false, {}, {}, s.version};
  Command& c = h.done[h.cursor++];
  apply(s, c, true);
  return finish(s, c);
}

}  // namespace bmapp
