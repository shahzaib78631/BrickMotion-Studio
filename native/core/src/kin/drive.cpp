#include "bm/kin/drive.h"

#include <algorithm>
#include <cmath>
#include "bm/kin/constraints.h"
#include "bm/kin/tolerances.h"

namespace bm::kin {
namespace {

Mat3 hat(Vec3 w) { return Mat3{{0, -w.z, w.y, w.z, 0, -w.x, -w.y, w.x, 0}}; }
Mat3 add(const Mat3& a, const Mat3& b, double s) {
  Mat3 r;
  for (int i = 0; i < 9; i++) r.m[i] = a.m[i] + s * b.m[i];
  return r;
}

}  // namespace

Xform moved(const Twist& twist, double t) {
  const double rate = length(twist.angular), angle = rate * t;
  Xform out;
  if (std::abs(angle) < 1e-12) {
    out.t = twist.linear * t;
    return out;
  }
  const Mat3 k = hat(twist.angular), kk = k * k;
  const double s = std::sin(angle), c = std::cos(angle);
  out.r = add(add(Mat3::identity(), k, s / rate), kk, (1 - c) / (rate * rate));
  Mat3 v = add(add(Mat3{{t, 0, 0, 0, t, 0, 0, 0, t}}, k, (1 - c) / (rate * rate)), kk, (angle - s) / (rate * rate * rate));
  out.t = v * twist.linear;
  return out;
}

Pose drive(const System& sys, const Mobility& mob, size_t freedomIndex, uint32_t driver, double amount, const Pose* from) {
  Pose pose;
  pose.body.assign(sys.bodies, Xform{});
  if (from && from->body.size() == sys.bodies) pose.body = from->body;
  if (amount == 0 || !std::isfinite(amount)) return pose;
  if (freedomIndex >= mob.freedoms.size()) {
    pose.converged = false;
    return pose;
  }
  const Freedom& freedom = mob.freedoms[freedomIndex];
  // Everything joined to the bodies this freedom moves, up to the bodies that stand still. A
  // body that is not moving right now (a piston at the top of its stroke) is still part of it.
  std::vector<uint8_t> in(sys.bodies, 0);
  std::vector<uint32_t> bodies;
  for (uint32_t b : freedom.bodies)
    if (b < sys.bodies && !in[b]) in[b] = 1, bodies.push_back(b);
  auto held = [&](uint32_t b) { return b < mob.held.size() && mob.held[b]; };
  for (bool grew = true; grew;) {
    grew = false;
    auto reach = [&](uint32_t a, uint32_t b) {
      for (int pass = 0; pass < 2; pass++, std::swap(a, b))
        if (in[a] && !in[b] && !held(b)) in[b] = 1, bodies.push_back(b), grew = true;
    };
    for (const Link& l : sys.links) reach(l.a, l.b);
    for (const Gearing& g : sys.gearings) reach(g.a, g.b);
  }
  std::sort(bodies.begin(), bodies.end());
  std::vector<int> column(sys.bodies, -1);
  for (size_t i = 0; i < bodies.size(); i++) column[bodies[i]] = static_cast<int>(6 * i);
  const size_t columns = 6 * bodies.size();
  std::vector<uint32_t> links, gearings;
  for (uint32_t i = 0; i < sys.links.size(); i++)
    if (column[sys.links[i].a] >= 0 || column[sys.links[i].b] >= 0) links.push_back(i);
  for (uint32_t i = 0; i < sys.gearings.size(); i++)
    if (column[sys.gearings[i].a] >= 0 || column[sys.gearings[i].b] >= 0) gearings.push_back(i);

  // The rate vector: turning in radians, moving in studs.
  std::vector<double> rate(columns, 0.0);
  for (size_t i = 0; i < bodies.size(); i++) {
    const Twist t = twistOf(freedom, bodies[i]);
    const Vec3 lin = t.linear * (1 / kLengthUnit);
    const double v[6] = {t.angular.x, t.angular.y, t.angular.z, lin.x, lin.y, lin.z};
    std::copy(v, v + 6, rate.begin() + static_cast<long>(6 * i));
  }
  if (driver >= sys.bodies || column[driver] < 0) {  // not part of this freedom
    pose.converged = false;
    return pose;
  }
  const size_t dc = static_cast<size_t>(column[driver]);
  // Forwards is the way the freedom moves the driver in the model's own pose. If it does not
  // move it there (a slider at its dead point), forwards is the way things are already going.
  const Twist driverRest = twistOf(freedom, driver);
  bool turns = length(driverRest.angular) > kStill;
  const bool restMoves = turns || length(driverRest.linear) > kStill * kLengthUnit;
  bool first = true;
  auto speed = [&](const std::vector<double>& r) {  // how fast the driver goes: radians, or LDU
    const Vec3 w{r[dc], r[dc + 1], r[dc + 2]}, v{r[dc + 3], r[dc + 4], r[dc + 5]};
    return turns ? length(w) : length(v) * kLengthUnit;
  };
  auto apply = [&](std::vector<Xform>& q, const std::vector<double>& r, double t) {
    for (size_t i = 0; i < bodies.size(); i++) {
      const double* v = &r[6 * i];
      const Twist twist{{v[0], v[1], v[2]}, Vec3{v[3], v[4], v[5]} * kLengthUnit};
      q[bodies[i]] = moved(twist, t) * q[bodies[i]];
    }
  };
  auto worst = [](const std::vector<double>& r) {
    double w = 0;
    for (double x : r) w = std::max(w, std::abs(x));
    return w;
  };

  const double direction = amount > 0 ? 1 : -1, total = std::abs(amount);
  double done = 0;
  while (done < total - 1e-12) {
    // The way the system can move from here that is closest to the way it was moving.
    const Equations eq = equations(sys, column, columns, links, gearings, &pose.body);
    const Matrix null = nullSpace(eq.jacobian, kRankTol);
    std::vector<double> next(columns, 0.0);
    for (size_t c = 0; c < null.cols; c++) {
      double d = 0;
      for (size_t r = 0; r < columns; r++) d += null.at(r, c) * rate[r];
      for (size_t r = 0; r < columns; r++) next[r] += d * null.at(r, c);
    }
    if (first) {
      first = false;
      const Vec3 w{next[dc], next[dc + 1], next[dc + 2]}, v{next[dc + 3], next[dc + 4], next[dc + 5]};
      if (!restMoves) turns = length(w) > kStill;
      else if ((turns ? dot(w, pose.body[driver].r * driverRest.angular) : dot(v, pose.body[driver].r * driverRest.linear)) < 0)
        for (double& x : next) x = -x;
    }
    const double s = speed(next);
    if (!(s > 1e-6)) break;  // the driver can go no further this way
    for (double& x : next) x /= s;
    const double step = std::min(turns ? kDriveStep : kDriveStep * kLengthUnit, total - done);
    std::vector<Xform> trial = pose.body;
    apply(trial, next, direction * step);

    // Close the joints again.
    bool closed = false;
    for (int it = 0; it < kMaxNewton; it++) {
      const Equations at = equations(sys, column, columns, links, gearings, &trial);
      if (worst(at.residual) <= kCloseTol) {
        closed = true;
        break;
      }
      // One more equation: the correction does not take the driver forwards or back.
      Matrix held(at.jacobian.rows + 1, columns);
      std::copy(at.jacobian.v.begin(), at.jacobian.v.end(), held.v.begin());
      for (size_t k = 0; k < 6; k++) held.at(at.jacobian.rows, dc + k) = next[dc + k];
      std::vector<double> rhs(at.residual.size() + 1, 0.0);
      for (size_t i = 0; i < at.residual.size(); i++) rhs[i] = -at.residual[i];
      const std::vector<double> fix = solveLeastNorm(held, rhs, kRankTol);
      if (!(worst(fix) < 1.0)) break;  // not a small correction: the joints cannot be closed from here
      apply(trial, fix, 1.0);
    }
    if (!closed) break;
    pose.body = std::move(trial);
    rate = std::move(next);
    done += step;
    pose.reached = direction * done;
  }
  pose.converged = done >= total - 1e-12;
  return pose;
}

Xform placed(const Model& model, const System& sys, const Pose& pose, uint32_t piece) {
  if (piece >= model.pieces().size()) return {};
  const Xform& world = model.pieces()[piece].world;
  if (piece >= sys.bodyOf.size() || sys.bodyOf[piece] >= pose.body.size()) return world;
  return pose.body[sys.bodyOf[piece]] * world;
}

}  // namespace bm::kin
