#include "bm/audit.h"
#include "bm/connect/infer.h"
#include "bm/kin/mobility.h"
#include "bm/plan/certify.h"
#include "bm/plan/plan.h"
#include "bm/plan/timeline.h"
#include "bm/stable/stability.h"

#include <algorithm>
#include <chrono>
#include <ctime>
#include <set>
#include <unordered_set>
#include "bm/io.h"

namespace bm::audit {

Row loadRow(const std::filesystem::path& file, std::string id, const ldraw::Library& library, ldraw::PartCache& cache, connect::ConnectorDb* connectors, collide::ShapeCache* shapes, const kin::GearDb* gears, double planBudget, bool kinematics, bool correct, plan::FlightShape shape) {
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
      const connect::Graph g = connect::buildGraph(model, *connectors, gears);
      row.hasGraph = true;
      row.joined = static_cast<int>(g.largestGroup);
      row.groups = static_cast<int>(g.groups);
      row.attached = static_cast<int>(g.attached);
      row.bodies = static_cast<int>(g.bodies);
      row.meshes = static_cast<int>(g.meshes.size());
      row.withoutConnectors = static_cast<int>(g.withoutConnectors);
      for (const connect::Connection& c : g.connections) row.joints[static_cast<int>(c.joint.kind)]++;
      std::vector<uint8_t> connected(model.pieces().size(), 0);
      for (const connect::Connection& c : g.connections) connected[c.a] = connected[c.b] = 1;
      row.segments = static_cast<int>(g.segments);
      row.partsJoined = static_cast<int>(g.largestGroupParts);
      for (size_t i = 0; i < model.pieces().size(); i++) {
        if (!g.isSegment[i] && connected[i]) row.partsAttached++;
        if (connected[i] || g.isSegment[i]) continue;
        (g.hasConnectors[i] ? row.unmatedParts : row.noConnectorParts)[model.pieces()[i].part]++;
      }
      row.graphMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - graphStart).count();
      {
        const auto stableStart = std::chrono::steady_clock::now();
        const stable::Result st = stable::check(model, g, cache);
        row.stands = st.stands;
        row.unsupportedPieces = static_cast<int>(st.unsupported.size());
        row.tippingGroups = static_cast<int>(st.tipping.size());
        row.massGrams = st.mass;
        row.stableMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - stableStart).count();
      }
      if (shapes) {
        const auto collideStart = std::chrono::steady_clock::now();
        const collide::Report report = collide::findOverlaps(model, g, cache, *shapes);
        row.hasCollision = true;
        std::unordered_set<uint32_t> involved;
        for (const collide::Overlap& o : report.overlaps) {
          if (o.duplicate) {
            row.duplicates++;
            continue;
          }
          row.overlaps++;
          const bool joined = std::any_of(g.connections.begin(), g.connections.end(), [&](const connect::Connection& c) { return c.a == o.a && c.b == o.b; });
          row.overlapsJoined += joined;
          involved.insert(o.a);
          involved.insert(o.b);
          const std::string& pa = model.pieces()[o.a].part;
          const std::string& pb = model.pieces()[o.b].part;
          row.overlapPairs[(pa <= pb ? pa + " + " + pb : pb + " + " + pa) + (joined ? "  [joined]" : "")]++;
        }
        row.overlapPieces = static_cast<int>(involved.size());
        row.collisionMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - collideStart).count();
        if (planBudget > 0) {
          plan::Options options;
          options.budgetSeconds = planBudget;
          options.correctPlacements = correct;
          // The build is planned as bm plan plans it: pieces set in place first when asked, and
          // joints inferred for pieces the connectors join to nothing. The graph's own numbers
          // above are the connectors' alone, on the model as the file has it.
          Model pm = model;
          connect::Graph pg;
          connect::Inferred inferred;
          std::vector<connect::Correction> corrections;
          const plan::Plan built = plan::planModel(pm, pg, *connectors, gears, cache, *shapes, options, &inferred, &corrections);
          row.corrections = static_cast<int>(corrections.size());
          for (const connect::Correction& c : corrections) row.correctionsApplied += c.applied ? 1 : 0;
          row.inferredRelaxed = static_cast<int>(inferred.relaxed), row.inferredDocumented = static_cast<int>(inferred.documented);
          row.inferredDropped = static_cast<int>(inferred.dropped);
          const auto certifyStart = std::chrono::steady_clock::now();
          const plan::Certificate cert = plan::certify(pm, pg, cache, *shapes, built);
          row.planned = true;
          row.planComplete = built.complete;
          row.planMs = built.planMs;
          row.certifyMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - certifyStart).count();
          row.moves = cert.total;
          row.certifiedMoves = cert.certified;
          row.planFlagged = cert.flagged;
          row.unjoinedMoves = cert.unjoined;
          row.buildFloating = cert.floating;
          row.buildCrossings = cert.crossings;
          row.offAxis = cert.offAxis;
          row.planOk = cert.ok();
          {
            plan::Style style;
            style.shape = shape;
            const plan::Timeline played = plan::buildTimeline(pm, cache, built, style);
            const plan::PlayCheck play = plan::certifyPlay(pm, pg, cache, *shapes, built, played);
            row.playedCrossings = play.crossings, row.playedStrict = play.strictCrossings, row.playedUnder = play.underFloor;
            for (const plan::PlayCheck::Strict& c : play.strict)
            {
              (c.leg == plan::PlayCheck::Leg::Transit ? row.playedStrictTransit : c.leg == plan::PlayCheck::Leg::Path ? row.playedStrictPath : row.playedStrictSeat)++;
              if (c.leg != plan::PlayCheck::Leg::Transit) continue;
              const plan::Flight& f = played.flights[c.flight];
              (c.at < f.startFrame + f.liftAt ? row.transitFloor : f.fallback ? row.transitFallback : row.transitMissed)++;  // on the floor; no way found; the builder's check let it by
            }
            for (const plan::Flight& f : played.flights)
              if (f.fallback) (f.fallbackAt == 1 ? row.fallbackNoJoin : row.fallbackAcross)++, row.fallbackBelow += f.exitsBelow ? 1 : 0;
            row.playedUpward = play.upward, row.playedInversions = play.inversions;
            for (const plan::Move& m : built.moves)
              if (m.unit.pieces.size() > 1 && m.source != plan::UnitSource::Authored) {
                row.unitPieces += static_cast<int>(m.unit.pieces.size());
                row.largestUnit = std::max(row.largestUnit, static_cast<int>(m.unit.pieces.size()));
              }
          }
          std::vector<const plan::Plan*> todo{&built};
          while (!todo.empty()) {
            const plan::Plan* p = todo.back();
            todo.pop_back();
            for (const plan::Move& m : p->moves)
              if (m.flag != plan::Flag::None) row.planFlags[plan::name(m.flag)]++;
            for (const plan::Plan& sub : p->subs) todo.push_back(&sub);
          }
        }
        if (!kinematics) {
          row.ok = true;
          return row;
        }
        const auto kinStart = std::chrono::steady_clock::now();
        const kin::System sys = kin::buildSystem(model, g, &cache, shapes);
        const kin::Mobility mob = kin::mobility(sys);
        row.hasKinematics = true;
        row.movingBodies = static_cast<int>(sys.bodies);
        row.links = static_cast<int>(sys.links.size());
        row.solved = mob.solved;
        row.freedoms = static_cast<int>(mob.freedoms.size());
        for (const kin::Freedom& f : mob.freedoms) row.mechanisms += !f.local;
        row.kinMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - kinStart).count();
      }
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
    j["partsJoined"] = row.partsJoined;
    for (int k = 0; k < connect::kJointKinds; k++) j["joints"][connect::name(static_cast<connect::JointKind>(k))] = row.joints[k];
    j["meshes"] = row.meshes;
    j["graphMs"] = row.graphMs;
    j["stands"] = row.stands;
    j["unsupportedPieces"] = row.unsupportedPieces;
    j["tippingGroups"] = row.tippingGroups;
    j["massGrams"] = row.massGrams;
    j["stableMs"] = row.stableMs;
  }
  if (row.hasCollision) {
    j["overlaps"] = row.overlaps;
    j["overlapPieces"] = row.overlapPieces;
    j["overlapsJoined"] = row.overlapsJoined;
    j["duplicates"] = row.duplicates;
    j["collisionMs"] = row.collisionMs;
  }
  if (row.planned) {
    j["planOk"] = row.planOk;
    j["planComplete"] = row.planComplete;
    j["planMs"] = row.planMs;
    j["certifyMs"] = row.certifyMs;
    j["moves"] = row.moves;
    j["certifiedMoves"] = row.certifiedMoves;
    j["planFlagged"] = row.planFlagged;
    j["unjoinedMoves"] = row.unjoinedMoves;
    j["inferred"] = {row.inferredDocumented, row.inferredRelaxed, row.inferredDropped};  // in documented seats; set in place; taken out again
    j["corrections"] = {row.corrections, row.correctionsApplied};  // pieces a little off what holds them; of them, set in place  // pieces joined once set in place; of them, taken out again
    j["buildFloating"] = row.buildFloating;
    j["buildCrossings"] = row.buildCrossings;
    j["offAxis"] = row.offAxis;
    j["playedCrossings"] = row.playedCrossings;
    j["playedStrict"] = row.playedStrict;
    j["playedStrictLegs"] = {row.playedStrictTransit, row.playedStrictPath, row.playedStrictSeat};
    j["transitKinds"] = {row.transitFloor, row.transitFallback, row.transitMissed};
    j["fallbacks"] = {row.fallbackNoJoin, row.fallbackAcross, row.fallbackBelow};  // flagged flights: no join, no way across; of them going in from below
    j["playedUnder"] = row.playedUnder;
    j["playedUpward"] = row.playedUpward;
    j["playedInversions"] = row.playedInversions;
    j["unitPieces"] = row.unitPieces;
    j["largestUnit"] = row.largestUnit;
    j["planFlags"] = row.planFlags;
  }
  if (row.hasKinematics) {
    j["movingBodies"] = row.movingBodies;
    j["links"] = row.links;
    j["freedoms"] = row.freedoms;
    j["mechanisms"] = row.mechanisms;
    j["solved"] = row.solved;
    j["kinMs"] = row.kinMs;
  }
  return j;
}

nlohmann::json summarize(const std::vector<Row>& rows) {
  long pieces = 0, unknown = 0, missingSubs = 0, failed = 0;
  long joined = 0, attached = 0, groups = 0, bodies = 0, withoutConnectors = 0, fullyJoined = 0, graphed = 0, graphedPieces = 0;
  long joints[connect::kJointKinds] = {};
  long segments = 0, partsAttached = 0, partsJoined = 0;
  std::vector<double> graphTimes, collisionTimes;
  long overlaps = 0, overlapsJoined = 0, overlapPieces = 0, duplicates = 0, cleanModels = 0, collided = 0;
  long standing = 0, unsupportedPieces = 0, tippingModels = 0;
  long plannedModels = 0, planOk = 0, planIncomplete = 0, planMoves = 0, planCertified = 0, planFlagged = 0, planUnjoined = 0, planFloating = 0, planCrossings = 0, planOffAxis = 0, playedCrossings = 0, playedStrict = 0, strictLeg[3] = {0, 0, 0}, playedUnder = 0, playedUpward = 0, playedInversions = 0, unitPieces = 0;
  std::vector<double> planTimes;
  long kinModels = 0, movingBodies = 0, freedoms = 0, mechanisms = 0, unsolved = 0, withMechanisms = 0;
  std::vector<double> kinTimes;
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
    partsJoined += r.partsJoined;
    if (r.pieces > 0 && r.groups == 1) fullyJoined++;
    for (int k = 0; k < connect::kJointKinds; k++) joints[k] += r.joints[k];
    graphTimes.push_back(r.graphMs);
    standing += r.stands;
    unsupportedPieces += r.unsupportedPieces;
    tippingModels += r.tippingGroups > 0;
    if (!r.hasCollision) continue;
    collided++;
    overlaps += r.overlaps;
    overlapsJoined += r.overlapsJoined;
    overlapPieces += r.overlapPieces;
    duplicates += r.duplicates;
    if (r.overlaps == 0) cleanModels++;
    collisionTimes.push_back(r.collisionMs);
    if (r.planned) {
      plannedModels++;
      planOk += r.planOk;
      planIncomplete += !r.planComplete;
      planMoves += r.moves;
      planCertified += r.certifiedMoves;
      planFlagged += r.planFlagged;
      planUnjoined += r.unjoinedMoves;
      planFloating += r.buildFloating;
      planCrossings += r.buildCrossings;
      planOffAxis += r.offAxis;
      playedCrossings += r.playedCrossings, playedStrict += r.playedStrict, playedUnder += r.playedUnder;
      strictLeg[0] += r.playedStrictTransit, strictLeg[1] += r.playedStrictPath, strictLeg[2] += r.playedStrictSeat;
      playedUpward += r.playedUpward, playedInversions += r.playedInversions, unitPieces += r.unitPieces;
      planTimes.push_back(r.planMs);
    }
    if (!r.hasKinematics) continue;
    kinModels++;
    movingBodies += r.movingBodies;
    freedoms += r.freedoms;
    mechanisms += r.mechanisms;
    unsolved += !r.solved;
    if (r.mechanisms > 0) withMechanisms++;
    kinTimes.push_back(r.kinMs);
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
    t["partsJoinedPercent"] = 100.0 * static_cast<double>(partsJoined) / static_cast<double>(std::max(1L, graphedPieces - segments));
    t["partsAttachedPercent"] = 100.0 * static_cast<double>(partsAttached) / static_cast<double>(std::max(1L, graphedPieces - segments));
    for (int k = 0; k < connect::kJointKinds; k++) t["joints"][connect::name(static_cast<connect::JointKind>(k))] = joints[k];
    t["standingModels"] = standing;
    t["unsupportedPieces"] = unsupportedPieces;
    t["tippingModels"] = tippingModels;
    std::sort(graphTimes.begin(), graphTimes.end());
    s["p50"]["graphMs"] = graphTimes[graphTimes.size() / 2];
    s["p95"]["graphMs"] = graphTimes[std::min(graphTimes.size() - 1, static_cast<size_t>(0.95 * static_cast<double>(graphTimes.size())))];
  }
  if (collided > 0) {
    nlohmann::json& t = s["totals"];
    t["overlaps"] = overlaps;
    t["overlapsJoined"] = overlapsJoined;
    t["overlapPieces"] = overlapPieces;
    t["overlapPiecesPercent"] = 100.0 * static_cast<double>(overlapPieces) / static_cast<double>(std::max(1L, graphedPieces - segments));
    t["duplicates"] = duplicates;
    t["modelsWithoutOverlaps"] = cleanModels;
    std::sort(collisionTimes.begin(), collisionTimes.end());
    s["p50"]["collisionMs"] = collisionTimes[collisionTimes.size() / 2];
    s["p95"]["collisionMs"] = collisionTimes[std::min(collisionTimes.size() - 1, static_cast<size_t>(0.95 * static_cast<double>(collisionTimes.size())))];
  }
  if (plannedModels > 0) {
    nlohmann::json& t = s["totals"];
    t["planned"] = plannedModels;
    t["planOk"] = planOk;
    t["planIncomplete"] = planIncomplete;
    t["moves"] = planMoves;
    t["certifiedMoves"] = planCertified;
    t["certifiedPercent"] = 100.0 * static_cast<double>(planCertified) / static_cast<double>(std::max(1L, planMoves));
    t["planFlagged"] = planFlagged;
    t["unjoinedMoves"] = planUnjoined;
    t["buildFloating"] = planFloating;
    t["buildCrossings"] = planCrossings;
    t["offAxis"] = planOffAxis;
    t["playedCrossings"] = playedCrossings;
    t["playedStrict"] = playedStrict;
    t["playedStrictLegs"] = {strictLeg[0], strictLeg[1], strictLeg[2]};
    t["playedUnder"] = playedUnder;
    t["playedUpward"] = playedUpward;
    t["playedInversions"] = playedInversions;
    t["unitPieces"] = unitPieces;
    std::sort(planTimes.begin(), planTimes.end());
    s["p50"]["planMs"] = planTimes[planTimes.size() / 2];
    s["p95"]["planMs"] = planTimes[std::min(planTimes.size() - 1, static_cast<size_t>(0.95 * static_cast<double>(planTimes.size())))];
    s["max"]["planMs"] = planTimes.back();
  }
  if (kinModels > 0) {
    nlohmann::json& t = s["totals"];
    t["movingBodies"] = movingBodies;
    t["freedoms"] = freedoms;
    t["mechanisms"] = mechanisms;
    t["modelsWithMechanisms"] = withMechanisms;
    t["unsolvedModels"] = unsolved;
    std::sort(kinTimes.begin(), kinTimes.end());
    s["p50"]["kinMs"] = kinTimes[kinTimes.size() / 2];
    s["p95"]["kinMs"] = kinTimes[std::min(kinTimes.size() - 1, static_cast<size_t>(0.95 * static_cast<double>(kinTimes.size())))];
    s["max"]["kinMs"] = kinTimes.back();
  }
  return s;
}

}  // namespace bm::audit
