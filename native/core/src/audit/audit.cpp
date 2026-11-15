#include "bm/audit.h"

#include <algorithm>
#include <chrono>
#include <ctime>
#include <set>
#include <unordered_set>
#include "bm/io.h"

namespace bm::audit {

Row loadRow(const std::filesystem::path& file, std::string id, const ldraw::Library& library, ldraw::PartCache& cache, connect::ConnectorDb* connectors) {
  Row row;
  row.id = std::move(id);
  const auto started = std::chrono::steady_clock::now();
  try {
    const Model model = io::load(file, library, &cache);
    std::unordered_set<std::string> seen;
    for (const Piece& p : model.pieces())
      if (seen.insert(p.part).second) model.mesh(p.part, cache);
    row.pieces = static_cast<int>(model.pieces().size());
    for (const std::string& name : model.report().missing) {
      const bool part = name.size() > 4 && name.compare(name.size() - 4, 4, ".dat") == 0;
      if (part) row.unknownParts.push_back(name.substr(0, name.size() - 4));
      else row.missingSubmodels.push_back(name);
    }
    std::sort(row.unknownParts.begin(), row.unknownParts.end());
    std::sort(row.missingSubmodels.begin(), row.missingSubmodels.end());
    row.loadMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    if (connectors) {
      const auto graphStart = std::chrono::steady_clock::now();
      const connect::Graph g = connect::buildGraph(model, *connectors);
      row.hasGraph = true;
      row.joined = static_cast<int>(g.largestGroup);
      row.groups = static_cast<int>(g.groups);
      row.attached = static_cast<int>(g.attached);
      row.bodies = static_cast<int>(g.bodies);
      row.withoutConnectors = static_cast<int>(g.withoutConnectors);
      for (const connect::Connection& c : g.connections) row.joints[static_cast<int>(c.joint.kind)]++;
      std::vector<uint8_t> connected(model.pieces().size(), 0);
      for (const connect::Connection& c : g.connections) connected[c.a] = connected[c.b] = 1;
      row.segments = static_cast<int>(g.segments);
      for (size_t i = 0; i < model.pieces().size(); i++) {
        if (!g.isSegment[i] && connected[i]) row.partsAttached++;
        if (connected[i] || g.isSegment[i]) continue;
        (g.hasConnectors[i] ? row.unmatedParts : row.noConnectorParts)[model.pieces()[i].part]++;
      }
      row.graphMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - graphStart).count();
    }
    row.ok = true;
    return row;
  } catch (const std::exception& e) {
    row.error = e.what();
    if (row.error.empty()) row.error = "error";
  } catch (...) {
    row.error = "unknown error";
  }
  row.loadMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  return row;  // failed
}

nlohmann::json toJson(const Row& row) {
  nlohmann::json j;
  j["id"] = row.id;
  j["engine"] = "native";
  j["ok"] = row.ok;
  j["error"] = row.ok ? nlohmann::json(nullptr) : nlohmann::json(row.error);
  j["pieces"] = row.pieces;
  j["unknownParts"] = row.unknownParts;
  j["missingSubmodels"] = row.missingSubmodels;
  j["loadMs"] = row.loadMs;
  if (row.hasGraph) {
    j["joined"] = row.joined;
    j["groups"] = row.groups;
    j["attached"] = row.attached;
    j["bodies"] = row.bodies;
    j["withoutConnectors"] = row.withoutConnectors;
    j["segments"] = row.segments;
    j["partsAttached"] = row.partsAttached;
    for (int k = 0; k < 5; k++) j["joints"][connect::name(static_cast<connect::JointKind>(k))] = row.joints[k];
    j["graphMs"] = row.graphMs;
  }
  return j;
}

nlohmann::json summarize(const std::vector<Row>& rows) {
  long pieces = 0, unknown = 0, missingSubs = 0, failed = 0;
  long joined = 0, attached = 0, groups = 0, bodies = 0, withoutConnectors = 0, fullyJoined = 0, graphed = 0, graphedPieces = 0;
  long joints[5] = {};
  long segments = 0, partsAttached = 0;
  std::vector<double> graphTimes;
  std::set<std::string> distinct;
  std::vector<double> times;
  for (const Row& r : rows) {
    if (!r.ok) {
      failed++;
      continue;
    }
    pieces += r.pieces;
    unknown += static_cast<long>(r.unknownParts.size());
    missingSubs += static_cast<long>(r.missingSubmodels.size());
    distinct.insert(r.unknownParts.begin(), r.unknownParts.end());
    times.push_back(r.loadMs);
    if (!r.hasGraph) continue;
    graphed++;
    graphedPieces += r.pieces;
    joined += r.joined;
    attached += r.attached;
    groups += r.groups;
    bodies += r.bodies;
    withoutConnectors += r.withoutConnectors;
    segments += r.segments;
    partsAttached += r.partsAttached;
    if (r.pieces > 0 && r.groups == 1) fullyJoined++;
    for (int k = 0; k < 5; k++) joints[k] += r.joints[k];
    graphTimes.push_back(r.graphMs);
  }
  std::sort(times.begin(), times.end());
  auto quantile = [&](double q) -> nlohmann::json {
    if (times.empty()) return nullptr;
    return times[std::min(times.size() - 1, static_cast<size_t>(q * static_cast<double>(times.size())))];
  };
  char date[16] = "";
  const std::time_t now = std::time(nullptr);
  std::strftime(date, sizeof date, "%Y-%m-%d", std::gmtime(&now));
  nlohmann::json s;
  s["engine"] = "native";
  s["date"] = date;
  s["models"] = rows.size();
  s["failed"] = failed;
  s["totals"] = {{"pieces", pieces}, {"unknownParts", unknown}, {"distinctUnknownParts", distinct.size()}, {"missingSubmodels", missingSubs}};
  s["p50"] = {{"loadMs", quantile(0.5)}};
  s["p95"] = {{"loadMs", quantile(0.95)}};
  if (graphed > 0) {
    const double total = static_cast<double>(std::max(1L, graphedPieces));
    nlohmann::json& t = s["totals"];
    t["joined"] = joined;
    t["attached"] = attached;
    t["groups"] = groups;
    t["bodies"] = bodies;
    t["withoutConnectors"] = withoutConnectors;
    t["fullyJoinedModels"] = fullyJoined;
    t["joinedPercent"] = 100.0 * static_cast<double>(joined) / total;
    t["attachedPercent"] = 100.0 * static_cast<double>(attached) / total;
    t["segments"] = segments;
    // Of the pieces that are real parts (not hose or cable segments): how many are joined.
    t["partsAttachedPercent"] = 100.0 * static_cast<double>(partsAttached) / static_cast<double>(std::max(1L, graphedPieces - segments));
    for (int k = 0; k < 5; k++) t["joints"][connect::name(static_cast<connect::JointKind>(k))] = joints[k];
    std::sort(graphTimes.begin(), graphTimes.end());
    s["p50"]["graphMs"] = graphTimes[graphTimes.size() / 2];
    s["p95"]["graphMs"] = graphTimes[std::min(graphTimes.size() - 1, static_cast<size_t>(0.95 * static_cast<double>(graphTimes.size())))];
  }
  return s;
}

}  // namespace bm::audit
