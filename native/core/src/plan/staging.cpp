#include "bm/plan/staging.h"

#include <algorithm>
#include <cmath>
#include <numeric>

namespace bm::plan::staging {
namespace {

/// JavaScript's Math.round: halves go up.
double jsRound(double v) { return std::floor(v + 0.5); }

bool composed(Style s) { return s == Style::Showcase || s == Style::Gallery || s == Style::Fan || s == Style::CameraFrame; }

}  // namespace

double styleArea(Style s) {
  switch (s) {
    case Style::Packed: return 1;
    case Style::Spaced: return 2.2;
    case Style::Grid: return 2.3;
    case Style::Rows: return 1.7;
    case Style::Scattered: return 2.5;
    case Style::Showcase: return 2.7;
    case Style::Gallery: return 2.9;
    case Style::Fan: return 3.4;
    case Style::CameraFrame: return 3.1;
  }
  return 1;
}

bool parse(const std::string& n, Style& out) {
  static const std::pair<const char*, Style> names[] = {{"packed", Style::Packed}, {"spaced", Style::Spaced}, {"grid", Style::Grid}, {"rows", Style::Rows}, {"scattered", Style::Scattered},
                                                        {"showcase", Style::Showcase}, {"gallery", Style::Gallery}, {"fan", Style::Fan}, {"camera-frame", Style::CameraFrame}};
  for (const auto& [k, v] : names)
    if (n == k) return out = v, true;
  return false;
}
bool parse(const std::string& n, Sort& out) {
  static const std::pair<const char*, Sort> names[] = {{"step", Sort::Step}, {"colour", Sort::Colour}, {"part", Sort::Part}, {"size", Sort::Size}, {"all", Sort::All}};
  for (const auto& [k, v] : names)
    if (n == k) return out = v, true;
  return false;
}
bool parse(const std::string& n, Sides& out) {
  static const std::pair<const char*, Sides> names[] = {{"front-back", Sides::FrontBack}, {"front", Sides::Front}, {"behind", Sides::Behind}, {"sides", Sides::Sides}, {"around", Sides::Around}};
  for (const auto& [k, v] : names)
    if (n == k) return out = v, true;
  return false;
}
bool parse(const std::string& n, Match& out) {
  if (n == "fill") return out = Match::Fill, true;
  if (n == "nearest") return out = Match::Nearest, true;
  return false;
}

double hash01(const std::string& id, uint32_t salt) {
  uint32_t h = 0x811c9dc5u ^ salt;
  for (unsigned char c : id) h = (h ^ c) * 0x01000193u;
  h ^= h >> 15;
  h *= 0x2c1b3c6du;
  h ^= h >> 12;
  return h / 4294967296.0;
}

Layout layoutFloor(const std::vector<Item>& items, const Region& region, double gap, Style style, double aspect) {
  std::vector<size_t> order(items.size());
  std::iota(order.begin(), order.end(), size_t{0});
  std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) {
    const Item &x = items[a], &y = items[b];
    if (x.group != y.group) return x.group < y.group;
    if (x.d != y.d) return x.d > y.d;
    return x.w * x.d > y.w * y.d;
  });
  const bool comp = composed(style);
  const double g = style == Style::Spaced || style == Style::Scattered || comp ? std::max(gap, 3.0) : style == Style::Rows ? std::max(gap, 2.0) : gap;
  double cell = 0;
  if (style == Style::Grid && !order.empty()) {
    std::vector<int> sizes;
    for (size_t i : order) sizes.push_back(std::max(items[i].w, items[i].d));
    std::sort(sizes.begin(), sizes.end());
    cell = std::max(2, sizes[std::min(sizes.size() - 1, static_cast<size_t>(std::floor(sizes.size() * 0.75)))]);
  }
  struct Slot {
    double w, d, ox, oz;
  };
  auto slot = [&](const Item& it) -> Slot {
    if (!(cell > 0)) return {static_cast<double>(it.w), static_cast<double>(it.d), 0, 0};
    const double cw = std::ceil(it.w / cell), cd = std::ceil(it.d / cell);
    const double w = cw * cell + (cw - 1) * g, d = cd * cell + (cd - 1) * g;
    return {w, d, std::floor((w - it.w) / 2), std::floor((d - it.d) / 2)};
  };
  Layout out;
  double footprint = 0, widest = 0;
  for (size_t i : order) footprint += (items[i].w + g) * (items[i].d + g), widest = std::max(widest, static_cast<double>(items[i].w));
  const double targetWidth = style == Style::CameraFrame ? std::max(widest, std::min(region.width, std::sqrt(footprint * std::max(0.3, std::min(3.0, aspect))))) : region.width;
  const double xEnd = region.x0 + targetWidth, zEnd = region.z0 + region.depth;
  double x = region.x0, z = region.z0, rowDepth = 0;
  bool hasLast = false;
  double lastGroup = 0;
  std::vector<size_t> row;
  const double rowStart = region.x0;
  auto finishRow = [&] {
    if (!comp || row.empty()) return;
    const double occupied = x - g - rowStart;
    const double offset = std::max(0.0, (region.width - occupied) / 2);
    const double mid = rowStart + occupied / 2;
    for (size_t i : row) {
      Spot& p = out.pos[items[i].id];
      const double distance = std::abs(p.x + items[i].w / 2.0 - mid) / std::max(1.0, occupied / 2);
      p.x += offset;
      if (style == Style::Fan) p.z += jsRound(distance * 2) / 2;  // outer pieces recede: an arc facing the camera
    }
    row.clear();
  };
  for (size_t i : order) {
    const Item& it = items[i];
    if (!out.overflow.empty()) {
      out.overflow.push_back(it.id);
      continue;
    }
    const Slot s = slot(it);
    const bool newGroupRow = (style == Style::Rows || style == Style::Gallery) && hasLast && it.group != lastGroup;
    if (x > region.x0 && (x + s.w > xEnd || newGroupRow)) {
      finishRow();
      z += rowDepth + g;
      x = region.x0;
      rowDepth = 0;
    }
    const bool first = out.pos.empty();
    if (!first && z + s.d + (style == Style::Fan ? 2 : 0) > zEnd) {
      out.overflow.push_back(it.id);
      continue;
    }
    double jx = 0, jz = 0;
    if (style == Style::Scattered) {  // inside the gap, so neighbours never touch
      jx = jsRound((hash01(it.key, 1) - 0.5) * 2 * 2) / 2;
      jz = jsRound((hash01(it.key, 2) - 0.5) * 2 * 2) / 2;
    }
    out.pos[it.id] = {x + s.ox + jx, z + s.oz + jz};
    x += s.w + g;
    row.push_back(i);
    rowDepth = std::max(rowDepth, s.d + (style == Style::Fan ? 2 : 0));
    lastGroup = it.group, hasLast = true;
  }
  finishRow();
  return out;
}

std::vector<Region> bandsAround(const Footprint& box, double padArea, Sides sides) {
  const double bx0 = std::floor(box.minX / kStud), bx1 = std::ceil(box.maxX / kStud);
  const double bz0 = std::floor(box.minZ / kStud), bz1 = std::ceil(box.maxZ / kStud);
  const double W = std::max(1.0, bx1 - bx0), D = std::max(1.0, bz1 - bz0);
  const double width = std::max(W + 2 * kFloorMargin, 12.0);
  const double depth = std::max(6.0, std::min(std::max(6.0, std::ceil(0.9 * std::max(W, D))), std::max(std::ceil((1.05 * W * D) / width), std::ceil((0.33 * padArea) / width))));
  const double x0 = std::floor((bx0 + bx1) / 2 - width / 2);
  if (sides == Sides::Front) return {{x0, bz0 - kFloorMargin - 2 * depth, width, 2 * depth, 1}};
  if (sides == Sides::Behind) return {{x0, bz1 + kFloorMargin, width, 2 * depth, -1}};
  if (sides == Sides::Sides) {
    const double longSide = std::max(D + 2 * kFloorMargin, 12.0);
    const double wide = std::max(4.0, std::ceil((width * depth) / longSide));
    const double z0 = std::floor((bz0 + bz1) / 2 - longSide / 2);
    return {{bx0 - kFloorMargin - wide, z0, wide, longSide, 0}, {bx1 + kFloorMargin, z0, wide, longSide, 0}};
  }
  if (sides == Sides::Around) {
    const double fb = std::max(4.0, std::ceil(depth * 0.6));
    const double longSide = std::max(D + 2 * kFloorMargin, 8.0);
    const double wide = std::max(4.0, std::ceil((width * depth * 0.8) / longSide));
    const double z0 = bz0 - kFloorMargin;
    return {{x0, bz0 - kFloorMargin - fb, width, fb, 1},
            {x0, bz1 + kFloorMargin, width, fb, -1},
            {std::min(x0, bx0 - kFloorMargin) - wide, z0, wide, longSide, 0},
            {std::max(x0 + width, bx1 + kFloorMargin), z0, wide, longSide, 0}};
  }
  return {{x0, bz0 - kFloorMargin - depth, width, depth, 1}, {x0, bz1 + kFloorMargin, width, depth, -1}};
}

std::vector<Region> cameraFrameBands(const Footprint& box, double padArea, Sides sides, double aspect) {
  const double bx0 = std::floor(box.minX / kStud), bx1 = std::ceil(box.maxX / kStud);
  const double bz0 = std::floor(box.minZ / kStud), bz1 = std::ceil(box.maxZ / kStud);
  const double W = std::max(1.0, bx1 - bx0), D = std::max(1.0, bz1 - bz0);
  const double clear = kFloorMargin + 1;
  const double ratio = std::max(0.4, std::min(2.5, std::isfinite(aspect) ? aspect : 1.0));
  const double minW = W + 2 * clear + 8, minD = D + 2 * clear + 8;
  const double area = std::max(padArea * 1.1, minW * minD);
  const double outerW = std::max(minW, std::ceil(std::sqrt(area * ratio)));
  const double outerD = std::max(minD, std::ceil(area / outerW));
  const double x0 = std::floor((bx0 + bx1) / 2 - outerW / 2);
  const double frontD = std::max(4.0, std::floor((outerD - D - 2 * clear) / 2));
  const double backD = std::max(4.0, outerD - D - 2 * clear - frontD);
  const double sideW = std::max(4.0, std::floor((outerW - W - 2 * clear) / 2));
  const Region left{bx0 - clear - sideW, bz0 - clear, sideW, D + 2 * clear, 0}, right{bx1 + clear, bz0 - clear, sideW, D + 2 * clear, 0};
  const Region front{x0, bz0 - clear - frontD, outerW, frontD, 1}, behind{x0, bz1 + clear, outerW, backD, -1};
  if (sides == Sides::Front) return {{front.x0, front.z0 - backD, front.width, frontD + backD, 1}};
  if (sides == Sides::Behind) return {{behind.x0, behind.z0, behind.width, backD + frontD, -1}};
  if (sides == Sides::Sides) return {left, right};
  if (sides == Sides::Around) return {front, behind, left, right};
  return {front, behind};
}

namespace {

/// Packs one band, its used rows pushed against the model. Returns what overflowed.
std::vector<uint32_t> layoutBand(const std::vector<Item>& items, const Region& band, Style style, double aspect, Positions& pos) {
  const Layout r = layoutFloor(items, band, 1, style == Style::CameraFrame ? Style::Showcase : style, aspect);
  std::unordered_map<uint32_t, int> depthOf;
  for (const Item& it : items) depthOf[it.id] = it.d;
  double used = 0;
  for (const auto& [k, p] : r.pos) used = std::max(used, p.z + depthOf[k] - band.z0);
  for (const auto& [k, p] : r.pos) {
    const double d = depthOf[k];
    pos[k] = {p.x, band.near > 0 ? p.z + std::max(0.0, band.depth - used) : band.near < 0 ? band.z0 + used - (p.z - band.z0) - d : p.z};
  }
  return r.overflow;
}

}  // namespace

Layout layoutBands(const std::vector<Item>& items, const std::vector<Region>& bands, Style style, const std::unordered_map<uint32_t, std::vector<int>>* prefer, double aspect) {
  Layout out;
  if (bands.empty()) {
    for (const Item& it : items) out.overflow.push_back(it.id);
    return out;
  }
  if (style == Style::CameraFrame && !prefer && bands.size() > 1) {
    // Pieces on both sides of the build, by each bay's capacity.
    std::vector<std::vector<Item>> queues(bands.size());
    std::vector<double> loads(bands.size(), 0), capacity(bands.size());
    for (size_t i = 0; i < bands.size(); i++) capacity[i] = std::max(1.0, bands[i].width * bands[i].depth);
    std::vector<uint32_t> missing;
    for (const Item& it : items) {
      int best = -1;
      double score = std::numeric_limits<double>::infinity();
      for (size_t i = 0; i < bands.size(); i++) {
        if (it.w > bands[i].width || it.d > bands[i].depth) continue;
        const double demand = loads[i] / capacity[i];
        if (demand < score) score = demand, best = static_cast<int>(i);
      }
      if (best < 0) {
        missing.push_back(it.id);
        continue;
      }
      queues[static_cast<size_t>(best)].push_back(it);
      loads[static_cast<size_t>(best)] += (it.w + 3) * (it.d + 3);
    }
    for (size_t i = 0; i < bands.size(); i++) {
      const std::vector<uint32_t> left = layoutBand(queues[i], bands[i], style, aspect, out.pos);
      missing.insert(missing.end(), left.begin(), left.end());
    }
    for (uint32_t id : missing) out.pos.erase(id);
    out.overflow = std::move(missing);
    return out;
  }
  if (!prefer || bands.size() < 2) {
    std::vector<Item> rest = items;
    for (const Region& band : bands) {
      if (rest.empty()) break;
      const std::vector<uint32_t> leftList = layoutBand(rest, band, style, aspect, out.pos);
      std::unordered_map<uint32_t, int> left;
      for (uint32_t id : leftList) left[id] = 1;
      std::vector<Item> next;
      for (const Item& it : rest)
        if (left.count(it.id)) next.push_back(it);
      rest = std::move(next);
    }
    for (const Item& it : rest) out.overflow.push_back(it.id);
    return out;
  }
  // choice: how far down its preference list each piece has spilled
  std::unordered_map<uint32_t, size_t> choice;
  for (const Item& it : items) choice[it.id] = 0;
  auto bandOf = [&](uint32_t id) -> int {
    const size_t c = choice[id];
    const auto found = prefer->find(id);
    return found != prefer->end() && c < found->second.size() ? found->second[c] : static_cast<int>(c);
  };
  std::vector<uint32_t> overflow;
  for (size_t round = 0; round < bands.size(); round++) {
    out.pos.clear();
    overflow.clear();
    std::vector<uint32_t> spilled;
    for (size_t b = 0; b < bands.size(); b++) {
      std::vector<Item> mine;
      for (const Item& it : items)
        if (choice[it.id] < bands.size() && bandOf(it.id) == static_cast<int>(b)) mine.push_back(it);
      if (!mine.empty()) {
        const std::vector<uint32_t> left = layoutBand(mine, bands[b], style, aspect, out.pos);
        spilled.insert(spilled.end(), left.begin(), left.end());
      }
    }
    if (spilled.empty()) break;
    for (uint32_t id : spilled) {
      choice[id]++;
      if (choice[id] >= bands.size()) overflow.push_back(id);
    }
    if (round == bands.size() - 1)
      for (uint32_t id : spilled)
        if (std::find(overflow.begin(), overflow.end(), id) == overflow.end()) overflow.push_back(id);
  }
  for (uint32_t id : overflow) out.pos.erase(id);
  out.overflow = std::move(overflow);
  return out;
}

std::unordered_map<uint32_t, std::vector<int>> bandPreference(const std::vector<std::pair<uint32_t, Spot>>& at, const std::vector<Region>& bands) {
  std::unordered_map<uint32_t, std::vector<int>> out;
  if (bands.empty()) return out;
  std::vector<Spot> centres;
  double bx = 0, bz = 0, mx = 0, mz = 0;
  for (const Region& r : bands) centres.push_back({r.x0 + r.width / 2, r.z0 + r.depth / 2}), bx += centres.back().x, bz += centres.back().z;
  bx /= centres.size(), bz /= centres.size();
  for (const auto& [id, p] : at) mx += p.x, mz += p.z;
  mx /= std::max<size_t>(1, at.size()), mz /= std::max<size_t>(1, at.size());
  for (const auto& [id, p] : at) {
    const double dx = p.x - mx, dz = p.z - mz;
    std::vector<double> score;
    for (const Spot& c : centres) {
      const double ux = c.x - bx, uz = c.z - bz;
      const double len = std::hypot(ux, uz) > 0 ? std::hypot(ux, uz) : 1;
      score.push_back((dx * ux + dz * uz) / len);
    }
    std::vector<int> order(bands.size());
    std::iota(order.begin(), order.end(), 0);
    std::stable_sort(order.begin(), order.end(), [&](int a, int b) { return score[static_cast<size_t>(a)] > score[static_cast<size_t>(b)]; });
    out[id] = std::move(order);
  }
  return out;
}

std::vector<Region> growBands(const std::vector<Region>& bands, const Footprint& box, double by, bool cameraFrame) {
  const double cz = (box.minZ + box.maxZ) / 2 / kStud, cx = (box.minX + box.maxX) / 2 / kStud;
  std::vector<Region> out;
  for (Region r : bands) {
    const double rz = r.z0 + r.depth / 2;
    if (r.near != 0) {
      const double extra = std::ceil(r.depth * (by - 1));
      if (rz < cz) r.z0 -= extra;
      r.depth += extra;
    } else if (cameraFrame) {
      const double extra = std::max(2.0, std::ceil(r.width * (by - 1)));
      if (r.x0 + r.width / 2 < cx) r.x0 -= extra;
      r.width += extra;
    } else {
      const double extra = std::ceil(r.depth * (by - 1));
      r.z0 -= std::ceil(extra / 2);
      r.depth += extra;
    }
    out.push_back(r);
  }
  return out;
}

std::vector<Window> windowed(const std::vector<Item>& items, const std::vector<Region>& bands, Style style, const std::unordered_map<uint32_t, std::vector<int>>* prefer, double aspect) {
  std::vector<Window> windows;
  size_t i = 0;
  while (i < items.size()) {
    size_t lo = 1, hi = items.size() - i;
    auto slice = [&](size_t count) { return std::vector<Item>(items.begin() + static_cast<std::ptrdiff_t>(i), items.begin() + static_cast<std::ptrdiff_t>(i + count)); };
    while (lo < hi) {
      const size_t mid = (lo + hi + 1) / 2;
      if (layoutBands(slice(mid), bands, style, prefer, aspect).overflow.empty()) lo = mid;
      else hi = mid - 1;
    }
    Window w;
    w.pos = layoutBands(slice(lo), bands, style, prefer, aspect).pos;
    for (size_t k = i; k < i + lo; k++) w.ids.push_back(items[k].id);
    windows.push_back(std::move(w));
    i += lo;
  }
  return windows;
}

}  // namespace bm::plan::staging
