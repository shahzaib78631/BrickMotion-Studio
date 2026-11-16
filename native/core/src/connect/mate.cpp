#include "bm/connect/mate.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include "bm/connect/tolerances.h"

namespace bm::connect {
namespace {

/// Distance from `p` to the line through `origin` along unit `axis`.
double offLine(Vec3 p, Vec3 origin, Vec3 axis) {
  const Vec3 v = p - origin;
  return length(v - axis * dot(v, axis));
}

bool parallel(Vec3 a, Vec3 b) { return std::abs(dot(a, b)) >= kAxisParallel; }

double overlap(double lo1, double hi1, double lo2, double hi2) { return std::min(hi1, hi2) - std::max(lo1, lo2); }

std::string fmt(double v) {
  char buf[32];
  std::snprintf(buf, sizeof buf, "%.1f", v);
  return buf;
}

/// "R6x4 R8x2": a profile in a few characters.
std::string shapeOf(const Connector& c) {
  std::string out;
  for (const ProfileSection& s : c.profile) out += (out.empty() ? "" : " ") + std::string(1, s.shape) + fmt(s.radius) + "x" + fmt(s.length);
  return out;
}

enum class Fit { Grips, Loose, Clashes };

/// How a male section sits in a female one it overlaps.
Fit fit(const ProfileSection& m, const ProfileSection& f, bool& keyed) {
  if (m.shape == 'T' || f.shape == 'T') {
    // A tyre bore takes a rim seat and nothing else, and holds it without turning.
    if (m.shape != f.shape || std::abs(m.radius - f.radius) > kTyreSlack) return Fit::Loose;
    keyed = true;
    return Fit::Grips;
  }
  if (m.shape == 'L') return std::abs(m.radius - f.radius) <= kRadiusSlack ? Fit::Grips : Fit::Loose;  // a lip gives way
  if (f.shape == 'L') return Fit::Loose;
  if (f.shape == 'A' && m.shape != 'A') {
    // Something round in a cross-shaped hole: only what fits the cross's round core.
    const double core = f.radius * kAxleCoreRatio;
    if (m.radius > core + kRadiusSlack) return Fit::Clashes;
    return m.radius >= core - kRadiusSlack ? Fit::Grips : Fit::Loose;
  }
  if (m.radius > f.radius + kRadiusSlack) return Fit::Clashes;
  if (m.radius < f.radius - kRadiusSlack) return Fit::Loose;
  if (m.shape == 'A' && f.shape == 'A') keyed = true;
  return Fit::Grips;
}

std::optional<Mate> cylinders(const Connector& m, const Connector& f, std::string* why = nullptr) {
  auto no = [&](std::string reason) -> std::optional<Mate> {
    if (why) *why = std::move(reason);
    return std::nullopt;
  };
  const double d = dot(m.axis, f.axis);
  if (std::abs(d) < kAxisParallel) return no("axes " + fmt(std::acos(std::min(1.0, std::abs(d))) * 180 / 3.14159265358979) + " deg apart");
  if (offLine(m.start, f.start, f.axis) > kAxisOffset) return no(fmt(offLine(m.start, f.start, f.axis)) + " off axis");
  const double sign = d > 0 ? 1 : -1;
  const double t0 = dot(m.start - f.start, f.axis);
  const double lo = std::min(t0, t0 + sign * m.length), hi = std::max(t0, t0 + sign * m.length);

  // A closed end cannot be passed, and a blind hole is entered base-last through its opening.
  if (!f.openEnd && hi > f.length + kMinInterference) return no("runs " + fmt(hi - f.length) + " past the closed end");
  if (!f.openStart && lo < -kMinInterference) return no("runs " + fmt(-lo) + " past the closed start");
  const bool doubleEnded = m.openStart && m.openEnd;
  if (!doubleEnded) {
    if (f.openStart && !f.openEnd && sign < 0) return no("enters through the closed end");
    if (!f.openStart && f.openEnd && sign > 0) return no("enters through the closed start");
  }

  double grip = 0, clash = 0, gripLo = 1e300, gripHi = -1e300;
  bool keyed = false;
  for (const ProfileSection& ms : m.profile) {
    const double a = t0 + sign * ms.start, b = t0 + sign * (ms.start + ms.length);
    const double mLo = std::min(a, b), mHi = std::max(a, b);
    for (const ProfileSection& fs : f.profile) {
      const double ov = overlap(mLo, mHi, fs.start, fs.start + fs.length);
      if (ov <= 0) continue;
      bool pairKeyed = false;
      switch (fit(ms, fs, pairKeyed)) {
        case Fit::Clashes: clash += ov; break;
        case Fit::Loose: break;
        case Fit::Grips:
          grip += ov;
          keyed = keyed || pairKeyed;
          gripLo = std::min(gripLo, std::max(mLo, fs.start));
          gripHi = std::max(gripHi, std::min(mHi, fs.start + fs.length));
          break;
      }
    }
  }
  if (clash > kMinInterference) return no("clash " + fmt(clash) + " (male " + shapeOf(m) + " in female " + shapeOf(f) + ")");
  if (grip < kMinGrip) return no("grip " + fmt(grip) + " (male " + shapeOf(m) + " at " + fmt(lo) + ".." + fmt(hi) + " in female " + shapeOf(f) + ")");
  Mate out;
  out.grip = grip;
  out.freedom.rotates = !keyed;
  out.freedom.slides = m.slide || f.slide;
  out.freedom.axis = f.axis;
  out.freedom.point = f.start + f.axis * ((gripLo + gripHi) / 2);
  return out;
}

std::optional<Mate> barInClip(const Connector& bar, const Connector& clip) {
  if (!parallel(bar.axis, clip.axis) || offLine(bar.start, clip.start, clip.axis) > kAxisOffset) return std::nullopt;
  const double sign = dot(bar.axis, clip.axis) > 0 ? 1 : -1;
  const double t0 = dot(bar.start - clip.start, clip.axis);
  const double clipLength = std::max(clip.length, kMinClipLength);
  double grip = 0;
  for (const ProfileSection& s : bar.profile) {
    if (s.shape != 'R' || std::abs(s.radius - clip.radius) > kRadiusSlack) continue;
    const double a = t0 + sign * s.start, b = t0 + sign * (s.start + s.length);
    grip += std::max(0.0, overlap(std::min(a, b), std::max(a, b), 0, clipLength));
  }
  if (grip < kMinGrip) return std::nullopt;
  Mate out;
  out.grip = grip;
  out.freedom = {true, bar.slide || clip.slide, false, clip.start + clip.axis * (clipLength / 2), clip.axis};
  return out;
}

/// The solid (finger) and empty (gap) stretches of a finger connector along its own axis.
void fingerSpans(const Connector& c, std::vector<std::pair<double, double>>& solids, std::vector<std::pair<double, double>>& gaps) {
  double at = 0;
  bool solid = c.gender == Gender::Male;
  for (double w : c.seq) {
    (solid ? solids : gaps).emplace_back(at, at + w);
    at += w;
    solid = !solid;
  }
}

/// Two hinge halves mesh when they share an axis and the fingers of one sit in the gaps of
/// the other without the fingers colliding.
std::optional<Mate> fingers(const Connector& a, const Connector& b) {
  if (a.group != b.group) return std::nullopt;
  if (std::abs(a.radius - b.radius) > kRadiusSlack) return std::nullopt;
  if (!parallel(a.axis, b.axis) || offLine(b.start, a.start, a.axis) > kAxisOffset) return std::nullopt;
  const double sign = dot(a.axis, b.axis) > 0 ? 1 : -1;
  const double t0 = dot(b.start - a.start, a.axis);
  std::vector<std::pair<double, double>> solidA, gapA, solidB, gapB;
  fingerSpans(a, solidA, gapA);
  fingerSpans(b, solidB, gapB);
  auto onA = [&](std::vector<std::pair<double, double>>& spans) {  // b's spans on a's axis
    for (auto& [lo, hi] : spans) {
      const double p = t0 + sign * lo, q = t0 + sign * hi;
      lo = std::min(p, q);
      hi = std::max(p, q);
    }
  };
  onA(solidB);
  onA(gapB);
  auto shared = [](const std::vector<std::pair<double, double>>& x, const std::vector<std::pair<double, double>>& y) {
    double total = 0;
    for (const auto& [a0, a1] : x)
      for (const auto& [b0, b1] : y) total += std::max(0.0, overlap(a0, a1, b0, b1));
    return total;
  };
  if (shared(solidA, solidB) > kMinInterference) return std::nullopt;
  const double meshed = shared(solidA, gapB) + shared(solidB, gapA);
  if (meshed < kMinGrip) return std::nullopt;
  Mate out;
  out.grip = meshed;
  out.freedom = {true, false, false, a.start + a.axis * (a.length / 2), a.axis};
  return out;
}

std::optional<Mate> generics(const Connector& a, const Connector& b) {
  if (a.gender == b.gender || a.group != b.group) return std::nullopt;
  auto isBall = [](const Connector& c) { return c.bounding.rfind("sph", 0) == 0 || c.placement == "free"; };
  // A ball of measured size is in its socket while its centre is within kBallSeat of a radius of
  // the socket's: files set links between two balls whose distance they do not quite span.
  // Only radii measured for the purpose are trusted: a shadow file's "sph" is a bounding size.
  const bool sizedBalls = isBall(a) && isBall(b) && a.radius > 0 && b.radius > 0 && a.source == Source::Override && b.source == Source::Override;
  const double reach = sizedBalls ? std::max(kPointMatch, kBallSeat * std::min(a.radius, b.radius)) : kPointMatch;
  if (length(a.start - b.start) > reach) return std::nullopt;
  if ((a.match == "size" || b.match == "size") && std::abs(a.radius - b.radius) > kRadiusSlack) return std::nullopt;
  Mate out;
  out.grip = std::max(a.radius, b.radius);
  if (a.placement == "hinge" || b.placement == "hinge") {
    // Two hinge halves: they share the hinge line and turn about it.
    if (!parallel(a.axis, b.axis)) return std::nullopt;
    out.freedom = {true, false, false, a.start, a.axis};
    return out;
  }
  out.freedom.ball = isBall(a) || isBall(b);
  out.freedom.point = a.start;
  out.freedom.axis = a.axis;
  return out;
}

Vec3 anyUnit(Vec3 v) { return length(v) > 0 ? normalized(v) : Vec3{0, -1, 0}; }

}  // namespace

std::optional<Mate> mate(const Connector& a, const Connector& b) {
  if (a.kind == SnapKind::Cyl && b.kind == SnapKind::Cyl) {
    if (a.gender == b.gender) return std::nullopt;
    return a.gender == Gender::Male ? cylinders(a, b) : cylinders(b, a);
  }
  if (a.kind == SnapKind::Cyl && b.kind == SnapKind::Clip) return a.gender == Gender::Male ? barInClip(a, b) : std::nullopt;
  if (a.kind == SnapKind::Clip && b.kind == SnapKind::Cyl) return b.gender == Gender::Male ? barInClip(b, a) : std::nullopt;
  if (a.kind == SnapKind::Finger && b.kind == SnapKind::Finger) return fingers(a, b);
  if (a.kind == SnapKind::Generic && b.kind == SnapKind::Generic) return generics(a, b);
  return std::nullopt;
}

Joint combine(const std::vector<Freedom>& mates) {
  Joint joint;
  joint.point = mates.front().point;
  joint.axis = anyUnit(mates.front().axis);

  // Sliding survives only along a direction every mate allows.
  bool slides = true;
  for (const Freedom& f : mates) slides = slides && f.slides && !f.ball && parallel(anyUnit(f.axis), joint.axis);

  // Turning survives only about a line every mate allows. A ball allows any line through it.
  bool turns = true, haveLine = false;
  Vec3 linePoint, lineAxis;
  std::vector<Vec3> balls;
  for (const Freedom& f : mates) {
    if (f.ball) {
      balls.push_back(f.point);
    } else if (!f.rotates) {
      turns = false;
    } else if (!haveLine) {
      haveLine = true;
      linePoint = f.point;
      lineAxis = anyUnit(f.axis);
    } else if (!parallel(anyUnit(f.axis), lineAxis) || offLine(f.point, linePoint, lineAxis) > kLineMatch) {
      turns = false;
    }
  }
  bool spherical = false;
  if (turns && !haveLine) {
    // Only balls. One centre: a ball joint. Several on a line: a hinge about that line.
    Vec3 other = balls.front();
    for (const Vec3& c : balls)
      if (length(c - balls.front()) > kPointMatch) other = c;
    if (length(other - balls.front()) <= kPointMatch) {
      spherical = true;
      joint.point = balls.front();
    } else {
      haveLine = true;
      linePoint = balls.front();
      lineAxis = normalized(other - balls.front());
    }
  }
  if (turns && haveLine) {
    for (const Vec3& c : balls) turns = turns && offLine(c, linePoint, lineAxis) <= kPointMatch;
    if (turns) {
      joint.point = linePoint;
      joint.axis = lineAxis;
    }
  }

  if (spherical) joint.kind = JointKind::Spherical;
  else if (turns && slides) joint.kind = JointKind::Cylindrical;
  else if (turns) joint.kind = JointKind::Revolute;
  else if (slides) joint.kind = JointKind::Prismatic;
  else joint.kind = JointKind::Fixed;
  return joint;
}

std::string whyNot(const Connector& a, const Connector& b) {
  if (mate(a, b)) return "";
  if (a.kind == SnapKind::Cyl && b.kind == SnapKind::Cyl) {
    if (a.gender == b.gender) return "same gender";
    std::string why;
    a.gender == Gender::Male ? cylinders(a, b, &why) : cylinders(b, a, &why);
    return why;
  }
  auto kind = [](const Connector& c) { return c.kind == SnapKind::Cyl ? "cylinder" : c.kind == SnapKind::Clip ? "clip" : c.kind == SnapKind::Finger ? "finger" : "generic"; };
  if (a.kind != b.kind && !((a.kind == SnapKind::Cyl && b.kind == SnapKind::Clip) || (a.kind == SnapKind::Clip && b.kind == SnapKind::Cyl))) return std::string(kind(a)) + " and " + kind(b) + " do not pair";
  return std::string(kind(a)) + "/" + kind(b) + " do not line up";
}

const char* name(JointKind kind) {
  switch (kind) {
    case JointKind::Fixed: return "fixed";
    case JointKind::Revolute: return "revolute";
    case JointKind::Prismatic: return "prismatic";
    case JointKind::Cylindrical: return "cylindrical";
    case JointKind::Spherical: return "spherical";
    case JointKind::Flexible: return "flexible";
  }
  return "fixed";
}

}  // namespace bm::connect
