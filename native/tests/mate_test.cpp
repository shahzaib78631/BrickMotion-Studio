#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include "bm/connect/mate.h"

using namespace bm;
using namespace bm::connect;
using Catch::Matchers::WithinAbs;

namespace {
const Vec3 kUp{0, -1, 0};

Connector cyl(Gender g, Vec3 start, Vec3 axis, std::vector<ProfileSection> profile, bool openStart = true, bool openEnd = false, bool slide = false) {
  Connector c;
  c.kind = SnapKind::Cyl;
  c.gender = g;
  c.start = start;
  c.axis = normalized(axis);
  c.side = std::abs(c.axis.x) < 0.9 ? normalized(cross(c.axis, Vec3{1, 0, 0})) : Vec3{0, 0, 1};
  double at = 0;
  for (ProfileSection& s : profile) {
    s.start = at;
    at += s.length;
    c.radius = std::max(c.radius, s.radius);
  }
  c.length = at;
  c.profile = std::move(profile);
  c.openStart = openStart;
  c.openEnd = openEnd;
  c.slide = slide;
  return c;
}
Connector stud(Vec3 base, Vec3 axis = kUp) { return cyl(Gender::Male, base, axis, {{'R', 6, 0, 4}}); }
Connector socket(Vec3 opening, Vec3 axis = kUp) { return cyl(Gender::Female, opening, axis, {{'R', 6, 0, 4}}); }
/// A Technic pin: 40 long, centred on `centre`, a collar in the middle.
Connector pin(Vec3 centre, Vec3 axis) {
  return cyl(Gender::Male, centre - normalized(axis) * 20, axis, {{'L', 6.25, 0, 2}, {'R', 6, 0, 16}, {'R', 8, 0, 4}, {'R', 6, 0, 16}, {'L', 6.25, 0, 2}}, true, true, true);
}
/// A Technic pin hole: 20 deep, countersunk both ends, open both ends.
Connector pinHole(Vec3 start, Vec3 axis) { return cyl(Gender::Female, start, axis, {{'R', 8, 0, 2}, {'R', 6, 0, 16}, {'R', 8, 0, 2}}, true, true, true); }
Connector axle(Vec3 start, Vec3 axis, double len) { return cyl(Gender::Male, start, axis, {{'A', 6, 0, len}}, true, true, true); }
Connector axleHole(Vec3 start, Vec3 axis, double len) { return cyl(Gender::Female, start, axis, {{'A', 6, 0, len}}, true, true, true); }
}  // namespace

TEST_CASE("a stud seats in a socket and can only turn", "[mate]") {
  const auto m = mate(stud({0, 24, 0}), socket({0, 24, 0}));
  REQUIRE(m.has_value());
  REQUIRE_THAT(m->grip, WithinAbs(4, 1e-9));
  REQUIRE((m->freedom.rotates && !m->freedom.slides && !m->freedom.ball));
  REQUIRE(mate(socket({0, 24, 0}), stud({0, 24, 0})).has_value());  // either order
  REQUIRE_FALSE(mate(stud({0, 24, 0}), stud({0, 24, 0})).has_value());
  REQUIRE_FALSE(mate(socket({0, 24, 0}), socket({0, 24, 0})).has_value());
}

TEST_CASE("a stud works in any direction", "[mate]") {
  for (Vec3 axis : {Vec3{1, 0, 0}, Vec3{0, 1, 0}, Vec3{0, 0, -1}, Vec3{1, 1, 0}, Vec3{0.3, -0.5, 0.8}})
    REQUIRE(mate(stud({5, 6, 7}, axis), socket({5, 6, 7}, axis)).has_value());
}

TEST_CASE("how far off a stud may be", "[mate]") {
  REQUIRE(mate(stud({1, 24, 0}), socket({0, 24, 0})).has_value());        // 1 LDU sideways: still seated
  REQUIRE_FALSE(mate(stud({3, 24, 0}), socket({0, 24, 0})).has_value());  // 3 LDU: beside the socket
  REQUIRE(mate(stud({0, 26, 0}), socket({0, 24, 0})).has_value());        // half pressed in: 2 LDU engaged
  REQUIRE_FALSE(mate(stud({0, 27.5, 0}), socket({0, 24, 0})).has_value()); // barely touching
  REQUIRE_FALSE(mate(stud({0, 24, 0}, {0.2, -1, 0}), socket({0, 24, 0})).has_value());  // tilted 11 degrees
  REQUIRE_FALSE(mate(stud({0, 24, 0}, {1, 0, 0}), socket({0, 24, 0})).has_value());     // across it
}

TEST_CASE("a closed end blocks entry", "[mate]") {
  // The socket opens downward at y=24 and is closed 4 LDU up. A stud pointing down into it from
  // above would have to pass through the closed end.
  REQUIRE_FALSE(mate(stud({0, 20, 0}, {0, 1, 0}), socket({0, 24, 0})).has_value());
  // A long shaft cannot go deeper than a blind hole.
  const Connector shaft = cyl(Gender::Male, {0, 24, 0}, kUp, {{'R', 6, 0, 20}});
  REQUIRE_FALSE(mate(shaft, socket({0, 24, 0})).has_value());
  // ...but its tip can sit in it.
  const Connector tip = cyl(Gender::Male, {0, 40, 0}, kUp, {{'R', 6, 0, 20}});
  REQUIRE(mate(tip, socket({0, 24, 0})).has_value());
}

TEST_CASE("a pin goes through a hole from either side and turns and slides", "[mate]") {
  const Connector hole = pinHole({0, 0, 0}, {1, 0, 0});  // x from 0 to 20
  for (Vec3 axis : {Vec3{1, 0, 0}, Vec3{-1, 0, 0}}) {
    const auto m = mate(pin({0, 0, 0}, axis), hole);  // collar at the hole's mouth, one half inside
    REQUIRE(m.has_value());
    REQUIRE(m->grip >= 16);
    REQUIRE((m->freedom.rotates && m->freedom.slides));
  }
  // Pushed in so the wide collar is inside the narrow bore: that does not fit.
  REQUIRE_FALSE(mate(pin({10, 0, 0}, {1, 0, 0}), hole).has_value());
}

TEST_CASE("axles: locked in an axle hole, free in a round one", "[mate]") {
  const auto locked = mate(axle({-10, 0, 0}, {1, 0, 0}, 60), axleHole({0, 0, 0}, {1, 0, 0}, 20));
  REQUIRE(locked.has_value());
  REQUIRE((!locked->freedom.rotates && locked->freedom.slides));
  const auto free = mate(axle({-10, 0, 0}, {1, 0, 0}, 60), pinHole({0, 0, 0}, {1, 0, 0}));
  REQUIRE(free.has_value());
  REQUIRE((free->freedom.rotates && free->freedom.slides));
  // A round pin shaft does not go into a cross-shaped hole.
  REQUIRE_FALSE(mate(cyl(Gender::Male, {-10, 0, 0}, {1, 0, 0}, {{'R', 6, 0, 40}}, true, true), axleHole({0, 0, 0}, {1, 0, 0}, 20)).has_value());
  // A bar does: it sits in the round core of the cross.
  REQUIRE(mate(cyl(Gender::Male, {-10, 0, 0}, {1, 0, 0}, {{'R', 4, 0, 40}}, true, true), axleHole({0, 0, 0}, {1, 0, 0}, 20)).has_value());
}

TEST_CASE("a stud also fits a square socket and a pin hole; a bar fits a hollow stud", "[mate]") {
  REQUIRE(mate(stud({0, 24, 0}), cyl(Gender::Female, {0, 24, 0}, kUp, {{'S', 6, 0, 4}})).has_value());
  REQUIRE(mate(stud({0, 0, 0}, {1, 0, 0}), pinHole({0, 0, 0}, {1, 0, 0})).has_value());  // base flush with the face: 2 LDU into the bore
  const Connector hollow = cyl(Gender::Female, {0, -4, 0}, {0, 1, 0}, {{'R', 4, 0, 4}});
  const Connector bar = cyl(Gender::Male, {0, -30, 0}, {0, 1, 0}, {{'R', 4, 0, 30}}, true, true);
  REQUIRE(mate(bar, hollow).has_value());
  REQUIRE_FALSE(mate(stud({0, -4, 0}, {0, 1, 0}), hollow).has_value());  // a stud is too wide for it
}

TEST_CASE("a bar in a clip turns and slides", "[mate]") {
  Connector clip;
  clip.kind = SnapKind::Clip;
  clip.gender = Gender::Female;
  clip.start = {0, 0, -4};
  clip.axis = {0, 0, 1};
  clip.side = {1, 0, 0};
  clip.length = 8;
  clip.radius = 4;
  clip.openStart = clip.openEnd = true;
  const Connector bar = cyl(Gender::Male, {0, 0, -20}, {0, 0, 1}, {{'R', 4, 0, 40}}, true, true, true);
  const auto m = mate(bar, clip);
  REQUIRE(m.has_value());
  REQUIRE((m->freedom.rotates && m->freedom.slides));
  REQUIRE(mate(clip, bar).has_value());
  REQUIRE_FALSE(mate(cyl(Gender::Male, {0, 0, -20}, {0, 0, 1}, {{'R', 6, 0, 40}}, true, true), clip).has_value());  // too thick
  REQUIRE_FALSE(mate(cyl(Gender::Male, {0, 0, -20}, {1, 0, 0}, {{'R', 4, 0, 40}}, true, true), clip).has_value());  // across the clip
}

TEST_CASE("hinge fingers mesh and turn", "[mate]") {
  Connector a;
  a.kind = SnapKind::Finger;
  a.gender = Gender::Female;
  a.group = "hgbrc";
  a.start = {-20, 10, 0};
  a.axis = {1, 0, 0};
  a.side = {0, 1, 0};
  a.seq = {18, 4, 18};
  a.length = 40;
  a.radius = 4;
  Connector b = a;
  b.gender = Gender::Male;
  const auto m = mate(a, b);
  REQUIRE(m.has_value());
  REQUIRE((m->freedom.rotates && !m->freedom.slides));
  Connector other = b;
  other.group = "different";
  REQUIRE_FALSE(mate(a, other).has_value());
  Connector same = a;
  REQUIRE_FALSE(mate(a, same).has_value());  // two bases
  Connector far = b;
  far.start = {30, 10, 0};
  REQUIRE_FALSE(mate(a, far).has_value());  // only 10 of 40 overlapping
}

TEST_CASE("a ball in a socket turns any way", "[mate]") {
  Connector ball;
  ball.kind = SnapKind::Generic;
  ball.gender = Gender::Male;
  ball.group = "techballjnt";
  ball.bounding = "sph 12.7";
  ball.placement = "free";
  ball.radius = 12.7;
  ball.start = {1, 2, 3};
  ball.axis = {0, -1, 0};
  ball.side = {1, 0, 0};
  Connector cup = ball;
  cup.gender = Gender::Female;
  cup.axis = {1, 0, 0};
  cup.side = {0, 1, 0};
  const auto m = mate(ball, cup);
  REQUIRE(m.has_value());
  REQUIRE(m->freedom.ball);
  cup.start = {1, 2, 9};
  REQUIRE_FALSE(mate(ball, cup).has_value());
  cup.start = {1, 2, 3};
  cup.group = "towball";
  REQUIRE_FALSE(mate(ball, cup).has_value());
}

TEST_CASE("mates between two pieces combine into one joint", "[mate][combine]") {
  const Freedom studA{true, false, false, {0, 0, 0}, {0, -1, 0}};
  const Freedom studB{true, false, false, {20, 0, 0}, {0, -1, 0}};
  REQUIRE(combine({studA}).kind == JointKind::Revolute);
  REQUIRE(combine({studA, studB}).kind == JointKind::Fixed);  // two studs: nothing can turn
  REQUIRE(combine({studA, studA}).kind == JointKind::Revolute);

  const Freedom holeA{true, true, false, {0, 0, 0}, {1, 0, 0}};
  const Freedom holeB{true, true, false, {40, 0, 0}, {-1, 0, 0}};  // same line, seen the other way
  REQUIRE(combine({holeA}).kind == JointKind::Cylindrical);
  REQUIRE(combine({holeA, holeB}).kind == JointKind::Cylindrical);
  const Freedom noSlide{true, false, false, {10, 0, 0}, {1, 0, 0}};
  REQUIRE(combine({holeA, noSlide}).kind == JointKind::Revolute);

  const Freedom keyed{false, true, false, {0, 0, 0}, {1, 0, 0}};
  REQUIRE(combine({keyed}).kind == JointKind::Prismatic);
  REQUIRE(combine({keyed, holeA}).kind == JointKind::Prismatic);
  const Freedom keyedAcross{false, true, false, {0, 0, 0}, {0, 0, 1}};
  REQUIRE(combine({keyed, keyedAcross}).kind == JointKind::Fixed);

  const Freedom ball{false, false, true, {0, 0, 0}, {0, -1, 0}};
  const Freedom ball2{false, false, true, {0, 0, 30}, {0, -1, 0}};
  REQUIRE(combine({ball}).kind == JointKind::Spherical);
  REQUIRE(combine({ball, ball}).kind == JointKind::Spherical);
  REQUIRE(combine({ball, ball2}).kind == JointKind::Revolute);  // two balls: turns about the line through them
  REQUIRE(combine({ball, studA}).kind == JointKind::Revolute);  // the stud's axis passes through the ball
  REQUIRE(combine({ball2, studA}).kind == JointKind::Fixed);    // it does not

  const Freedom fixed{false, false, false, {0, 0, 0}, {0, -1, 0}};
  REQUIRE(combine({fixed, holeA}).kind == JointKind::Fixed);
}

TEST_CASE("a mirrored connector still mates", "[mate][focus]") {
  const Xform mirror{Mat3{{-1, 0, 0, 0, 1, 0, 0, 0, 1}}, {7, 0, 0}};
  REQUIRE(mate(transformed(stud({0, 24, 0}), mirror), transformed(socket({0, 24, 0}), mirror)).has_value());
}

namespace {
Connector finger(Gender first, std::vector<double> seq, Vec3 centre, Vec3 axis = {1, 0, 0}) {
  Connector c;
  c.kind = SnapKind::Finger;
  c.gender = first;
  c.axis = normalized(axis);
  c.side = {0, 1, 0};
  for (double w : seq) c.length += w;
  c.seq = std::move(seq);
  c.radius = 4;
  c.start = centre - c.axis * (c.length / 2);
  return c;
}
}  // namespace

TEST_CASE("hinge fingers mate when one's fingers sit in the other's gaps", "[mate][fingers]") {
  // A base with two fingers and a gap between them, and a stick whose one finger fills the gap:
  // both are written "male first", which says what the sequence starts with, not which half it is.
  const Connector base = finger(Gender::Male, {6, 4, 6}, {0, 0, 0});
  const Connector stick = finger(Gender::Male, {4}, {0, 0, 0});
  const auto m = mate(base, stick);
  REQUIRE(m.has_value());
  REQUIRE((m->freedom.rotates && !m->freedom.slides));
  REQUIRE(mate(stick, base).has_value());
  REQUIRE(mate(base, finger(Gender::Male, {4}, {0, 0, 0}, {-1, 0, 0})).has_value());  // seen from the other end
  REQUIRE_FALSE(mate(base, finger(Gender::Male, {4}, {5, 0, 0})).has_value());        // on top of a finger
  REQUIRE_FALSE(mate(base, finger(Gender::Male, {6, 4, 6}, {0, 0, 0})).has_value());  // two bases
  // Gap-first and finger-first halves of the same pattern interleave.
  REQUIRE(mate(finger(Gender::Female, {18, 4, 18}, {0, 0, 0}), finger(Gender::Male, {18, 4, 18}, {0, 0, 0})).has_value());
}

TEST_CASE("axes a few degrees apart still mate; real files round their angles", "[mate]") {
  const double a = 2.5 * 3.14159265358979 / 180;
  REQUIRE(mate(stud({0, 24, 0}, {std::sin(a), -std::cos(a), 0}), socket({0, 24, 0})).has_value());
  const double b = 6 * 3.14159265358979 / 180;
  REQUIRE_FALSE(mate(stud({0, 24, 0}, {std::sin(b), -std::cos(b), 0}), socket({0, 24, 0})).has_value());
}

TEST_CASE("a tyre sits on a rim of about its bore and does not turn on it", "[mate][seats]") {
  auto seat = [](Gender g, double radius, double width, Vec3 centre) {
    return cyl(g, centre - Vec3{0, 0, width / 2}, {0, 0, 1}, {{'T', radius, 0, width}}, true, true);
  };
  const auto m = mate(seat(Gender::Female, 13.85, 16, {0, 0, 0}), seat(Gender::Male, 12.5, 20, {0, 0, 0}));
  REQUIRE(m.has_value());
  REQUIRE((!m->freedom.rotates && !m->freedom.slides));
  REQUIRE_FALSE(mate(seat(Gender::Female, 13.85, 16, {0, 0, 0}), seat(Gender::Male, 21, 20, {0, 0, 0})).has_value());  // far too big a rim
  REQUIRE_FALSE(mate(seat(Gender::Female, 13.85, 16, {0, 0, 40}), seat(Gender::Male, 12.5, 20, {0, 0, 0})).has_value());  // beside it
  // A tyre bore is not a pin hole, and a rim is not a pin.
  REQUIRE_FALSE(mate(seat(Gender::Female, 6, 16, {0, 0, 0}), cyl(Gender::Male, {0, 0, -8}, {0, 0, 1}, {{'R', 6, 0, 16}}, true, true)).has_value());
}

TEST_CASE("a measured ball is in its socket while its centre is inside the cup", "[mate][ball]") {
  Connector ball, socket;
  for (Connector* c : {&ball, &socket}) {
    c->kind = SnapKind::Generic;
    c->group = "ball";
    c->match = "size";
    c->placement = "free";
    c->bounding = "sph";
    c->radius = 8;
    c->source = Source::Override;
    c->axis = {0, -1, 0};
  }
  ball.gender = Gender::Male;
  socket.gender = Gender::Female;
  socket.start = {6.8, 0, 0};  // as far off as 42000's pushrods
  REQUIRE(mate(ball, socket));
  socket.start = {7.5, 0, 0};
  REQUIRE_FALSE(mate(ball, socket));
  // Balls whose size is not a measurement keep the tight rule.
  ball.source = socket.source = Source::Shadow;
  socket.start = {3, 0, 0};
  REQUIRE_FALSE(mate(ball, socket));
}

TEST_CASE("a lipped hole on a ridged shaft has seats, and is not a friction fit", "[mate][seats]") {
  // A driving ring on its joiner, as the shadow library has them: the joiner's ridges (10)
  // pass the ring's lips (9) to click 10 either way.
  const Vec3 x{1, 0, 0};
  const Connector joiner = cyl(Gender::Male, {-20, 0, 0}, x, {{'A', 9, 0, 9}, {'A', 10, 0, 2}, {'A', 9, 0, 8}, {'A', 10, 0, 2}, {'A', 9, 0, 8}, {'A', 10, 0, 2}, {'A', 9, 0, 9}}, true, true, true);
  const Connector ring = cyl(Gender::Female, {-20, 0, 0}, x, {{'A', 10, 0, 11}, {'L', 9, 0, 8}, {'A', 10, 0, 2}, {'L', 9, 0, 8}, {'A', 10, 0, 11}}, true, true, false);
  const auto m = mate(joiner, ring);
  REQUIRE(m.has_value());
  REQUIRE((m->freedom.slides && !m->freedom.rotates && !m->freedom.friction));
  REQUIRE(m->freedom.seatsMoveFirst);
  REQUIRE(m->freedom.seats.size() == 2);
  REQUIRE_THAT(m->freedom.seats[0], WithinAbs(-10, 0.26));
  REQUIRE_THAT(m->freedom.seats[1], WithinAbs(10, 0.26));
  REQUIRE_FALSE(mate(ring, joiner)->freedom.seatsMoveFirst);
  // A pin's own lip in a plain hole has one seat only, and grips.
  const auto pinned = mate(pin({0, 0, 0}, x), pinHole({0, 0, 0}, x));
  REQUIRE(pinned.has_value());
  REQUIRE((pinned->freedom.seats.empty() && pinned->freedom.friction));
  // An axle in a cross hole with no lips grips as before.
  const auto keyed = mate(axle({0, 0, 0}, x, 40), axleHole({10, 0, 0}, x, 20));
  REQUIRE((keyed && keyed->freedom.friction && keyed->freedom.seats.empty()));
}

TEST_CASE("each mate says how it comes apart", "[mate][release]") {
  const Vec3 x{1, 0, 0};
  // A stud lifts off along its own axis, out of the socket's opening, by its own height.
  const auto stud1 = mate(stud({0, 24, 0}), socket({0, 24, 0}));
  REQUIRE(stud1.has_value());
  REQUIRE(stud1->release.kind == ReleaseKind::Along);
  REQUIRE_THAT(stud1->release.travel, WithinAbs(4, 1e-9));
  REQUIRE(stud1->release.maleIsFirst);
  REQUIRE_FALSE(mate(socket({0, 24, 0}), stud({0, 24, 0}))->release.maleIsFirst);
  // It leaves against the way the socket runs in from its opening.
  REQUIRE_THAT(dot(stud1->release.axis, socket({0, 24, 0}).axis), WithinAbs(-1, 1e-9));
  // An axle through an open cross hole slides out either way.
  const auto shaft = mate(axle({0, 0, 0}, x, 40), axleHole({10, 0, 0}, x, 20));
  REQUIRE((shaft && shaft->release.kind == ReleaseKind::Either));
  REQUIRE_THAT(shaft->release.travel, WithinAbs(20, 1e-9));
  // A pin in a hole at one end of it: its collar cannot be dragged through the hole, so it
  // leaves the way its collar is.
  const auto pinned = mate(pin({0, 0, 0}, x), pinHole({0, 0, 0}, x));  // the hole takes the pin's +x half
  REQUIRE((pinned && pinned->release.kind == ReleaseKind::Along));
  REQUIRE_THAT(pinned->release.axis.x, WithinAbs(-1, 1e-9));
  const auto otherHalf = mate(pin({0, 0, 0}, x), pinHole({-20, 0, 0}, x));
  REQUIRE((otherHalf && otherHalf->release.kind == ReleaseKind::Along));
  REQUIRE_THAT(otherHalf->release.axis.x, WithinAbs(1, 1e-9));
}
