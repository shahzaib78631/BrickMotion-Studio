#include <fstream>
#include <sstream>
#include "bm/connect/connectors.h"
#include "bm/kin/gears.h"
#include "commands.h"

namespace bm::cli {

void loadEngineData(const std::filesystem::path& repo, connect::ConnectorDb& connectors, kin::GearDb& gears) {
  auto read = [&](const char* name) {
    std::ifstream in(repo / "native" / "data" / name);
    std::stringstream text;
    text << in.rdbuf();
    return text.str();
  };
  connect::loadWheelSeats(read("wheel-seats.json"), connectors);
  connect::loadBricknetJoints(read("bricknet-joints.json"), connectors);
  connect::loadExtraConnectors(read("extra-connectors.json"), connectors);
  gears.load(read("gears.json"));
  gears.loadScrews(read("screws.json"));
}

}  // namespace bm::cli
