#include "bms/snap_events.h"

#include <algorithm>
#include <limits>

namespace bms {

namespace {
bool seated(const bm::Xform& x) {
  const bm::Vec3 axes[3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
  for (const bm::Vec3& a : axes)
    if (bm::length(x.apply(a) - a) > 1e-9) return false;
  return bm::length(x.t) < 1e-9;
}
}  // namespace

std::vector<SnapEvent> snapEvents(const bm::Model& model, const bm::connect::Graph& graph, const bm::plan::Plan& plan, const bm::plan::Timeline& timeline,
                                  std::span<const bm::Box> pieceBoxes, const std::function<double(int frame, bm::Vec3 point)>& screenX) {
  std::vector<SnapEvent> out;
  const double fps = bm::plan::Style{}.fps;
  const size_t n = std::max(model.pieces().size(), pieceBoxes.size());
  auto boxOf = [&](uint32_t piece) { return piece < pieceBoxes.size() ? pieceBoxes[piece] : bm::Box{}; };
  std::vector<std::vector<uint32_t>> joins(n);  // per piece: its connections
  for (uint32_t i = 0; i < graph.connections.size(); i++) {
    const bm::connect::Connection& c = graph.connections[i];
    if (c.a < n) joins[c.a].push_back(i);
    if (c.b < n) joins[c.b].push_back(i);
  }
  std::vector<uint8_t> built(n, 0), inUnit(n, 0);
  bm::Box builtBox;
  uint32_t builtPieces = 0;
  for (const bm::plan::Flight& flight : timeline.flights) {
    if (flight.move >= plan.moves.size()) continue;
    const bm::plan::Move& move = plan.moves[flight.move];
    const std::vector<uint32_t>& pieces = move.unit.pieces;
    for (uint32_t p : pieces)
      if (p < n) inUnit[p] = 1;
    if (move.flag == bm::plan::Flag::None && flight.frames > 0) {
      SnapEvent e;
      e.move = flight.move;
      e.frame = flight.startFrame + flight.frames;
      for (int f = flight.startFrame; f <= flight.startFrame + flight.frames; f++)
        if (seated(bm::plan::poseAt(flight, f))) {
          e.frame = f;
          break;
        }
      for (uint32_t p : pieces) e.unit.merge(boxOf(p));
      int kind = std::numeric_limits<int>::max();
      uint32_t mates = 0;
      for (uint32_t p : pieces) {
        if (p >= n) continue;
        for (uint32_t ci : joins[p]) {
          const bm::connect::Connection& c = graph.connections[ci];
          const uint32_t other = c.a == p ? c.b : c.a;
          if (other >= n || inUnit[other] || !built[other]) continue;
          mates += c.mates;
          e.ridge = e.ridge || c.friction;
          e.grip += c.grip;
          kind = std::min(kind, static_cast<int>(c.joint.kind));  // Fixed is first in enum order
          e.touching.merge(boxOf(other));
        }
      }
      e.mates = static_cast<uint16_t>(std::min<uint32_t>(mates, UINT16_MAX));
      e.joint = kind == std::numeric_limits<int>::max() ? bm::connect::JointKind::Fixed : static_cast<bm::connect::JointKind>(kind);
      e.built = builtBox;
      e.built.merge(e.unit);
      e.builtPieces = builtPieces;
      const double landing = flight.at.size() >= 2 ? flight.at.back() - flight.at[flight.at.size() - 2] : 1.0;
      e.seatSeconds = flight.seatFrames > 0 ? flight.seatFrames / fps : landing * flight.frames / fps;
      if (!e.unit.empty() && screenX) {
        const double x = screenX(e.frame, (e.unit.min + e.unit.max) * 0.5);
        e.pan = std::isfinite(x) ? std::clamp(x, -1.0, 1.0) : 0.0;
      }
      out.push_back(e);
    }
    for (uint32_t p : pieces) {
      if (p >= n) continue;
      inUnit[p] = 0;
      if (!built[p]) built[p] = 1, builtPieces++;
      builtBox.merge(boxOf(p));
    }
  }
  return out;
}

}  // namespace bms
