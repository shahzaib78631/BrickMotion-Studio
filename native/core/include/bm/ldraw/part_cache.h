#pragma once
// Flattened parts, kept in memory and in a binary file per part so a part's LDraw text is
// read once, ever, until one of its source files changes.
#include <cstddef>
#include <filesystem>
#include <memory>
#include <string_view>
#include "bm/ldraw/mesh.h"

namespace bm::ldraw {

class PartCache {
 public:
  /// `library` must outlive the cache. `cacheDir` is created on first write; if it cannot
  /// be written the cache still works, in memory only.
  PartCache(const Library& library, std::filesystem::path cacheDir, FlattenOptions options = {});
  ~PartCache();
  PartCache(const PartCache&) = delete;
  PartCache& operator=(const PartCache&) = delete;

  /// The part's mesh (".dat" may be left off). Thread-safe; each part is built once.
  /// Looks in memory, then on disk, then flattens. A cache file is used only if it is
  /// intact and every source file it was made from is unchanged; otherwise it is rebuilt.
  /// Parts defined inline (inside a model file) and parts that do not exist are never
  /// written to disk.
  std::shared_ptr<const Mesh> get(std::string_view partName);

  struct Stats {
    size_t memoryHits = 0;  ///< served from memory
    size_t diskHits = 0;    ///< read from a valid cache file
    size_t flattened = 0;   ///< built because no cache file existed
    size_t rebuilt = 0;     ///< built because the cache file was stale or damaged
  };
  Stats stats() const;

  /// Where the command-line tool keeps its cache: ~/Library/Caches/BrickMotion/parts.
  static std::filesystem::path defaultDirectory();

 private:
  struct State;
  std::unique_ptr<State> state_;
};

}  // namespace bm::ldraw
