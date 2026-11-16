// bm: the BrickMotion engine's command-line tool. Every engine feature is reachable here.
#include <cstdio>
#include <cstring>
#include <string_view>
#include <vector>
#include "bm/version.h"
#include "commands.h"

namespace {
int cmdVersion(const bm::cli::Args&) {
  std::printf("bm %s\n", bm::version());
  return 0;
}

const bm::cli::Command kCommands[] = {
    {"load", "load a model file and describe it", bm::cli::cmdLoad},
    {"joints", "find every joint in a model; --why <part> explains unjoined pieces", bm::cli::cmdJoints},
    {"overlaps", "list the pieces of a model that pass through each other", bm::cli::cmdOverlaps},
    {"mechanisms", "what can move in a model: bodies, links, gear trains", bm::cli::cmdMechanisms},
    {"stability", "whether a model stands: load paths to the floor, and tipping", bm::cli::cmdStability},
    {"shape", "describe a part's collision shape (diagnostic)", bm::cli::cmdShape},
    {"audit", "load every model in a corpus manifest and write the scoreboard", bm::cli::cmdAudit},
    {"version", "print the engine version", cmdVersion},
};

void usage(std::FILE* out) {
  std::fprintf(out, "usage: bm <command> [args]\n\ncommands:\n");
  for (const auto& c : kCommands) std::fprintf(out, "  %-11s %s\n", c.name, c.help);
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
