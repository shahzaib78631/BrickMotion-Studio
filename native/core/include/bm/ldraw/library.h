#pragma once
// The LDraw part library on disk: finds a file by the name another file refers to it by.
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>
#include "bm/ldraw/parse.h"

namespace bm::ldraw {

enum class Finish : uint8_t { Solid, Chrome, Metal, Pearl, Rubber, Trans };

struct Color {
  int code = 0;
  std::string name;
  uint32_t rgb = 0x888888;   ///< 0xRRGGBB
  uint32_t edge = 0x333333;  ///< 0xRRGGBB
  float alpha = 1.0f;        ///< 0..1
  Finish finish = Finish::Solid;
};

/// Reads `0 !COLOUR` lines (LDConfig.ldr). Lines without a numeric CODE are ignored.
std::unordered_map<int, Color> parseColors(std::string_view ldconfig);

/// Thread-safe. Directory listings are indexed once, lower-cased, so lookups are
/// case-insensitive and never probe the filesystem. Each file is parsed once and kept.
/// Copies share the disk index and the parsed files.
class Library {
 public:
  /// `root` is the LDraw directory (the one holding parts/, p/ and LDConfig.ldr).
  /// A missing directory gives an empty library.
  explicit Library(std::filesystem::path root);

  /// Adds another directory laid out the same way (e.g. unofficial parts). Files already
  /// known keep their first location.
  void addSearchRoot(std::filesystem::path root);

  /// A library that also knows `files` (an MPD's own subfiles), which shadow disk files of
  /// the same name. This library is not changed.
  Library withInline(std::vector<File> files) const;

  /// The parsed file, or nullptr when no such file exists or it cannot be read.
  const File* find(std::string_view name) const;
  std::optional<std::filesystem::path> resolve(std::string_view name) const;
  bool isInline(std::string_view name) const;
  /// Hash of the file's text; 0 when absent.
  uint64_t contentHash(std::string_view name) const;

  const std::unordered_map<int, Color>& colors() const;

 private:
  struct Disk;
  std::shared_ptr<Disk> disk_;
  std::shared_ptr<const std::unordered_map<std::string, File>> inline_;
};

}  // namespace bm::ldraw
