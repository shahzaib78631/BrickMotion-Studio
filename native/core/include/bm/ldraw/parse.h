#pragma once
// LDraw text format: one file, or an MPD holding several.
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>
#include "bm/math.h"

namespace bm::ldraw {

enum class Cmd : uint8_t { Ref, Line, Tri, Quad, Step, Bfc };

struct Command {
  enum class Wind : uint8_t { None, CCW, CW };
  enum class Cert : uint8_t { None, CCW, CW, NoCertify };

  Cmd type = Cmd::Step;
  int color = 16;
  Xform xf;            ///< Ref: placement of the referenced file
  std::string file;    ///< Ref: normalised name
  bool invert = false; ///< Ref: preceded by `0 BFC INVERTNEXT`
  std::string group;   ///< Ref: MLCAD BTG / LeoCAD GROUP name
  double pts[12] = {}; ///< Line (6 values), Tri (9), Quad (12)
  Wind winding = Wind::None;  ///< Bfc
  Cert cert = Cert::None;     ///< Bfc
  int8_t clip = -1;           ///< Bfc: -1 unset, 0 NOCLIP, 1 CLIP
};

struct File {
  std::string name;         ///< normalised
  std::string description;  ///< the first comment line
  std::string category;     ///< `0 !CATEGORY`
  std::vector<std::string> help;  ///< `0 !HELP` lines
  std::vector<Command> cmds;
  int skipped = 0;  ///< malformed lines that were dropped
};

/// Trims, turns '\' into '/', lower-cases (ASCII).
std::string normalizeName(std::string_view name);

/// Parses one LDraw file. Never throws on bad input: a malformed line is dropped and counted.
File parse(std::string_view text, std::string_view name = "main.ldr");

/// Splits an MPD on its `0 FILE` lines; text with none gives one file named `name`.
/// `0 !DATA` blocks (embedded images) are not files and are left out.
std::vector<File> parseMpd(std::string_view text, std::string_view name);

}  // namespace bm::ldraw
