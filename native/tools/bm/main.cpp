// bm: the BrickMotion engine's command-line tool. Every engine feature is reachable here.
#include <cstdio>
#include <cstring>
#include <string_view>
#include <vector>
#include "bm/version.h"
#include "commands.h"

namespace {
int cmdVersion(const std::vector<std::string_view>&) {
  std::printf("bm %s\n", bm::version());
  return 0;
}

const bm::cli::Command kCommands[] = {
    {"version", "print the engine version", cmdVersion},
};

void usage(std::FILE* out) {
  std::fprintf(out, "usage: bm <command> [args]\n\ncommands:\n");
  for (const auto& c : kCommands) std::fprintf(out, "  %-10s %s\n", c.name, c.help);
}
}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    usage(stderr);
    return bm::cli::kUsage;
  }
  const std::string_view name = argv[1];
  if (name == "help" || name == "--help" || name == "-h") {
    usage(stdout);
    return 0;
  }
  const std::vector<std::string_view> args(argv + 2, argv + argc);
  for (const auto& c : kCommands)
    if (name == c.name) return c.run(args);
  std::fprintf(stderr, "bm: unknown command '%s'\n\n", argv[1]);
  usage(stderr);
  return bm::cli::kUsage;
}
