#pragma once
// Shared by the renderer's tests: small models written as LDraw text.
#include <filesystem>
#include <fstream>
#include <string>
#include <unistd.h>
#include "bm/io.h"
#include "bm/ldraw/part_cache.h"
#include "bm/model.h"

namespace bmtest {

inline bm::ldraw::Library fixtureLibrary() { return bm::ldraw::Library(std::filesystem::path(BM_FIXTURES) / "lib"); }

/// One LDraw line: `part` in `color` at (x, y, z), unturned unless a matrix is given.
inline std::string piece(const char* part, double x, double y, double z, int color = 4, const char* matrix = "1 0 0 0 1 0 0 0 1") {
  return "1 " + std::to_string(color) + " " + std::to_string(x) + " " + std::to_string(y) + " " + std::to_string(z) + " " + matrix + " " + part + "\n";
}

inline bm::Model modelFrom(const std::string& text, const bm::ldraw::Library& library) {
  static int counter = 0;
  const std::filesystem::path file = std::filesystem::temp_directory_path() / ("bmr_test_" + std::to_string(::getpid()) + "_" + std::to_string(counter++) + ".ldr");
  { std::ofstream out(file); out << text; }
  bm::Model m = bm::io::load(file, library);
  std::filesystem::remove(file);
  return m;
}

inline std::filesystem::path cacheDir() { return std::filesystem::temp_directory_path() / "bmr_test_cache"; }

}  // namespace bmtest
