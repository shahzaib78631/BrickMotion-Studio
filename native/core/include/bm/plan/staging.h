#pragma once
// Where pieces wait on the floor before they fly: bands of floor around the model (or round a
// unit's spot), packed in one of several styles, refilled window by window as pieces leave.
// The same arrangement as the web app's (src/anim/floorLayout.ts, timeline.ts), so a project
// looks the same in both. Sizes are in studs on LDraw's x/z axes.
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace bm::plan::staging {

inline constexpr double kStud = 20;        ///< LDU
inline constexpr double kFloorMargin = 2;  ///< studs of floor kept clear round the model
inline constexpr double kSideGap = 4;      ///< studs between the model's floor and a unit's spot

enum class Style { Packed, Spaced, Grid, Rows, Scattered, Showcase, Gallery, Fan, CameraFrame };
enum class Sort { Step, Colour, Part, Size, All };  ///< how waiting pieces are grouped; All: every piece is on the floor from the start
enum class Sides { FrontBack, Front, Behind, Sides, Around };
enum class Match { Fill, Nearest };  ///< bands in order, or each piece on the side of the model it is built on

/// How much more floor a style needs than tight packing.
double styleArea(Style style);
/// Names as the web app writes them ("packed", "front-back", ...); false if unknown.
bool parse(const std::string& name, Style& out);
bool parse(const std::string& name, Sort& out);
bool parse(const std::string& name, Sides& out);
bool parse(const std::string& name, Match& out);

/// A small hash in [0, 1) of a string, the same as the web's, so a layout is the same every time.
double hash01(const std::string& id, uint32_t salt = 0);

struct Item {
  uint32_t id = 0;  ///< the caller's
  std::string key;  ///< hashed for the scattered style's jitter
  int w = 1, d = 1;  ///< studs
  double group = 0;
};
/// A rectangle on the floor, in studs. `near`: which edge faces the model, so used rows are
/// pushed against it: +1 its max z (in front), -1 its min z (behind), 0 neither (a side).
struct Region {
  double x0 = 0, z0 = 0, width = 0, depth = 0;
  int near = 0;
};
struct Spot {
  double x = 0, z = 0;
};
using Positions = std::unordered_map<uint32_t, Spot>;
struct Layout {
  Positions pos;
  std::vector<uint32_t> overflow;
};
/// The model's (or a spot's) footprint, in LDU on x/z.
struct Footprint {
  double minX = 0, minZ = 0, maxX = 0, maxZ = 0;
};

/// Shelf-packs items into rows, grouped, deepest first, largest next; once one does not fit, it
/// and every later one overflow. The first is placed even when too big, so a window progresses.
Layout layoutFloor(const std::vector<Item>& items, const Region& region, double gap = 1, Style style = Style::Packed, double aspect = 1);
std::vector<Region> bandsAround(const Footprint& box, double padArea, Sides sides);
std::vector<Region> cameraFrameBands(const Footprint& box, double padArea, Sides sides, double aspect);
/// Packs the bands; with `prefer` (bandPreference), a piece spills to its next-best band only
/// when its own is full.
Layout layoutBands(const std::vector<Item>& items, const std::vector<Region>& bands, Style style, const std::unordered_map<uint32_t, std::vector<int>>* prefer, double aspect);
/// For each item, the bands ordered by how well they face where it is built (`at`, studs).
std::unordered_map<uint32_t, std::vector<int>> bandPreference(const std::vector<std::pair<uint32_t, Spot>>& at, const std::vector<Region>& bands);
/// Grows every band away from the model by `by`, keeping its edge nearest the model.
std::vector<Region> growBands(const std::vector<Region>& bands, const Footprint& box, double by, bool cameraFrame);
struct Window {
  std::vector<uint32_t> ids;  ///< in play order
  Positions pos;
};
/// Splits items (in play order) into windows that each fit the bands.
std::vector<Window> windowed(const std::vector<Item>& items, const std::vector<Region>& bands, Style style, const std::unordered_map<uint32_t, std::vector<int>>* prefer, double aspect);

}  // namespace bm::plan::staging
