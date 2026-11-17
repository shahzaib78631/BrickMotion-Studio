#pragma once
// LDCad shadow library: connector metadata that sits beside the LDraw library under the same
// file names (https://www.melkert.net/LDCad/tech/meta). The data is CC BY-SA 4.0.
#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <string_view>
#include <vector>
#include "bm/math.h"

namespace bm::connect {

enum class Gender : uint8_t { Male, Female };

/// One stretch of a cylinder snap: 'R' round, 'A' axle (cross), 'S' square, 'L' flexible lip.
struct Section {
  char shape = 'R';
  double radius = 0, length = 0;
};

/// Orientation (row-major, LDraw style) and position of one copy of a snap.
struct Frame {
  Mat3 r;
  Vec3 t;
};

enum class SnapKind : uint8_t { Cyl, Clip, Finger, Generic };

struct SnapDef {
  SnapKind kind = SnapKind::Cyl;
  Gender gender = Gender::Female;
  std::string id, group;          ///< lower-case
  std::vector<Frame> frames;      ///< one per grid copy
  std::vector<Section> sections;  ///< Cyl
  std::string caps = "one";       ///< Cyl: none, one, two, a, b
  bool center = false, slide = false;
  double radius = 0, length = 0;  ///< Clip, Finger
  std::vector<double> seq;        ///< Finger: widths of the fingers and gaps
  std::string bounding, match, placement;  ///< Generic, lower-case
};

/// SNAP_INCL: the snaps of another file, placed like a subfile.
struct Include {
  std::string ref;  ///< normalised file name
  std::vector<Frame> frames;
};

struct ShadowInfo {
  std::vector<SnapDef> snaps;
  std::vector<Include> includes;
  bool clearAll = false;              ///< SNAP_CLEAR: drop every inherited snap
  std::vector<std::string> clearIds;  ///< SNAP_CLEAR [id=..]: drop inherited snaps with these ids
};

/// Reads the snap metadata of one shadow file. A malformed command is skipped.
ShadowInfo parseShadow(std::string_view text);

/// The copies a `grid` parameter asks for, as offsets in the snap's own frame.
/// "C 2 1 20 0": 2 along x centred on the position, 1 along z, 20 apart. No grid: one copy.
std::vector<Vec3> gridOffsets(std::string_view grid);

/// The stretches a `secs` parameter gives: shape, radius and length of each, in order.
/// "R 8 2   R 6 16   _L 6.25 2" is a Technic pin's half. Empty if any of it is malformed.
std::vector<Section> parseSections(std::string_view secs);

/// The shadow directory (parts/, p/ like the LDraw library). Thread-safe; files are parsed
/// on first use and kept.
class ShadowLibrary {
 public:
  explicit ShadowLibrary(std::filesystem::path root);
  ~ShadowLibrary();
  ShadowLibrary(const ShadowLibrary&) = delete;
  ShadowLibrary& operator=(const ShadowLibrary&) = delete;

  /// The file's shadow info, or nullptr if it has none.
  const ShadowInfo* find(std::string_view name) const;
  size_t size() const;

 private:
  struct State;
  std::unique_ptr<State> state_;
};

}  // namespace bm::connect
