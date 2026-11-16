#pragma once
// How a system can move: its freedoms, found from the equations of its links and gearings.
#include <optional>
#include <string>
#include <vector>
#include "bm/kin/system.h"

namespace bm::kin {

/// A body's rate of motion: it turns at `angular` (radians per unit) about the model origin,
/// while its point at the origin moves at `linear` (LDU per unit).
struct Twist {
  Vec3 angular, linear;
};
/// The velocity of the body's point now at `p`.
inline Vec3 velocityAt(const Twist& t, Vec3 p) { return t.linear + cross(t.angular, p); }

/// One independent way the system can move.
struct Freedom {
  std::vector<uint32_t> bodies;  ///< the bodies it moves, ascending
  std::vector<Twist> twists;     ///< one per entry of `bodies`; scaled so the fastest turns at 1 (or, if nothing turns, moves at 1)
  /// It moves one body, and whatever hangs on that body, about the one link that holds it (a
  /// free wheel, a pin spinning in its hole, a door with its handle): true of most freedoms in
  /// a model, and of none of its mechanisms.
  bool local = false;
  uint32_t link = UINT32_MAX;    ///< local: that link
};

struct Mobility {
  bool solved = true;
  std::string reason;              ///< why not, when !solved
  std::vector<Freedom> freedoms;   ///< locals first, then the rest, those moving most bodies first
  std::vector<uint8_t> moves;      ///< per body: some freedom moves it
  std::vector<uint8_t> held;       ///< per body: it is taken as standing still (the ground, and the largest body of every separate group)
  size_t solvedBodies = 0;         ///< bodies that went into the equations
};

/// Finds every freedom. Bodies hanging on a single link are freedoms by themselves and are
/// taken off first; the rest is solved group by group. Never throws.
Mobility mobility(const System& sys);

/// A body's twist in a freedom (zero if it does not move in it).
Twist twistOf(const Freedom& f, uint32_t body);

/// Turns of body `b` per turn of body `a` in a freedom. `num/den` is the same as a fraction
/// in lowest terms when it is one with a denominator up to 1000 (as any ratio through gear
/// teeth is). The sign is that of the two turning directions when the shafts are parallel,
/// positive otherwise. nullopt when `a` does not turn in it.
struct Ratio {
  int num = 0, den = 1;
  double value = 0;
  bool exact = false;  ///< num/den is the value
};
std::optional<Ratio> ratio(const Freedom& f, uint32_t bodyA, uint32_t bodyB);

/// Turns of body `b` per turn of body `a` through whatever joins them, one value for each
/// independent way the two turn together. Where a differential lies between them the answer
/// depends on what its other output does, so it is taken turning as one piece (the car on a
/// straight road): every gear carried round by a turning body turns with that body. If that
/// leaves no motion that turns both (a planetary reduction, whose ring is held), the freedoms
/// are used as they are.
std::vector<Ratio> throughRatios(const System& sys, const Mobility& mob, uint32_t bodyA, uint32_t bodyB);

}  // namespace bm::kin
