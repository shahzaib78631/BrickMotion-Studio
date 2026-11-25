#include "bmapp/build_lanes.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <map>
#include <unordered_map>
#include <unordered_set>

#include "bmapp/session.h"

namespace bmapp {

namespace {

std::vector<LaneRun> runsOf(const BuildTimeline& t) {
  struct Seam {
    int step;
    double start, end;
  };
  std::vector<Seam> seams;
  for (const BuildFlightRow& f : t.flights) {
    if (!seams.empty() && (seams.back().step == f.step || f.start < seams.back().end)) {
      seams.back().end = std::max(seams.back().end, f.end);
    } else {
      seams.push_back({f.step, f.start, f.end});
    }
  }
  std::vector<LaneRun> runs;
  runs.reserve(seams.size());
  for (size_t i = 0; i < seams.size(); ++i) {
    const double next = i + 1 < seams.size() ? seams[i + 1].start : t.buildEnd;
    runs.push_back({i, seams[i].step, seams[i].start, seams[i].end, std::max(seams[i].end, next)});
  }
  return runs;
}

std::vector<LaneStep> stepsOf(const BuildTimeline& t) {
  std::map<int, LaneStep> byStep;
  for (size_t i = 0; i < t.flights.size(); ++i) {
    const BuildFlightRow& f = t.flights[i];
    auto [it, fresh] = byStep.try_emplace(f.step);
    LaneStep& clip = it->second;
    if (fresh) {
      clip.step = f.step;
      clip.start = f.start;
      clip.end = f.end;
    }
    clip.end = std::max(clip.end, f.end);
    clip.flights.push_back(i);
  }
  std::vector<LaneStep> steps;
  steps.reserve(byStep.size());
  for (auto& [step, clip] : byStep) steps.push_back(std::move(clip));
  std::stable_sort(steps.begin(), steps.end(), [](const LaneStep& a, const LaneStep& b) { return a.start < b.start; });
  for (size_t i = 0; i < steps.size(); ++i) {
    const double next = i + 1 < steps.size() ? steps[i + 1].start : t.duration;
    steps[i].pauseEnd = std::max(steps[i].end, next);
  }
  return steps;
}

std::vector<LaneSubmodel> submodelsOf(const BuildTimeline& t, const Session* session) {
  std::vector<LaneSubmodel> clips;
  for (const BuildSubmodelRow& row : t.submodels) {
    LaneSubmodel clip;
    clip.scheduled = true;
    clip.flight = row.flight;
    clip.depth = row.depth;
    clip.start = row.start;
    clip.attach = row.attach;
    clip.end = row.end;
    clip.path = row.path;
    clip.pieces = row.pieces;
    clips.push_back(std::move(clip));
  }
  if (!session) return clips;
  std::unordered_set<uint32_t> scheduled;
  for (const LaneSubmodel& clip : clips) {
    if (clip.depth == 0) scheduled.insert(clip.pieces.begin(), clip.pieces.end());
  }
  std::unordered_map<uint32_t, size_t> byPiece;
  for (size_t i = 0; i < t.flights.size(); ++i) byPiece.try_emplace(t.flights[i].piece, i);
  const size_t stepCount = session->stepCount();
  for (size_t step = 0; step < stepCount; ++step) {
    for (const ItemRow& item : session->stepItems(step)) {
      if (!item.submodel || item.pieces.empty()) continue;
      if (std::all_of(item.pieces.begin(), item.pieces.end(), [&](uint32_t p) { return scheduled.count(p) > 0; })) {
        continue;
      }
      double start = std::numeric_limits<double>::infinity(), end = -std::numeric_limits<double>::infinity();
      bool any = false;
      for (uint32_t piece : item.pieces) {
        auto found = byPiece.find(piece);
        if (found == byPiece.end()) continue;
        const BuildFlightRow& f = t.flights[found->second];
        start = std::min(start, f.start);
        end = std::max(end, f.end);
        any = true;
      }
      if (!any) continue;
      LaneSubmodel clip;
      clip.item = item.item;
      clip.start = start;
      clip.end = end;
      clip.path = {item.name};
      clip.pieces = item.pieces;
      clips.push_back(std::move(clip));
    }
  }
  return clips;
}

}  // namespace

BuildLanes buildLanes(const BuildTimeline& timeline, const Session* session) {
  BuildLanes lanes;
  lanes.version = timeline.version;
  lanes.runs = runsOf(timeline);
  lanes.steps = stepsOf(timeline);
  lanes.submodels = submodelsOf(timeline, session);
  for (size_t i = 0; i < timeline.flights.size(); ++i) {
    if (!timeline.flights[i].flag.empty()) lanes.diagnostics.push_back(i);
  }
  return lanes;
}

bool runAt(const BuildLanes& lanes, double seconds, size_t* run) {
  if (lanes.runs.empty()) return false;
  const auto upper = std::upper_bound(lanes.runs.begin(), lanes.runs.end(), seconds,
                                      [](double s, const LaneRun& r) { return s < r.start; });
  const size_t index = upper == lanes.runs.begin() ? 0 : size_t(upper - lanes.runs.begin()) - 1;
  if (run) *run = index;
  return true;
}

double travel(const BuildLanes& lanes, double time, double duration, bool forward) {
  if (forward) {
    for (const LaneRun& r : lanes.runs) {
      if (r.start > time + 0.02) return r.start;
    }
    return duration;
  }
  for (auto it = lanes.runs.rbegin(); it != lanes.runs.rend(); ++it) {
    if (it->start < time - 0.02) return it->start;
  }
  return 0;
}

int64_t nearestFlight(const BuildTimeline& timeline, double seconds, bool depth) {
  const std::vector<BuildFlightRow>& flights = timeline.flights;
  const auto lower = std::lower_bound(flights.begin(), flights.end(), seconds,
                                      [](const BuildFlightRow& f, double s) { return f.start < s; });
  const size_t low = size_t(lower - flights.begin());
  const size_t first = low > 8 ? low - 8 : 0;
  const size_t last = std::min(flights.size(), first + 16);
  int64_t best = -1;
  double bestGap = 0, bestOffset = 0;
  for (size_t i = first; i < last; ++i) {
    const BuildFlightRow& f = flights[i];
    if ((f.depth > 0) != depth) continue;
    const double gap = std::max({f.start - seconds, seconds - f.end, 0.0});
    const double offset = std::abs(f.start - seconds);
    if (best < 0 || gap < bestGap || (gap == bestGap && offset < bestOffset)) {
      best = int64_t(i);
      bestGap = gap;
      bestOffset = offset;
    }
  }
  return best;
}

ArrivalTarget arrivalTarget(const BuildLanes& lanes, const BuildTimeline& timeline, const Session* session,
                            double time, const PieceList& excluding) {
  ArrivalTarget target;
  size_t runIndex = 0;
  if (!session || !runAt(lanes, time, &runIndex)) return target;
  const LaneRun& run = lanes.runs[runIndex];
  if (run.step < 0 || size_t(run.step) >= session->stepCount()) return target;
  const std::vector<ItemRow> items = session->stepItems(size_t(run.step));
  std::unordered_map<uint32_t, size_t> itemOf;
  for (size_t i = 0; i < items.size(); ++i) {
    for (uint32_t piece : items[i].pieces) itemOf.try_emplace(piece, i);
  }
  const std::unordered_set<uint32_t> skip(excluding.begin(), excluding.end());
  const LaneStep* clip = nullptr;
  for (const LaneStep& s : lanes.steps) {
    if (s.step == run.step) {
      clip = &s;
      break;
    }
  }
  target.ok = true;
  target.step = run.step;
  bool hasLast = false;
  size_t lastInRun = 0;
  if (clip) {
    for (size_t index : clip->flights) {
      const BuildFlightRow& f = timeline.flights[index];
      if (f.start < run.start || f.start > run.end) continue;
      if (skip.count(f.piece)) continue;
      auto item = itemOf.find(f.piece);
      if (item == itemOf.end()) continue;
      if (f.start >= time) {
        target.before = item->second;
        target.time = f.start;
        return target;
      }
      lastInRun = item->second;
      hasLast = true;
    }
  }
  target.before = hasLast ? std::min(items.size(), lastInRun + 1) : items.size();
  target.time = run.end;
  return target;
}

LanePacking packLane(const LaneSpanList& sorted) {
  // Leaves hold each row's end; parents the earliest end below them, so finding the first free
  // row stays logarithmic even on dense builds.
  constexpr double kNone = std::numeric_limits<double>::infinity();
  std::vector<double> ends{kNone, kNone};
  size_t capacity = 1, count = 0;
  LanePacking packing;
  packing.rows.reserve(sorted.size());
  for (const LaneSpan& span : sorted) {
    const double x = span.x + 0.0001, until = span.x + span.width + 1;
    size_t leaf = 1;
    if (ends[1] <= x) {
      while (leaf < capacity) {
        leaf *= 2;
        if (ends[leaf] > x) leaf += 1;
      }
    } else {
      if (count == capacity) {
        const std::vector<double> previous = ends;
        capacity *= 2;
        ends.assign(capacity * 2, kNone);
        for (size_t row = 0; row < count; ++row) ends[capacity + row] = previous[count + row];
        for (size_t node = capacity - 1; node >= 1; --node) ends[node] = std::min(ends[node * 2], ends[node * 2 + 1]);
      }
      leaf = capacity + count;
      count += 1;
    }
    packing.rows.push_back(uint32_t(leaf - capacity));
    ends[leaf] = until;
    while (leaf > 1) {
      leaf /= 2;
      ends[leaf] = std::min(ends[leaf * 2], ends[leaf * 2 + 1]);
    }
  }
  packing.count = uint32_t(count);
  return packing;
}

}  // namespace bmapp
