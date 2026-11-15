#pragma once
#include <string_view>
#include <vector>

namespace bm::cli {
/// Exit codes: 0 success, 1 failure, 2 usage error.
inline constexpr int kFailure = 1;
inline constexpr int kUsage = 2;

struct Command {
  const char* name;
  const char* help;
  int (*run)(const std::vector<std::string_view>& args);
};
}  // namespace bm::cli
