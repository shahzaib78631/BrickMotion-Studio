#include "bmf/shots.h"
#include <cmath>
#include <cstdio>
#include <stdexcept>

namespace bm::film {

namespace {
constexpr double kDeg = 180 / M_PI;
const char* const kSubjects[] = {"model", "built", "unit", "piece", "point"};
const char* const kSizes[] = {"wide", "medium", "close"};
const char* const kMoves[] = {"hold", "push", "orbit", "crane", "follow", "arc-reveal"};
const char* const kEnters[] = {"cut", "blend"};

template <typename E, size_t N>
E named(const nlohmann::json& j, const char* field, const char* const (&names)[N]) {
  const std::string s = j.at(field).get<std::string>();
  for (size_t i = 0; i < N; i++)
    if (s == names[i]) return static_cast<E>(i);
  throw std::runtime_error(std::string("shot ") + field + ": unknown \"" + s + "\"");
}
}  // namespace

nlohmann::json toJson(const std::vector<Shot>& shots) {
  nlohmann::json out = nlohmann::json::array();
  for (const Shot& s : shots) {
    nlohmann::json j;
    j["id"] = s.id;
    j["start"] = s.start, j["end"] = s.end;
    j["subject"] = kSubjects[static_cast<int>(s.subject.kind)];
    if (s.subject.flight >= 0) j["flight"] = s.subject.flight;
    if (s.subject.kind == SubjectKind::Point) j["point"] = {s.subject.point.x, s.subject.point.y, s.subject.point.z};
    j["size"] = kSizes[static_cast<int>(s.size)];
    j["azimuth"] = s.azimuth * kDeg, j["elevation"] = s.elevation * kDeg;
    j["move"] = kMoves[static_cast<int>(s.move.kind)];
    j["amount"] = s.move.kind == MoveKind::Push ? s.move.amount : s.move.amount * kDeg;
    j["lensMm"] = s.lensMm;
    j["enter"] = kEnters[static_cast<int>(s.enter)];
    if (s.enter == EnterKind::Blend) j["blendSeconds"] = s.blendSeconds;
    j["origin"] = s.origin;
    j["pinned"] = s.pinned;
    out.push_back(std::move(j));
  }
  return out;
}

std::vector<Shot> shotsFromJson(const nlohmann::json& json) {
  std::vector<Shot> out;
  for (const nlohmann::json& j : json) {
    Shot s;
    s.id = j.value("id", std::string{});
    s.start = j.at("start").get<double>(), s.end = j.at("end").get<double>();
    s.subject.kind = named<SubjectKind>(j, "subject", kSubjects);
    s.subject.flight = j.value("flight", -1);
    if (j.contains("point")) s.subject.point = {j["point"][0].get<double>(), j["point"][1].get<double>(), j["point"][2].get<double>()};
    s.size = named<Size>(j, "size", kSizes);
    s.azimuth = j.at("azimuth").get<double>() / kDeg, s.elevation = j.at("elevation").get<double>() / kDeg;
    s.move.kind = named<MoveKind>(j, "move", kMoves);
    const double amount = j.value("amount", 0.0);
    s.move.amount = s.move.kind == MoveKind::Push ? amount : amount / kDeg;
    s.lensMm = j.value("lensMm", 50.0);
    s.enter = named<EnterKind>(j, "enter", kEnters);
    s.blendSeconds = j.value("blendSeconds", 0.0);
    s.origin = j.value("origin", std::string("auto"));
    s.pinned = j.value("pinned", false);
    out.push_back(std::move(s));
  }
  return out;
}

std::string shotId(const Shot& s) {
  char key[256];
  std::snprintf(key, sizeof key, "%d|%d|%.0f,%.0f,%.0f|%d|%.0f|%.0f|%.0f", static_cast<int>(s.subject.kind), s.subject.flight, s.subject.point.x, s.subject.point.y, s.subject.point.z,
                static_cast<int>(s.size), std::round(s.azimuth * kDeg), std::round(s.elevation * kDeg), std::round(s.start * 10));
  uint32_t h = 2166136261u;  // FNV-1a
  for (const char* c = key; *c; c++) h = (h ^ static_cast<unsigned char>(*c)) * 16777619u;
  char out[9];
  std::snprintf(out, sizeof out, "%08x", h);
  return out;
}

}  // namespace bm::film
