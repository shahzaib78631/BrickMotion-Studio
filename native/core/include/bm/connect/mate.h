#pragma once
// Whether two connectors are joined, and what the joint between two pieces lets them do.
#include <optional>
#include <string>
#include <vector>
#include "bm/connect/connectors.h"

namespace bm::connect {

/// What one mate leaves free between the two pieces.
struct Freedom {
  bool rotates = false;  ///< about `axis` through `point`
  bool slides = false;   ///< along `axis`
  bool ball = false;     ///< any rotation about `point`
  Vec3 point, axis;
};

struct Mate {
  Freedom freedom;
  double grip = 0;  ///< LDU of matched engagement
};

/// Whether `a` and `b` (both in the same space) are joined. Order does not matter.
///
/// Decided by geometry, not by connector family: a male cylinder mates a female one when
/// they share an axis and the male's profile fits the female's where they overlap. Studs,
/// pins, axles and bars are all cylinders with different profiles, so one rule covers them,
/// in any orientation.
std::optional<Mate> mate(const Connector& a, const Connector& b);

/// Why `a` and `b` do not mate, in a few words ("3.2 off axis", "clash 4.0", "grip 0.4");
/// empty when they do. For diagnosing pieces that stay unjoined.
std::string whyNot(const Connector& a, const Connector& b);

/// Flexible: the two pieces are stretches of one hose, cable or string, or a part such an
/// element is attached to. It holds them together without fixing their relative pose.
enum class JointKind : uint8_t { Fixed, Revolute, Prismatic, Cylindrical, Spherical, Flexible };
inline constexpr int kJointKinds = 6;

struct Joint {
  JointKind kind = JointKind::Fixed;
  Vec3 point, axis;  ///< the line it turns about or slides along; the centre of a ball
};

/// The joint all the mates between two pieces add up to: a motion survives only if every
/// mate allows it. `mates` must not be empty.
Joint combine(const std::vector<Freedom>& mates);

const char* name(JointKind kind);

}  // namespace bm::connect
