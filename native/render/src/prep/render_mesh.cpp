#include "bmr/render_mesh.h"

#include <cmath>
#include <map>
#include <mutex>
#include "bmr/tolerances.h"

namespace bmr {
namespace {

using bm::Vec3;

struct Corner {
  Vec3 sum;        // normals of the triangles gathered here, each weighted by its angle at this corner
  uint32_t color;
  uint32_t index;  // in the output
};

}  // namespace

RenderMesh buildRenderMesh(const bm::ldraw::Mesh& mesh, const std::unordered_map<int, bm::ldraw::Color>& colors) {
  RenderMesh out;
  out.lowError = mesh.lowError;
  const size_t vertexCount = mesh.positions.size() / 3;
  auto point = [&](uint32_t i) { return Vec3{mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]}; };
  auto colorOf = [&](size_t triangle) -> uint32_t {
    const int code = triangle < mesh.triColor.size() ? mesh.triColor[triangle] : 16;
    if (code == 16 || code == 24) return 0;
    const auto it = colors.find(code);
    return it == colors.end() ? kUnknownColor : (0xFF000000u | (it->second.rgb & 0xFFFFFFu));
  };
  const double agree = std::cos(kCreaseDegrees * 3.14159265358979323846 / 180.0);

  // The triangles worth keeping, each with its unit normal.
  struct Tri {
    uint32_t v[3];
    Vec3 normal;
    uint32_t color;
  };
  std::vector<Tri> tris;
  const size_t firstUnder = mesh.triangles.size() / 3 - std::min<size_t>(mesh.underside, mesh.triangles.size() / 3);
  size_t top = 0;  // triangles kept before the underside
  for (size_t t = 0; t * 3 + 2 < mesh.triangles.size(); t++) {
    const uint32_t i = mesh.triangles[t * 3], j = mesh.triangles[t * 3 + 1], k = mesh.triangles[t * 3 + 2];
    if (i >= vertexCount || j >= vertexCount || k >= vertexCount) continue;
    const Vec3 n = cross(point(j) - point(i), point(k) - point(i));
    const double area = length(n);
    if (!(area > 1e-9) || !std::isfinite(area)) continue;
    tris.push_back({{i, j, k}, n * (1 / area), colorOf(t)});
    if (t < firstUnder) top++;
  }
  // Two passes over each corner: first gather the triangles that agree, then name them.
  // A triangle joins the first gathering at its corner that has its colour and whose normal
  // so far is within the crease angle of its own.
  std::vector<std::vector<Corner>> at(vertexCount);
  std::vector<uint32_t> slot(tris.size() * 3);
  for (size_t t = 0; t < tris.size(); t++) {
    const Vec3 unit = tris[t].normal;
    for (int c = 0; c < 3; c++) {
      // Weighted by the angle the triangle has at this corner, not by its area: a facet of a
      // cylinder is two triangles, one corner has both and its neighbour one, and only the
      // angle gives both corners the same share of each facet.
      const Vec3 here0 = point(tris[t].v[c]);
      const Vec3 e1 = normalized(point(tris[t].v[(c + 1) % 3]) - here0), e2 = normalized(point(tris[t].v[(c + 2) % 3]) - here0);
      const double angle = std::acos(std::min(1.0, std::max(-1.0, dot(e1, e2))));
      std::vector<Corner>& here = at[tris[t].v[c]];
      size_t g = 0;
      for (; g < here.size(); g++) {
        const double len = length(here[g].sum);
        if (here[g].color == tris[t].color && len > 0 && dot(here[g].sum, unit) / len >= agree) break;
      }
      if (g == here.size()) here.push_back({{}, tris[t].color, 0});
      here[g].sum = here[g].sum + unit * angle;
      slot[t * 3 + static_cast<size_t>(c)] = static_cast<uint32_t>(g);
    }
  }
  for (uint32_t v = 0; v < vertexCount; v++)
    for (Corner& corner : at[v]) {
      const Vec3 p = point(v);
      const double len = length(corner.sum);
      const Vec3 n = len > 0 ? corner.sum * (1 / len) : Vec3{0, -1, 0};
      corner.index = static_cast<uint32_t>(out.vertices.size());
      out.vertices.push_back({static_cast<float>(p.x), static_cast<float>(p.y), static_cast<float>(p.z), static_cast<float>(n.x), static_cast<float>(n.y), static_cast<float>(n.z), corner.color});
      out.bounds.grow(p);
    }
  out.indices.reserve(tris.size() * 3);
  for (size_t t = 0; t < tris.size(); t++)
    for (int c = 0; c < 3; c++) out.indices.push_back(at[tris[t].v[c]][slot[t * 3 + static_cast<size_t>(c)]].index);
  if (!out.indices.empty()) out.edges = mesh.edges;
  out.topIndices = static_cast<uint32_t>(top * 3);
  out.bottom = mesh.bottom;
  return out;
}

RenderMesh boxMesh(const bm::Box& box) {
  RenderMesh out;
  if (box.empty()) return out;
  const Vec3 lo = box.min, hi = box.max;
  // Each face: its outward normal and its four corners, counter-clockwise seen from outside.
  struct Face {
    Vec3 n, c[4];
  };
  const Face faces[6] = {
      {{1, 0, 0}, {{hi.x, lo.y, lo.z}, {hi.x, hi.y, lo.z}, {hi.x, hi.y, hi.z}, {hi.x, lo.y, hi.z}}},
      {{-1, 0, 0}, {{lo.x, lo.y, lo.z}, {lo.x, lo.y, hi.z}, {lo.x, hi.y, hi.z}, {lo.x, hi.y, lo.z}}},
      {{0, 1, 0}, {{lo.x, hi.y, lo.z}, {lo.x, hi.y, hi.z}, {hi.x, hi.y, hi.z}, {hi.x, hi.y, lo.z}}},
      {{0, -1, 0}, {{lo.x, lo.y, lo.z}, {hi.x, lo.y, lo.z}, {hi.x, lo.y, hi.z}, {lo.x, lo.y, hi.z}}},
      {{0, 0, 1}, {{lo.x, lo.y, hi.z}, {hi.x, lo.y, hi.z}, {hi.x, hi.y, hi.z}, {lo.x, hi.y, hi.z}}},
      {{0, 0, -1}, {{lo.x, lo.y, lo.z}, {lo.x, hi.y, lo.z}, {hi.x, hi.y, lo.z}, {hi.x, lo.y, lo.z}}},
  };
  for (const Face& f : faces) {
    const uint32_t first = static_cast<uint32_t>(out.vertices.size());
    for (const Vec3& p : f.c) out.vertices.push_back({static_cast<float>(p.x), static_cast<float>(p.y), static_cast<float>(p.z), static_cast<float>(f.n.x), static_cast<float>(f.n.y), static_cast<float>(f.n.z), 0});
    // Wound so that the face's own normal agrees with the one given, whichever way the corners run.
    const Vec3 n = cross(f.c[1] - f.c[0], f.c[2] - f.c[0]);
    if (dot(n, f.n) >= 0) out.indices.insert(out.indices.end(), {first, first + 1, first + 2, first, first + 2, first + 3});
    else out.indices.insert(out.indices.end(), {first, first + 2, first + 1, first, first + 3, first + 2});
  }
  out.bounds = box;
  out.topIndices = static_cast<uint32_t>(out.indices.size());
  return out;
}

struct MeshLibrary::State {
  const bm::Model* model;
  bm::ldraw::PartCache& full;
  bm::ldraw::PartCache& low;
  std::unique_ptr<bm::ldraw::PartCache> rounded; // high-resolution display primitives, independent of planning; null: `full`
  Rounding rounding;
  std::unique_ptr<bm::ldraw::PartCache> bare;  // as `low`, without studs: for Detail::Shadow
  std::mutex mutex;
  std::map<std::pair<std::string, int>, std::shared_ptr<const RenderMesh>> made;
};

MeshLibrary::MeshLibrary(const bm::Model& model, bm::ldraw::PartCache& full, bm::ldraw::PartCache& low, Rounding rounding)
    : state_(new State{&model, full, low, nullptr, rounding, nullptr, {}, {}}) {
  if (rounding.smoothCurves) {
    auto display = full.options();
    display.hiResPrimitives = true;
    display.lowResPrimitives = false;
    state_->rounded = std::make_unique<bm::ldraw::PartCache>(full.library(), full.directory(), display);
  }
  bm::ldraw::FlattenOptions bare = low.options();
  bare.noStuds = true;
  state_->bare = std::make_unique<bm::ldraw::PartCache>(low.library(), low.directory(), bare);
}
MeshLibrary::~MeshLibrary() = default;

void MeshLibrary::rebind(const bm::Model& model) {
  State& s = *state_;
  std::lock_guard lock(s.mutex);
  s.model = &model;
  std::erase_if(s.made, [&](const auto& entry) { return model.library().isInline(entry.first.first); });
}

std::shared_ptr<const RenderMesh> MeshLibrary::get(const std::string& part, Detail detail) {
  State& s = *state_;
  const auto key = std::make_pair(part, static_cast<int>(detail));
  {
    std::lock_guard lock(s.mutex);
    const auto it = s.made.find(key);
    if (it != s.made.end()) return it->second;
  }
  // Built outside the lock: two threads may build the same mesh once each, and the first is kept.
  std::shared_ptr<const RenderMesh> mesh;
  if (detail == Detail::Full) {
    RenderMesh rounded = buildRenderMesh(*s.model->mesh(part, s.rounded ? *s.rounded : s.full), s.model->library().colors());
    if (s.rounding.roundedEdges) roundRenderEdges(rounded, kRoundedEdgeWidth);
    if (s.rounding.softStudRoots) softenStudRoots(rounded, kStudRootWidth);
    mesh = std::make_shared<const RenderMesh>(std::move(rounded));
  } else {
    const std::shared_ptr<const RenderMesh> whole = get(part, Detail::Full);
    if (detail == Detail::Box) {
      mesh = std::make_shared<const RenderMesh>(boxMesh(whole->bounds));
    } else if (detail == Detail::Shadow) {
      mesh = get(part, Detail::Low);
      if (!mesh->empty() && !s.model->library().isInline(part)) {
        RenderMesh bare = buildRenderMesh(*s.bare->get(part), s.model->library().colors());
        if (!bare.empty() && bare.indices.size() < mesh->indices.size()) mesh = std::make_shared<const RenderMesh>(std::move(bare));
      }
    } else {
      mesh = whole;
      if (!whole->empty() && !s.model->library().isInline(part)) {
        RenderMesh coarse = buildRenderMesh(*s.low.get(part), s.model->library().colors());
        if (s.rounding.roundedEdges) roundRenderEdges(coarse, kRoundedEdgeWidth);
        if (s.rounding.softStudRoots) softenStudRoots(coarse, kStudRootWidth);
        if (!coarse.empty() && coarse.indices.size() < whole->indices.size()) mesh = std::make_shared<const RenderMesh>(std::move(coarse));
      }
    }
  }
  std::lock_guard lock(s.mutex);
  return s.made.emplace(key, mesh).first->second;
}

}  // namespace bmr
