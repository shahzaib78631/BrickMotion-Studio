#include "bm/kin/system.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <numeric>
#include "bm/connect/tolerances.h"
#include "bm/kin/contact.h"
#include "bm/kin/tolerances.h"

namespace bm::kin {
namespace {

using connect::Connection;
using connect::Freedom;
using connect::JointKind;

struct UnionFind {
  std::vector<uint32_t> parent, count;
  explicit UnionFind(size_t n) : parent(n), count(n, 1) { std::iota(parent.begin(), parent.end(), 0u); }
  uint32_t find(uint32_t i) {
    while (parent[i] != i) i = parent[i] = parent[parent[i]];
    return i;
  }
  bool join(uint32_t a, uint32_t b) {
    a = find(a);
    b = find(b);
    if (a == b) return false;
    if (count[a] < count[b]) std::swap(a, b);
    parent[b] = a;
    count[a] += count[b];
    return true;
  }
};

bool turns(JointKind k) { return k == JointKind::Revolute || k == JointKind::Cylindrical; }
bool slides(JointKind k) { return k == JointKind::Prismatic || k == JointKind::Cylindrical; }

Freedom freedomOf(JointKind kind, Vec3 point, Vec3 axis) {
  Freedom f;
  f.rotates = turns(kind);
  f.slides = slides(kind);
  f.ball = kind == JointKind::Spherical;
  f.point = point;
  f.axis = axis;
  return f;
}

JointKind withoutSlide(JointKind k) { return k == JointKind::Cylindrical ? JointKind::Revolute : k == JointKind::Prismatic ? JointKind::Fixed : k; }

double offLine(Vec3 p, Vec3 origin, Vec3 axis) {
  const Vec3 v = p - origin;
  return length(v - axis * dot(v, axis));
}
bool sameLine(Vec3 p1, Vec3 a1, Vec3 p2, Vec3 a2) { return std::abs(dot(a1, a2)) >= kMeshAxis && offLine(p2, p1, a1) <= connect::kLineMatch; }

}  // namespace

System buildSystem(const Model& model, const connect::Graph& graph, ldraw::PartCache* parts, collide::ShapeCache* shapes, SystemOptions options) {
  System sys;
  const uint32_t n = static_cast<uint32_t>(model.pieces().size());
  sys.bodyOf.assign(n, 0);
  if (n == 0 || graph.body.size() != n) return sys;

  // The connections that could leave something free.
  std::vector<uint32_t> live;
  UnionFind uf(n);
  for (uint32_t i = 0; i < graph.connections.size(); i++) {
    const Connection& c = graph.connections[i];
    if (c.joint.kind == JointKind::Flexible) continue;
    if (c.joint.kind == JointKind::Fixed) uf.join(c.a, c.b);
    else live.push_back(i);
  }
  const bool travel = options.testTravel && parts && shapes;
  std::unique_ptr<Contact> contact;
  if (travel) contact = std::make_unique<Contact>(model, graph, *parts, *shapes);

  // Per live connection: 0 not yet tested, 1 slides, 2 held.
  std::vector<uint8_t> slideState(graph.connections.size(), 0);
  std::vector<uint32_t> testedSize(graph.connections.size(), 0);  // the moving body's size when it was last found free

  bool settled = false;  // the merges that need no collision test are done
  for (int round = 0; round < 64; round++) {
    bool changed = false;

    // Slides that do not move. A friction fit holds where it was pushed. Any other slide is
    // tested for room, but only once the cheap merges have settled, so that an axle is moved
    // together with the bushes and gears that grip it.
    for (uint32_t ci : live) {
      const Connection& c = graph.connections[ci];
      if (slideState[ci] != 0 || !slides(c.joint.kind)) continue;
      if (c.friction) {
        slideState[ci] = 2;
        changed = true;
      } else if (!travel) {
        slideState[ci] = 1;
      }
    }
    if (travel && settled) {
      std::vector<std::vector<uint32_t>> members(n);
      std::vector<uint32_t> root(n);
      for (uint32_t i = 0; i < n; i++) {
        root[i] = uf.find(i);
        members[root[i]].push_back(i);
      }
      std::vector<Xform> motion(n);
      std::vector<uint8_t> linked(n, 0);
      for (uint32_t ci : live) {
        const Connection& c = graph.connections[ci];
        if (!slides(c.joint.kind) || slideState[ci] == 2) continue;
        const uint32_t A = uf.find(c.a), B = uf.find(c.b);
        if (A == B) continue;
        const uint32_t mover = uf.count[A] <= uf.count[B] ? A : B;
        if (slideState[ci] == 1 && testedSize[ci] == uf.count[mover]) continue;  // nothing has changed since it was found free
        // What the mover is joined to by some other link is not an obstacle: whether that
        // link lets it go is for the equations to say. Its partner in this slide is one.
        std::fill(linked.begin(), linked.end(), 0);
        const uint32_t partner = mover == A ? B : A;
        for (uint32_t other : live) {
          if (slideState[other] == 2 && !turns(graph.connections[other].joint.kind)) continue;
          const uint32_t X = uf.find(graph.connections[other].a), Y = uf.find(graph.connections[other].b);
          if (X == mover && Y != partner) linked[Y] = 1;
          if (Y == mover && X != partner) linked[X] = 1;
        }
        auto freeAlong = [&](double sign) {
          motion[mover].t = c.joint.axis * (sign * kMinTravel);
          return !contact->blocked(members[mover], root, motion, nullptr, &linked);
        };
        const bool moves = freeAlong(1) || freeAlong(-1);
        motion[mover].t = {};
        testedSize[ci] = uf.count[mover];
        if (moves) {
          slideState[ci] = 1;
        } else {
          slideState[ci] = 2;
          changed = true;
        }
      }
    }

    // What is left free between each pair of bodies.
    struct Between {
      std::vector<Freedom> freedoms;
    };
    std::map<std::pair<uint32_t, uint32_t>, Between> pairs;
    struct Turning {
      uint32_t other;
      Vec3 point, axis;
      bool slides;
    };
    std::map<uint32_t, std::vector<Turning>> shafts;  // per body: the bodies turning on a line of it
    for (uint32_t ci : live) {
      const Connection& c = graph.connections[ci];
      const uint32_t A = uf.find(c.a), B = uf.find(c.b);
      if (A == B) continue;
      const JointKind kind = slideState[ci] == 2 ? withoutSlide(c.joint.kind) : c.joint.kind;
      pairs[std::minmax(A, B)].freedoms.push_back(freedomOf(kind, c.joint.point, c.joint.axis));
      if (turns(kind)) {
        shafts[A].push_back({B, c.joint.point, c.joint.axis, slides(kind)});
        shafts[B].push_back({A, c.joint.point, c.joint.axis, slides(kind)});
      }
    }
    // Two bodies turning on the same line of a third turn on that line against each other.
    for (const auto& [shaft, list] : shafts)
      for (size_t i = 0; i < list.size(); i++)
        for (size_t j = i + 1; j < list.size(); j++) {
          if (list[i].other == list[j].other || !sameLine(list[i].point, list[i].axis, list[j].point, list[j].axis)) continue;
          Freedom f;
          f.rotates = true;
          f.slides = list[i].slides || list[j].slides;
          f.point = list[i].point;
          f.axis = list[i].axis;
          pairs[std::minmax(list[i].other, list[j].other)].freedoms.push_back(f);
        }
    for (const auto& [key, between] : pairs)
      if (connect::combine(between.freedoms).kind == JointKind::Fixed) changed = uf.join(key.first, key.second) || changed;
    if (changed) continue;
    if (settled || !travel) break;
    settled = true;  // one more pass, now with the travel tests
  }

  // Number the bodies in order of first piece.
  std::vector<uint32_t> id(n, UINT32_MAX);
  for (uint32_t i = 0; i < n; i++) {
    const uint32_t r = uf.find(i);
    if (id[r] == UINT32_MAX) {
      id[r] = sys.bodies++;
      sys.size.push_back(0);
      sys.pieces.emplace_back();
    }
    sys.bodyOf[i] = id[r];
    sys.size[id[r]]++;
    sys.pieces[id[r]].push_back(i);
  }
  sys.ground = static_cast<uint32_t>(std::max_element(sys.size.begin(), sys.size.end()) - sys.size.begin());

  // One link per pair of bodies: the real connections between them, combined.
  struct Between {
    std::vector<Freedom> freedoms;
    uint32_t pieceA = 0, pieceB = 0;
  };
  std::map<std::pair<uint32_t, uint32_t>, Between> pairs;
  for (uint32_t ci : live) {
    const Connection& c = graph.connections[ci];
    if (slideState[ci] == 2) sys.heldSlides.push_back(ci);
    uint32_t A = sys.bodyOf[c.a], B = sys.bodyOf[c.b], pa = c.a, pb = c.b;
    if (A == B) continue;
    if (A > B) {
      std::swap(A, B);
      std::swap(pa, pb);
    }
    Between& between = pairs[{A, B}];
    if (between.freedoms.empty()) {
      between.pieceA = pa;
      between.pieceB = pb;
    }
    between.freedoms.push_back(freedomOf(slideState[ci] == 2 ? withoutSlide(c.joint.kind) : c.joint.kind, c.joint.point, c.joint.axis));
  }
  for (const auto& [key, between] : pairs) {
    const connect::Joint joint = connect::combine(between.freedoms);
    if (joint.kind == JointKind::Fixed) continue;  // cannot happen: such pairs were merged
    sys.links.push_back({key.first, key.second, joint.kind, joint.point, normalized(joint.axis), between.pieceA, between.pieceB});
  }

  // Directions that differ only by the rounding of the file become one direction, so that a
  // linkage whose pins should all be parallel is not locked by a fraction of a degree. The
  // model's own axes come first: nearly-upright is upright.
  {
    std::vector<Vec3> directions{{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
    for (Link& link : sys.links) {
      if (link.kind == JointKind::Spherical) continue;
      bool known = false;
      for (const Vec3& d : directions) {
        const double c = dot(link.axis, d);
        if (std::abs(c) < kMeshAxis) continue;
        link.axis = c < 0 ? -d : d;
        known = true;
        break;
      }
      if (!known) directions.push_back(link.axis);
    }
  }
  // Lines that differ only by the rounding of the file become one line, so that a shaft through
  // two holes is not locked by it either.
  for (size_t i = 0; i < sys.links.size(); i++) {
    Link& link = sys.links[i];
    if (link.kind == JointKind::Spherical) continue;
    for (size_t j = 0; j < i; j++) {
      const Link& first = sys.links[j];
      if (first.kind == JointKind::Spherical || !sameLine(first.point, first.axis, link.point, link.axis)) continue;
      const double along = dot(link.point - first.point, first.axis);
      link.point = first.point + first.axis * along;
      link.axis = dot(link.axis, first.axis) < 0 ? -first.axis : first.axis;
      break;
    }
  }

  for (const GearMesh& m : graph.meshes) {
    if (m.a >= n || m.b >= n || sys.bodyOf[m.a] == sys.bodyOf[m.b]) continue;
    sys.gearings.push_back({sys.bodyOf[m.a], sys.bodyOf[m.b], m, UINT32_MAX});
  }
  for (const GearMesh& m : graph.screws) {
    if (m.a >= n || m.b >= n || m.housing >= n) continue;
    const uint32_t input = sys.bodyOf[m.a], piston = sys.bodyOf[m.b], housing = sys.bodyOf[m.housing];
    if (input == piston || input == housing || piston == housing) continue;  // something holds it: it does not work
    sys.gearings.push_back({input, piston, m, housing});
  }
  return sys;
}

}  // namespace bm::kin
