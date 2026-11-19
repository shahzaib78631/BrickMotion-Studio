#pragma once
// The shot list: what the director decided, as plain data an editor can change and save. Times
// are seconds, so a re-paced build keeps its shots; angles are relative to the model's front.
#include <string>
#include <vector>
#include <nlohmann/json.hpp>
#include "bm/math.h"

namespace bm::film {

enum class SubjectKind { Model, BuiltSoFar, Unit, Piece, Point };
struct Subject {
  SubjectKind kind = SubjectKind::BuiltSoFar;
  int flight = -1;  ///< Unit, Piece: the timeline's flight
  Vec3 point;       ///< Point
};

enum class Size { Wide, Medium, Close };
enum class MoveKind { Hold, Push, Orbit, Crane, Follow, ArcReveal };
struct Move {
  MoveKind kind = MoveKind::Hold;
  double amount = 0;  ///< Push: distance factor at the end; Orbit, Crane, ArcReveal: radians, signed
};
enum class EnterKind { Cut, Blend };

struct Shot {
  std::string id;
  double start = 0, end = 0;  ///< seconds
  Subject subject;
  Size size = Size::Wide;
  double azimuth = 0, elevation = 0;  ///< radians, from the model's front
  Move move;
  double lensMm = 50;
  EnterKind enter = EnterKind::Cut;
  double blendSeconds = 0;  ///< Blend: how long the way in from the shot before takes
  std::string origin = "auto";
  bool pinned = false;
};

/// Angles in degrees, enums by their lower-case names.
nlohmann::json toJson(const std::vector<Shot>& shots);
/// Throws std::runtime_error naming the field when a name is not one it knows.
std::vector<Shot> shotsFromJson(const nlohmann::json& json);

/// Eight hex digits from what the shot is (subject, size, angle to the degree, start to 0.1 s):
/// the same shot has the same id run after run.
std::string shotId(const Shot& shot);

}  // namespace bm::film
