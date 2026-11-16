#include "bm/kin/shift.h"

#include <algorithm>
#include <cmath>
#include "bm/kin/contact.h"
#include "bm/kin/drive.h"
#include "bm/kin/tolerances.h"

namespace bm::kin {

std::vector<Shift> findShifts(const Model& model, const connect::Graph& graph, const System& sys, ldraw::PartCache& parts, collide::ShapeCache& shapes) {
  std::vector<Shift> out;
  if (std::none_of(sys.links.begin(), sys.links.end(), [](const Link& l) { return !l.seats.empty(); })) return out;
  Contact contact(model, graph, parts, shapes);
  std::vector<Xform> motion(sys.bodies);
  for (uint32_t li = 0; li < sys.links.size(); li++) {
    const Link& l = sys.links[li];
    if (l.a >= sys.bodies || l.b >= sys.bodies) continue;
    const bool moveB = sys.size[l.b] <= sys.size[l.a];
    const uint32_t mover = moveB ? l.b : l.a, partner = moveB ? l.a : l.b;
    for (const Vec3& seat : l.seats) {
      Shift shift;
      shift.link = li;
      shift.body = mover;
      shift.move = moveB ? seat : -seat;
      // At the seat it is turned once round the slide's line. A body that stops it at every
      // angle is in the way of the slide itself (the fork that pushes it); one that stops it at
      // some angles and not at others has it by the teeth, and turns with it.
      std::vector<uint8_t> ignore(sys.bodies, 0);
      Xform there;
      there.t = shift.move;
      const Twist turn{l.axis, cross(l.point, l.axis)};
      std::vector<int> stopped(sys.bodies, 0);
      std::vector<uint32_t> seen;
      const int steps = static_cast<int>(std::lround(2 * 3.14159265358979323846 / kClutchStep));
      for (int i = 0; i < steps; i++) {
        motion[mover] = there * moved(turn, i * kClutchStep);
        std::fill(ignore.begin(), ignore.end(), 0);
        ignore[partner] = 1;  // what it slides on is never an obstacle
        std::pair<uint32_t, uint32_t> who;
        for (int guard = 0; guard < 16 && contact.blocked(sys.pieces[mover], sys.bodyOf, motion, &who, &ignore); guard++) {
          const uint32_t body = sys.bodyOf[who.second];
          ignore[body] = 1;
          if (stopped[body]++ == 0) seen.push_back(body);
        }
      }
      std::sort(seen.begin(), seen.end());
      for (uint32_t body : seen)
        if (stopped[body] < steps) shift.turnsWith.push_back(body);
      motion[mover] = Xform{};
      out.push_back(std::move(shift));
    }
  }
  return out;
}

System shifted(const System& sys, const std::vector<Shift>& chosen) {
  System out = sys;
  for (const Shift& s : chosen) {
    if (s.link >= sys.links.size()) continue;
    const Link& l = sys.links[s.link];
    for (uint32_t other : s.turnsWith) {
      if (other >= sys.bodies || other == s.body) continue;
      GearMesh m;
      m.kind = MeshKind::Clutch;
      m.axisA = m.axisB = m.tangent = l.axis;
      m.pointA = m.pointB = m.point = l.point;
      out.gearings.push_back({s.body, other, m, UINT32_MAX});
    }
  }
  return out;
}

}  // namespace bm::kin
