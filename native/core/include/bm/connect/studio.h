#pragma once
// BrickLink Studio's per-part connectivity files (<Studio>/ldraw/connectivity/<part>.conn).
// The format is not published. Only record types checked against known parts are read:
//
//   code        what                         checked on
//   0x00170003  stud grid                    3001, 3005, 3023, 6141
//   0x00000002  anti-stud grid               3001, 3005, 3700
//   0x00010002  anti-stud grid (plates)      3023, 98138, 2412b
//   0x00020000  round pin hole               3700, 32523
//   0x00030000  pin (one half, from its tip) 3673, 2780
//   0x00070000  axle                         3705, 32062
//   0x00060000  axle hole                    32474
//   0x..0006    paired hinge half            3937/3938 (0x3a/0x3b), 4592/4593, 3818/3820
//   0x..0004    paired wheel half            6015/6014 (0x60/0x61)
//
// Every other record type is skipped. These files belong to BrickLink; they are read from
// the user's own Studio installation and are not part of this repository.
#include <filesystem>
#include <memory>
#include <string_view>
#include <vector>
#include "bm/connect/connectors.h"

namespace bm::connect {

/// The connectors in one .conn file. Never throws: the walk stops at the first record it
/// cannot make sense of and returns what it read. `complete` says whether it reached the end.
std::vector<Connector> parseStudioConn(std::string_view bytes, bool* complete = nullptr);

/// The connectivity directory. Thread-safe; files are read on first use.
class StudioLibrary {
 public:
  explicit StudioLibrary(std::filesystem::path directory);  // missing: empty
  ~StudioLibrary();
  StudioLibrary(const StudioLibrary&) = delete;
  StudioLibrary& operator=(const StudioLibrary&) = delete;

  /// The part's connectors (".dat" may be left off). Never null; empty if there is no file.
  std::shared_ptr<const std::vector<Connector>> find(std::string_view partName) const;
  size_t size() const;

  /// Where Studio keeps the files on this system, or an empty path if it is not installed.
  static std::filesystem::path defaultDirectory();

 private:
  struct State;
  std::unique_ptr<State> state_;
};

}  // namespace bm::connect
