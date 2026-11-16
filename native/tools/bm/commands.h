#pragma once
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

namespace bm::cli {
/// Exit codes: 0 success, 1 failure, 2 usage error.
inline constexpr int kFailure = 1;
inline constexpr int kUsage = 2;

using Args = std::vector<std::string_view>;

struct Command {
  const char* name;
  const char* help;
  int (*run)(const Args& args);
};

int cmdLoad(const Args& args);
int cmdAudit(const Args& args);
int cmdJoints(const Args& args);
int cmdOverlaps(const Args& args);
int cmdShape(const Args& args);
int cmdMechanisms(const Args& args);

}  // namespace bm::cli
namespace bm::connect {
class ConnectorDb;
}
namespace bm::kin {
class GearDb;
}
namespace bm::cli {
/// Reads the engine's own data files (<repo>/native/data/*.json) into the two databases:
/// wheel seats, BrickNet joints, extra connectors and gear teeth. A missing file adds nothing.
void loadEngineData(const std::filesystem::path& repo, connect::ConnectorDb& connectors, kin::GearDb& gears);

/// The value after `--name`, or `fallback`. Sets `bad` when the flag is last with no value.
std::string option(const Args& args, std::string_view name, std::string fallback, bool& bad);
bool flag(const Args& args, std::string_view name);
/// BM_LDRAW_DIR, else `<repo>/public/ldraw` found by walking up from the working directory.
std::string defaultLDrawDir();
}  // namespace bm::cli
