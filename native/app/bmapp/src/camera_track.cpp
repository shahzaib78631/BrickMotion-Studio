// A port of the web's Camera track (src/anim/cameraTrack: sample.ts, curves.ts, orbit.ts,
// presets.ts, ops.ts), so a project's camera moves play and export the same in both apps.
#include "camera_track.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <random>
#include <map>
#include <memory>
#include <set>

namespace bmapp::camtrack {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kMinElevation = -85, kMaxElevation = 89, kMinDistance = 0.5;

double rad(double degrees) { return degrees * kPi / 180; }
double deg(double radians) { return radians * 180 / kPi; }
double clamp01(double v) { return std::clamp(v, 0.0, 1.0); }
double lerp(double a, double b, double u) { return a + (b - a) * u; }
bm::Vec3 lerp(bm::Vec3 a, bm::Vec3 b, double u) { return a + (b - a) * u; }
bm::Vec3 centre(const bm::Box& b) { return (b.min + b.max) * 0.5; }

double number(const Json& o, const char* key, double fallback) {
  if (!o.is_object()) return fallback;
  const auto v = o.find(key);
  if (v == o.end() || !v->is_number()) return fallback;
  const double d = v->get<double>();
  return std::isfinite(d) ? d : fallback;
}
std::string text(const Json& o, const char* key, const std::string& fallback = {}) {
  if (!o.is_object()) return fallback;
  const auto v = o.find(key);
  return v != o.end() && v->is_string() ? v->get<std::string>() : fallback;
}
bool flag(const Json& o, const char* key, bool fallback = false) {
  if (!o.is_object()) return fallback;
  const auto v = o.find(key);
  return v != o.end() && v->is_boolean() ? v->get<bool>() : fallback;
}
bm::Vec3 xyz(const Json& o, const char* key) {
  if (!o.is_object()) return {};
  const auto v = o.find(key);
  if (v == o.end() || !v->is_array() || v->size() != 3) return {};
  for (const auto& n : *v)
    if (!n.is_number() || !std::isfinite(n.get<double>())) return {};
  return {(*v)[0].get<double>(), (*v)[1].get<double>(), (*v)[2].get<double>()};
}

// ---- curves.ts ----

struct Curve {
  std::string kind = "easeInOut";
  double strength = 0.5;
};

double curveAt(const Curve& c, double u) {
  const double x = clamp01(u), s = clamp01(c.strength), p = 1 + 2 * s;
  if (c.kind == "linear") return x;
  if (c.kind == "easeIn") return std::pow(x, p);
  if (c.kind == "easeOut") return 1 - std::pow(1 - x, p);
  if (c.kind == "holdThenMove") {
    const double hold = 0.25 + 0.25 * s;
    if (x <= hold) return 0;
    const double v = (x - hold) / (1 - hold);
    return v < 0.5 ? 2 * v * v : 1 - 2 * (1 - v) * (1 - v);
  }
  if (c.kind == "snap") return 1 - std::pow(1 - x, 2 + 6 * s);
  return x < 0.5 ? 0.5 * std::pow(2 * x, p) : 1 - 0.5 * std::pow(2 - 2 * x, p);  // easeInOut
}

double overshootAt(double u, double amount) {
  if (amount <= 0) return 0;
  const double x = clamp01(u);
  if (x == 0) return 0;
  return amount * 0.2 * std::sin(kPi * x * x);
}

// ---- types ----

struct Settings {
  Curve curve, aim, lens;
  bool straight = false;
  std::string orbit = "shortest";
  double extraTurns = 0, overshoot = 0, motionBlur = 0.5, shakeAmount = 0, shakeFrequency = 0.6, turnLast = 0;
  bool cut = false, flowThrough = false;
};

Curve curveOf(const Json& o, const Curve& fallback) {
  if (!o.is_object()) return fallback;
  Curve c;
  c.kind = text(o, "kind", fallback.kind);
  c.strength = number(o, "strength", fallback.strength);
  return c;
}

Settings settingsOf(const Json& s) {
  Settings out;
  if (!s.is_object()) return out;
  out.curve = curveOf(s.value("curve", Json{}), out.curve);
  out.aim = curveOf(s.value("aimCurve", Json{}), out.curve);
  out.lens = curveOf(s.value("lensCurve", Json{}), out.curve);
  out.straight = text(s, "path", "arc") == "straight";
  out.orbit = text(s, "orbit", "shortest");
  out.extraTurns = number(s, "extraTurns", 0);
  out.overshoot = number(s, "overshoot", 0);
  out.motionBlur = number(s, "motionBlur", 0.5);
  const Json shake = s.value("shake", Json{});
  out.shakeAmount = number(shake, "amount", 0);
  out.shakeFrequency = number(shake, "frequency", 0.6);
  out.cut = flag(s, "cut");
  out.flowThrough = flag(s, "flowThrough");
  out.turnLast = number(s, "turnLast", 0);
  return out;
}

struct Key {
  std::string id;
  double t = 0;
  std::string target = "point";
  bm::Vec3 at, offset;
  double azimuth = 0, elevation = 20, roll = 0, lensMm = 50, focus = 0.5, blur = 0;
  bool fit = false;
  double margin = 1, distance = 10;
};

std::optional<Key> keyOf(const Json& k) {
  if (!k.is_object() || !k.contains("id") || !k["id"].is_string()) return std::nullopt;
  const auto t = k.find("t");
  if (t == k.end() || !t->is_number() || !std::isfinite(t->get<double>())) return std::nullopt;
  Key key;
  key.id = k["id"].get<std::string>();
  key.t = t->get<double>();
  const Json target = k.value("target", Json{});
  key.target = text(target, "kind", "model");
  if (key.target != "model" && key.target != "build" && key.target != "piece" && key.target != "point") key.target = "model";
  if (key.target == "point") key.at = xyz(target, "at");
  key.offset = xyz(k, "offset");
  key.azimuth = number(k, "azimuth", 0);
  key.elevation = number(k, "elevation", 20);
  key.roll = number(k, "roll", 0);
  key.lensMm = number(k, "lensMm", 50);
  key.blur = number(k, "blur", 0);
  const auto focus = k.find("focus");
  key.focus = focus != k.end() && focus->is_number() ? focus->get<double>() : 0.5;
  const Json distance = k.value("distance", Json{});
  key.fit = flag(distance, "fit", true);
  key.margin = number(distance, "margin", 1);
  key.distance = number(distance, "value", 10);
  return key;
}

std::vector<Key> sortedKeys(const Json& track) {
  std::vector<Key> keys;
  if (track.is_object() && track.contains("keys") && track["keys"].is_array())
    for (const auto& k : track["keys"])
      if (auto key = keyOf(k)) keys.push_back(std::move(*key));
  std::stable_sort(keys.begin(), keys.end(), [](const Key& a, const Key& b) { return a.t < b.t; });
  return keys;
}

const Json* transitionFrom(const Json& track, const std::string& id) {
  if (!track.is_object() || !track.contains("transitions") || !track["transitions"].is_array()) return nullptr;
  for (const auto& tr : track["transitions"])
    if (text(tr, "from") == id) return &tr;
  return nullptr;
}

Settings settingsFrom(const Json& track, const std::string& id) {
  const Json* tr = transitionFrom(track, id);
  return tr ? settingsOf(tr->value("settings", Json{})) : Settings{};
}

// ---- camera.ts ----

bm::Vec3 viewDir(double azDeg, double elDeg) {
  const double az = rad(azDeg), el = rad(elDeg);
  return {std::sin(az) * std::cos(el), std::sin(el), std::cos(az) * std::cos(el)};
}

bm::Vec3 spherical(bm::Vec3 target, double distance, double az, double el) { return target + viewDir(az, el) * distance; }

double fovForLens(double lensMm, double sensorMm) { return deg(2 * std::atan(std::max(1.0, sensorMm) / (2 * std::max(1.0, lensMm)))); }

double fitDistanceAtTarget(const bm::Box& box, bm::Vec3 target, double fovDeg, double aspect, double az, double el) {
  if (box.empty()) return 1;
  const bm::Vec3 z = viewDir(az, el);
  const bm::Vec3 x = bm::normalized(bm::cross(bm::Vec3{0, 1, 0}, z));
  const bm::Vec3 y = bm::cross(z, x);
  const double tanV = std::tan(rad(fovDeg) / 2), tanH = tanV * aspect;
  double d = 0;
  for (double px : {box.min.x, box.max.x})
    for (double py : {box.min.y, box.max.y})
      for (double pz : {box.min.z, box.max.z}) {
        const bm::Vec3 o = bm::Vec3{px, py, pz} - target;
        d = std::max(d, bm::dot(o, z) + std::max(std::abs(bm::dot(o, x)) / tanH, std::abs(bm::dot(o, y)) / tanV));
      }
  return std::max(d, 1.0);
}

// ---- sample.ts ----

struct Rig {
  bm::Vec3 target;
  double dist = 1, az = 0, el = 0, roll = 0, lensMm = 50, focus = 0.5, blur = 0;
};

bm::Box targetBox(const Key& key, double t, const Context& c) {
  if (key.target == "build") return c.build ? c.build(t) : c.model;
  if (key.target == "piece") {
    if (c.piece)
      if (auto box = c.piece(t)) return *box;
    return c.build ? c.build(t) : c.model;
  }
  return c.model;
}

Rig keyRig(const Key& key, double t, const Context& c) {
  const bm::Box box = targetBox(key, t, c);
  Rig rig;
  rig.target = (key.target == "point" ? key.at : box.empty() ? bm::Vec3{} : centre(box)) + key.offset;
  rig.el = std::clamp(key.elevation, kMinElevation, kMaxElevation);
  const double fov = fovForLens(key.lensMm, c.sensorMm);
  const double dist = key.fit ? fitDistanceAtTarget(box, rig.target, fov, c.aspect, key.azimuth, rig.el) * key.margin : key.distance;
  rig.dist = std::max(kMinDistance, dist);
  rig.az = key.azimuth, rig.roll = key.roll, rig.lensMm = key.lensMm, rig.focus = key.focus, rig.blur = key.blur;
  return rig;
}

/// orbit.ts orbitDegreesOf: the signed turn of a move.
double orbitDegrees(double a, double b, const Settings& s) {
  const double pos = std::fmod(std::fmod(b - a, 360) + 360, 360);
  const double turns = 360 * std::max(0.0, std::floor(s.extraTurns));
  if (s.orbit == "cw") return (pos == 0 ? 360 : pos) + turns;
  if (s.orbit == "ccw") return -(pos == 0 ? 360 : 360 - pos) - turns;
  return pos > 180 ? pos - 360 : pos;
}

double seed(const std::string& s) {
  uint32_t h = 2166136261u;
  for (unsigned char ch : s) h = (h ^ ch) * 16777619u;
  return static_cast<double>(h % 10000) / 10000;
}

/// keyframes.ts autoClampedSlope.
double autoClampedSlope(const double* px, const double* py, double cx, double cy, const double* nx, const double* ny) {
  if (!px || !nx) return 0;
  const double dl = (cy - *py) / (cx - *px), dr = (*ny - cy) / (*nx - cx);
  if (dl == 0 || dr == 0 || (dl > 0) != (dr > 0)) return 0;
  const double s = (*ny - *py) / (*nx - *px);
  const double limit = 3 * std::min(std::abs(dl), std::abs(dr));
  return (s > 0 ? 1 : s < 0 ? -1 : 0) * std::min(std::abs(s), limit);
}

double hermite(const std::vector<double>& x, const std::vector<double>& y, size_t i, double t, bool flowIn, bool flowOut) {
  const auto at = [&](long k, const std::vector<double>& v) -> const double* {
    return k >= 0 && k < static_cast<long>(v.size()) ? &v[static_cast<size_t>(k)] : nullptr;
  };
  const long j = static_cast<long>(i);
  const double h = x[i + 1] - x[i], u = (t - x[i]) / h;
  const double m0 = (flowIn ? autoClampedSlope(at(j - 1, x), at(j - 1, y), x[i], y[i], at(j + 1, x), at(j + 1, y)) : 0) * h;
  const double m1 = (flowOut ? autoClampedSlope(at(j, x), at(j, y), x[i + 1], y[i + 1], at(j + 2, x), at(j + 2, y)) : 0) * h;
  const double u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * y[i] + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * y[i + 1] + (u3 - u2) * m1;
}

Shot shotFrom(const Rig& rig, const Context& c) {
  return {spherical(rig.target, rig.dist, rig.az, rig.el), rig.target, fovForLens(rig.lensMm, c.sensorMm), rig.roll, rig.focus, rig.blur};
}

// ---- presets.ts ----

struct PresetChange {
  std::optional<double> azimuth, elevation, roll, lensMm, blur, focus, distanceScale;
  std::optional<std::pair<double, double>> slide;
};
struct Preset {
  CameraPreset info;
  Json settings;
  std::optional<PresetChange> key;
};

Json baseSettings() {
  return {{"curve", {{"kind", "easeInOut"}, {"strength", 0.5}}},
          {"path", "arc"},
          {"orbit", "shortest"},
          {"extraTurns", 0},
          {"overshoot", 0},
          {"motionBlur", 0.5},
          {"shake", {{"amount", 0}, {"frequency", 0.6}}},
          {"cut", false},
          {"flowThrough", false}};
}

Json with(Json over) {
  Json s = baseSettings();
  for (auto& [k, v] : over.items()) {
    if (k == "shake") for (auto& [sk, sv] : v.items()) s["shake"][sk] = sv;
    else s[k] = v;
  }
  return s;
}

Json curve(const char* kind, double strength) { return {{"kind", kind}, {"strength", strength}}; }

const std::vector<Preset>& presetTable() {
  static const std::vector<Preset> table = [] {
    std::vector<Preset> p;
    const auto add = [&](const char* id, const char* label, const char* hint, Json settings, std::optional<PresetChange> key = {}) {
      p.push_back({{id, label, hint}, std::move(settings), std::move(key)});
    };
    PresetChange c;
    add("glide", "Smooth glide", "A calm, even move that eases in and out", with(Json::object()));
    c = {}, c.distanceScale = 0.7;
    add("push-in", "Push in", "Moves closer to draw attention", with({{"curve", curve("easeInOut", 0.6)}}), c);
    c = {}, c.distanceScale = 1.4;
    add("pull-back", "Pull back", "Moves away to reveal more", with({{"curve", curve("easeInOut", 0.6)}}), c);
    c = {}, c.slide = {{-0.25, 0}};
    add("truck-left", "Truck left", "Slides sideways to the left", with({{"path", "straight"}}), c);
    c = {}, c.slide = {{0.25, 0}};
    add("truck-right", "Truck right", "Slides sideways to the right", with({{"path", "straight"}}), c);
    c = {}, c.slide = {{0, 0.25}};
    add("pedestal-up", "Pedestal up", "Rises straight up", with({{"path", "straight"}}), c);
    c = {}, c.slide = {{0, -0.25}};
    add("pedestal-down", "Pedestal down", "Lowers straight down", with({{"path", "straight"}}), c);
    c = {}, c.elevation = -25;
    add("crane-down", "Crane down", "Swoops lower, tilting up to the model", with({{"curve", curve("easeInOut", 0.7)}}), c);
    c = {}, c.elevation = 25;
    add("crane-up", "Crane up", "Rises and looks down over the model", with({{"curve", curve("easeInOut", 0.7)}}), c);
    c = {}, c.azimuth = 90;
    add("orbit", "Orbit around", "Circles round the model", with({{"curve", curve("easeInOut", 0.4)}}), c);
    c = {}, c.azimuth = 60, c.distanceScale = 0.9;
    add("arc-reveal", "Arc reveal", "Swings round and settles on the front, slightly closer",
        with({{"curve", curve("easeOut", 0.7)}, {"overshoot", 0.05}}), c);
    c = {}, c.azimuth = 70, c.elevation = -20;
    add("swoop", "Fast swoop", "A quick, blurred swing to a new angle that settles softly",
        with({{"curve", curve("snap", 0.8)}, {"overshoot", 0.15}, {"motionBlur", 0.8}}), c);
    c = {}, c.azimuth = 120;
    add("whip-pan", "Whip pan", "A very fast, fully blurred turn", with({{"curve", curve("easeInOut", 1)}, {"motionBlur", 1}}), c);
    c = {}, c.lensMm = 50, c.distanceScale = 2;
    add("dolly-zoom", "Dolly zoom", "Moves back while zooming in: the model stays put, the background stretches",
        with({{"curve", curve("easeInOut", 0.5)}, {"lensCurve", curve("easeInOut", 0.5)}}), c);
    c = {}, c.focus = 0.9, c.blur = 0.5;
    add("rack-focus", "Rack focus", "Shifts the sharp area to a new depth",
        with({{"curve", curve("easeInOut", 0.3)}, {"lensCurve", curve("easeInOut", 0.8)}}), c);
    c = {}, c.roll = 12;
    add("dutch-in", "Dutch tilt in", "Rolls the camera for a dramatic angle", with(Json::object()), c);
    c = {}, c.azimuth = 10;
    add("handheld", "Handheld drift", "A gentle move with a little handheld wobble",
        with({{"curve", curve("linear", 0)}, {"shake", {{"amount", 0.8}, {"frequency", 0.7}}}}), c);
    add("hold", "Hold", "Stays put until the next move", with({{"curve", curve("holdThenMove", 1)}}));
    add("cut", "Hard cut", "Jumps straight to the next shot", with({{"cut", true}, {"motionBlur", 0}}));
    return p;
  }();
  return table;
}

const Preset& presetById(const std::string& id) {
  for (const auto& p : presetTable())
    if (p.info.id == id) return p;
  return presetTable().front();
}

double round3(double v) { return std::round(v * 1000) / 1000; }
double wrapDegrees(double a) { return std::fmod(std::fmod(a + 180, 360) + 360, 360) - 180; }

// ---- ops.ts ----

Json emptyTrack() { return {{"keys", Json::array()}, {"transitions", Json::array()}, {"shutter", 0.5}}; }

Json trackOrEmpty(const Json& track) {
  Json t = track.is_object() ? track : emptyTrack();
  if (!t.contains("keys") || !t["keys"].is_array()) t["keys"] = Json::array();
  if (!t.contains("transitions") || !t["transitions"].is_array()) t["transitions"] = Json::array();
  if (!t.contains("shutter")) t["shutter"] = 0.5;
  return t;
}

std::string newKeyId() {
  static uint64_t counter = 0;
  static std::mt19937 random{std::random_device{}()};
  const auto base36 = [](uint64_t v) {
    std::string s;
    do s.insert(s.begin(), "0123456789abcdefghijklmnopqrstuvwxyz"[v % 36]); while (v /= 36);
    return s;
  };
  const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  return "cam-" + base36(static_cast<uint64_t>(now)) + "-" + base36(counter++) + "-" + base36(random() % (36 * 36 * 36 * 36));
}

Json glide(const std::string& from, const std::string& to) {
  return {{"from", from}, {"to", to}, {"preset", "glide"}, {"settings", baseSettings()}, {"origin", "user"}};
}

double keyTime(const Json& k) { return number(k, "t", 0); }

/// Sorts the keys and rebuilds the moves between neighbours (ops.ts relink).
Json finish(Json track, Json keys, const Json& old) {
  std::vector<Json> sorted(keys.begin(), keys.end());
  std::stable_sort(sorted.begin(), sorted.end(), [](const Json& a, const Json& b) { return keyTime(a) < keyTime(b); });
  Json out = Json::array();
  const auto find = [&](auto match) -> const Json* {
    for (const auto& tr : old)
      if (match(tr)) return &tr;
    return nullptr;
  };
  for (size_t i = 0; i + 1 < sorted.size(); ++i) {
    const std::string from = text(sorted[i], "id"), to = text(sorted[i + 1], "id");
    const Json* src = find([&](const Json& t) { return text(t, "from") == from && text(t, "to") == to; });
    if (!src) src = find([&](const Json& t) { return text(t, "from") == from; });
    if (!src) src = find([&](const Json& t) { return text(t, "to") == to; });
    if (src) {
      Json tr = *src;
      tr["from"] = from, tr["to"] = to;
      out.push_back(std::move(tr));
    } else {
      out.push_back(glide(from, to));
    }
  }
  track["keys"] = Json(sorted);
  track["transitions"] = std::move(out);
  return track;
}

double freeTime(const Json& keys, double t, double fps, double duration, const std::string& except = {}) {
  const double step = 1 / std::max(1.0, fps);
  double at = std::min(std::max(0.0, t), duration);
  const auto taken = [&](double v) {
    for (const auto& k : keys)
      if (text(k, "id") != except && std::abs(keyTime(k) - v) < step / 2) return true;
    return false;
  };
  for (int n = 0; taken(at) && n < 10000; ++n) at = at - step >= 0 ? at - step : at + step;
  return at;
}

std::string order(const Json& keys) {
  std::vector<std::pair<double, std::string>> ids;
  for (const auto& k : keys) ids.emplace_back(keyTime(k), text(k, "id"));
  std::stable_sort(ids.begin(), ids.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
  std::string out;
  for (const auto& [t, id] : ids) out += id + ",";
  return out;
}

Json updateKey(const Json& track, const std::string& id, const Json& patch) {
  Json t = trackOrEmpty(track);
  Json keys = t["keys"];
  for (auto& k : keys)
    if (text(k, "id") == id) {
      for (const auto& [name, value] : patch.items()) k[name] = value;
      k["id"] = id;
      k["origin"] = "user";
    }
  const Json old = t["transitions"];
  return finish(std::move(t), std::move(keys), old);
}

}  // namespace

bm::Vec3 toWeb(bm::Vec3 p) { return {p.x / 20, -p.y / 20, -p.z / 20}; }
bm::Vec3 toLdu(bm::Vec3 p) { return {p.x * 20, -p.y * 20, -p.z * 20}; }

bm::Vec3 upLdu(const Shot& shot) {
  const bm::Vec3 webUp{0, 1, 0};
  const bm::Vec3 forward = bm::normalized(shot.target - shot.eye);
  const bm::Vec3 side = bm::cross(forward, webUp);
  const double r = shot.roll * kPi / 180;
  if (bm::length(side) < 1e-9 || !std::isfinite(r)) return {0, -1, 0};  // straight up or down: unrolled
  const bm::Vec3 right = bm::normalized(side);    // the camera's local x
  const bm::Vec3 up = bm::cross(right, forward);  // and y, after lookAt
  const bm::Vec3 rolled = up * std::cos(r) - right * std::sin(r);
  return {rolled.x, -rolled.y, -rolled.z};  // a direction: toLdu without the scale
}

double focusDistance(bm::Vec3 eye, bm::Vec3 target, const bm::Box& box, double focus, double near) {
  const bm::Vec3 forward = bm::normalized(target - eye);
  double lo = std::numeric_limits<double>::infinity(), hi = -lo;
  for (int i = 0; i < 8; i++) {
    const bm::Vec3 c{i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z};
    const double d = bm::dot(c - eye, forward);
    lo = std::min(lo, d), hi = std::max(hi, d);
  }
  lo = std::max(lo, near);
  hi = std::max(hi, lo + 1e-3);
  return lo + (hi - lo) * std::clamp(std::isfinite(focus) ? focus : 0.5, 0.0, 1.0);
}
bm::Box toWeb(const bm::Box& b) {
  bm::Box out;
  if (b.empty()) return out;
  out.grow(toWeb(b.min));
  out.grow(toWeb(b.max));
  return out;
}


namespace {

// ---- camera.ts focusPlan / focusAt ----

constexpr double kFocusStep = 0.2, kLookAhead = 1.2, kSwitchLead = 0.5, kSettle = 0.4, kMinFill = 0.6;

double volume(const bm::Box& b) {
  if (b.empty()) return 0;
  const bm::Vec3 d = b.max - b.min;
  return d.x * d.y * d.z;
}

struct CloseUp {
  double from, to;
  size_t group;
  double size;
};

struct FocusPlan {
  std::vector<Assembly> groups;
  std::vector<CloseUp> shots;
  std::vector<bm::Box> built;  ///< main model: the union of its first i + 1 landings, by start
};

FocusPlan focusPlan(std::vector<Assembly> groups, const bm::Box& model) {
  FocusPlan plan;
  if (groups.empty()) groups.push_back({});
  for (auto& g : groups) {
    std::stable_sort(g.lands.begin(), g.lands.end(), [](const Landing& a, const Landing& b) { return a.start < b.start; });
    // as the web: what a unit becomes is where its pieces land (its spot when it has none)
    if (!g.lands.empty()) {
      g.finished = bm::Box{};
      for (const auto& l : g.lands) g.finished.merge(l.box);
    }
  }
  if (groups[0].finished.empty()) groups[0].finished = model;
  struct Order {
    double start, end;
    size_t group;
  };
  std::vector<Order> order;
  for (size_t g = 0; g < groups.size(); ++g)
    for (const auto& l : groups[g].lands) order.push_back({l.start, l.end, g});
  std::stable_sort(order.begin(), order.end(), [](const Order& a, const Order& b) { return a.start < b.start; });
  constexpr double inf = std::numeric_limits<double>::infinity();
  // Each unit holds the camera from its first flight until its last piece has landed; entered a
  // little early but not before the previous landing has settled, left after its last landing
  // but early enough to show the next one (usually the finished unit flying in).
  for (size_t g = 1; g < groups.size(); ++g) {
    std::vector<Order> own;
    for (const auto& o : order)
      if (o.group == g) own.push_back(o);
    if (own.empty()) continue;
    const Order first = own.front();
    double lastEnd = -inf, lastStart = -inf;
    for (const auto& o : own) lastEnd = std::max(lastEnd, o.end), lastStart = std::max(lastStart, o.start);
    double prevLand = -inf, nextLand = inf;
    for (const auto& o : order) {
      if (o.group == g) continue;
      if (o.start < first.start) prevLand = std::max(prevLand, o.end);
      if (o.start >= lastStart - 1e-6 && o.end > lastEnd) nextLand = std::min(nextLand, o.end);
    }
    const double enter = std::max(first.start - kSwitchLead, std::min(prevLand + kSettle, first.end - kSettle - kFocusStep));
    const double exit = std::max(lastEnd, std::min(lastEnd + kSettle, nextLand - kSettle - kFocusStep));
    plan.shots.push_back({enter, exit, g, volume(groups[g].finished)});
  }
  for (const auto& l : groups[0].lands) {
    plan.built.push_back(plan.built.empty() ? l.box : plan.built.back());
    plan.built.back().merge(l.box);
  }
  plan.groups = std::move(groups);
  return plan;
}

bm::Box focusAt(const FocusPlan& plan, double t) {
  // a unit is small: hold one steady framing of the whole of it while it is built
  bm::Box held;
  for (const auto& sh : plan.shots)
    if (t >= sh.from - 1e-9 && t <= sh.to + 1e-9) held.merge(plan.groups[sh.group].finished);
  if (!held.empty()) return held;
  const Assembly& g = plan.groups[0];
  if (g.lands.empty()) return g.finished;
  const auto due = std::upper_bound(g.lands.begin(), g.lands.end(), t + kLookAhead,
                                    [](double at, const Landing& l) { return at < l.start; });
  bm::Box box = due == g.lands.begin() ? g.lands.front().box : plan.built[static_cast<size_t>(due - g.lands.begin()) - 1];
  // grow a young build towards its finished size so the first bricks are not a macro shot
  double* lo[3] = {&box.min.x, &box.min.y, &box.min.z};
  double* hi[3] = {&box.max.x, &box.max.y, &box.max.z};
  const double flo[3] = {g.finished.min.x, g.finished.min.y, g.finished.min.z};
  const double fhi[3] = {g.finished.max.x, g.finished.max.y, g.finished.max.z};
  for (int k = 0; k < 3; ++k) {
    const double grow = std::max(0.0, (fhi[k] - flo[k]) * kMinFill - (*hi[k] - *lo[k])) / 2;
    *lo[k] = std::max(flo[k], *lo[k] - grow), *hi[k] = std::min(fhi[k], *hi[k] + grow);
  }
  return box;
}

/// context.ts atLeast: grown round its centre so no side is shorter than `share` of the model's longest.
bm::Box atLeast(bm::Box box, const bm::Box& model, double share) {
  if (box.empty() || model.empty()) return box;
  const bm::Vec3 ms = model.max - model.min;
  const double least = share * std::max({ms.x, ms.y, ms.z});
  const bm::Vec3 c = centre(box), size = box.max - box.min;
  const bm::Vec3 half{std::max(size.x, least) / 2, std::max(size.y, least) / 2, std::max(size.z, least) / 2};
  box.min = c - half, box.max = c + half;
  return box;
}

}  // namespace

bm::Box focusBox(const std::vector<Assembly>& assemblies, const bm::Box& model, double seconds) {
  return focusAt(focusPlan(assemblies, model), seconds);
}

Context buildContext(std::vector<Assembly> assemblies, bm::Box model, double aspect) {
  Context context;
  context.aspect = aspect;
  context.model = model;
  std::vector<Landing> all;
  for (const auto& g : assemblies) all.insert(all.end(), g.lands.begin(), g.lands.end());
  auto plan = std::make_shared<const FocusPlan>(focusPlan(std::move(assemblies), model));
  const auto raw = [plan, model](double t) { return atLeast(focusAt(*plan, t), model, 0.35); };
  // context.ts smoothBoxOverTime: weighted on a 0.1 s grid, blended between grid points
  auto cache = std::make_shared<std::map<long, bm::Box>>();
  context.build = [raw, cache](double t) {
    constexpr double step = 0.1;
    constexpr int n = 6;  // round(0.6 / step)
    const auto at = [&](long g) {
      if (const auto hit = cache->find(g); hit != cache->end()) return hit->second;
      bm::Vec3 lo, hi;
      double sum = 0;
      for (int k = -n; k <= n; ++k) {
        const double w = 0.5 + 0.5 * std::cos(kPi * k / (n + 1));
        const bm::Box b = raw(std::max(0.0, (g + k) * step));
        if (b.empty()) continue;
        lo = lo + b.min * w, hi = hi + b.max * w, sum += w;
      }
      bm::Box box = raw(g * step);
      if (sum > 0) box.min = lo * (1 / sum), box.max = hi * (1 / sum);
      cache->emplace(g, box);
      return box;
    };
    const long g0 = static_cast<long>(std::floor(t / step));
    const double u = t / step - g0;
    const bm::Box a = at(g0), b = at(g0 + 1);
    bm::Box out;
    out.min = a.min + (b.min - a.min) * u, out.max = a.max + (b.max - a.max) * u;
    return out;
  };
  auto lands = std::make_shared<const std::vector<Landing>>(std::move(all));
  context.piece = [lands](double t) -> std::optional<bm::Box> {
    bm::Box box;
    for (const auto& land : *lands)
      if (t >= land.start && t < land.end) box.merge(land.box);
    if (box.empty()) return std::nullopt;
    return box;
  };
  return context;
}

std::optional<Shot> sample(const Json& track, double t, const Context& ctx) {
  const auto keys = sortedKeys(track);
  if (keys.empty()) return std::nullopt;
  if (t <= keys[0].t || keys.size() == 1) return shotFrom(keyRig(keys[0], t, ctx), ctx);
  const size_t last = keys.size() - 1;
  if (t >= keys[last].t) return shotFrom(keyRig(keys[last], t, ctx), ctx);
  size_t i = 0;
  while (i + 1 < last && keys[i + 1].t <= t) ++i;
  const Key &a = keys[i], &b = keys[i + 1];
  const Settings s = settingsFrom(track, a.id);
  if (s.cut) return shotFrom(keyRig(a, t, ctx), ctx);
  const double u = (t - a.t) / (b.t - a.t);
  Rig ra = keyRig(a, t, ctx), rb = keyRig(b, t, ctx);
  rb.az = ra.az + orbitDegrees(ra.az, rb.az, s);

  Rig rig;
  const bool flows = s.flowThrough;
  if (flows) {
    const bool prevFlows = i > 0 && settingsFrom(track, keys[i - 1].id).flowThrough;
    const bool nextFlows = i + 2 <= last && settingsFrom(track, b.id).flowThrough;
    std::vector<size_t> idx;
    for (long k = static_cast<long>(i) - 1; k <= static_cast<long>(i) + 2; ++k)
      if (k >= 0 && k <= static_cast<long>(last)) idx.push_back(static_cast<size_t>(k));
    std::vector<Rig> rigs;
    for (size_t k : idx) rigs.push_back(k == i ? ra : k == i + 1 ? rb : keyRig(keys[k], t, ctx));
    const auto at = [&](size_t k) -> long {
      const auto f = std::find(idx.begin(), idx.end(), k);
      return f == idx.end() ? -1 : f - idx.begin();
    };
    if (i > 0 && at(i - 1) >= 0) {
      auto& r = rigs[static_cast<size_t>(at(i - 1))];
      r.az = ra.az - orbitDegrees(r.az, ra.az, settingsFrom(track, keys[i - 1].id));
    }
    if (at(i + 2) >= 0) {
      auto& r = rigs[static_cast<size_t>(at(i + 2))];
      r.az = rb.az + orbitDegrees(rb.az, r.az, settingsFrom(track, b.id));
    }
    std::vector<double> xs;
    for (size_t k : idx) xs.push_back(keys[k].t);
    const size_t j = static_cast<size_t>(at(i));
    const auto ch = [&](auto f) {
      std::vector<double> ys;
      for (const auto& r : rigs) ys.push_back(f(r));
      return hermite(xs, ys, j, t, prevFlows, nextFlows);
    };
    rig.target = {ch([](const Rig& r) { return r.target.x; }), ch([](const Rig& r) { return r.target.y; }),
                  ch([](const Rig& r) { return r.target.z; })};
    rig.dist = std::exp(ch([](const Rig& r) { return std::log(r.dist); }));
    rig.az = ch([](const Rig& r) { return r.az; });
    rig.el = ch([](const Rig& r) { return r.el; });
    rig.roll = ch([](const Rig& r) { return r.roll; });
    rig.lensMm = ch([](const Rig& r) { return r.lensMm; });
    rig.focus = ch([](const Rig& r) { return r.focus; });
    rig.blur = ch([](const Rig& r) { return r.blur; });
  } else {
    const double up = curveAt(s.curve, u) + overshootAt(u, s.overshoot);
    const double ua = curveAt(s.aim, u), ul = curveAt(s.lens, u);
    const double late = s.turnLast > 0 && s.turnLast < b.t - a.t ? s.turnLast : 0;
    const double uTurn = late ? clamp01((t - (b.t - late)) / late) : u;
    const double upTurn = late ? curveAt(s.curve, uTurn) + overshootAt(uTurn, s.overshoot) : up;
    const double upRest = late ? curveAt(s.curve, u) : up;
    rig.target = lerp(ra.target, rb.target, ua);
    rig.dist = std::exp(lerp(std::log(ra.dist), std::log(rb.dist), upRest));
    rig.az = lerp(ra.az, rb.az, upTurn), rig.el = lerp(ra.el, rb.el, upRest), rig.roll = lerp(ra.roll, rb.roll, upTurn);
    rig.lensMm = lerp(ra.lensMm, rb.lensMm, ul), rig.focus = lerp(ra.focus, rb.focus, ul), rig.blur = lerp(ra.blur, rb.blur, ul);
  }
  if (s.shakeAmount > 0) {
    const double ph = seed(a.id + ">" + b.id) * kPi * 2;
    const double w = 2 * kPi * std::max(0.05, s.shakeFrequency) * t;
    const double env = std::min({1.0, u * 5, (1 - u) * 5});
    rig.az += s.shakeAmount * env * (0.6 * std::sin(w + ph) + 0.4 * std::sin(w * 2.13 + ph * 1.7));
    rig.el += s.shakeAmount * env * 0.6 * (0.6 * std::sin(w * 1.31 + ph * 0.6) + 0.4 * std::sin(w * 2.71 + ph * 2.3));
  }
  rig.el = std::clamp(rig.el, kMinElevation, kMaxElevation);
  rig.dist = std::max(kMinDistance, rig.dist);
  Shot shot = shotFrom(rig, ctx);
  if (s.straight && !flows) {
    const double up = curveAt(s.curve, u) + overshootAt(u, s.overshoot);
    shot.eye = lerp(spherical(ra.target, ra.dist, ra.az, ra.el), spherical(rb.target, rb.dist, rb.az, rb.el), up);
  }
  return shot;
}

std::vector<CameraTrackKey> keysOf(const Json& track) {
  std::vector<CameraTrackKey> out;
  if (!track.is_object() || !track.contains("keys") || !track["keys"].is_array()) return out;
  for (const auto& k : track["keys"]) {
    const auto key = keyOf(k);
    if (!key) continue;
    CameraTrackKey info;
    info.id = key->id;
    info.seconds = key->t;
    info.target = key->target;
    info.azimuth = key->azimuth, info.elevation = key->elevation, info.lensMm = key->lensMm;
    info.fitted = key->fit;
    info.user = text(k, "origin", "user") != "auto";
    info.margin = key->margin, info.distance = key->distance, info.roll = key->roll, info.blur = key->blur;
    info.focusTarget = !k.contains("focus") || !k["focus"].is_number();
    info.focus = key->focus;
    const bm::Vec3 point = toLdu(key->at + key->offset);
    info.point = {point.x, point.y, point.z};
    if (key->target == "point" && !key->fit) {
      const bm::Vec3 eye = toLdu(spherical(key->at + key->offset, key->distance, key->azimuth, key->elevation));
      info.eye = {eye.x, eye.y, eye.z};
    }
    if (const Json* tr = transitionFrom(track, key->id)) info.preset = text(*tr, "preset", "glide");
    out.push_back(std::move(info));
  }
  std::stable_sort(out.begin(), out.end(), [](const auto& a, const auto& b) { return a.seconds < b.seconds; });
  if (!out.empty()) out.back().preset.clear();
  return out;
}

std::vector<CameraMove> movesOf(const Json& track) {
  std::vector<CameraMove> out;
  const auto keys = keysOf(track);
  for (size_t i = 0; i + 1 < keys.size(); ++i) {
    const Json* tr = transitionFrom(track, keys[i].id);
    if (!tr) continue;
    const Json settings = tr->value("settings", Json::object());
    const Settings s = settingsOf(settings);
    CameraMove m;
    m.from = keys[i].id, m.to = keys[i + 1].id;
    m.preset = text(*tr, "preset", "glide");
    m.user = text(*tr, "origin", "user") != "auto";
    m.cut = s.cut, m.flowThrough = s.flowThrough;
    m.curve = s.curve.kind, m.strength = s.curve.strength;
    m.straight = s.straight, m.orbit = s.orbit;
    m.extraTurns = static_cast<int>(std::round(s.extraTurns));
    m.overshoot = s.overshoot, m.motionBlur = s.motionBlur;
    m.shake = s.shakeAmount, m.shakeFrequency = s.shakeFrequency;
    m.turnLast = s.turnLast;
    out.push_back(std::move(m));
  }
  return out;
}

const std::vector<CameraPreset>& presets() {
  static const std::vector<CameraPreset> list = [] {
    std::vector<CameraPreset> out;
    for (const auto& p : presetTable()) {
      out.push_back(p.info);
    }
    return out;
  }();
  return list;
}

Json keyFromView(bm::Vec3 eye, bm::Vec3 target, double fovDegrees, double seconds) {
  const bm::Vec3 d = eye - target;
  const double dist = std::max(1e-6, bm::length(d));
  const double elevation = deg(std::asin(std::clamp(d.y / dist, -1.0, 1.0)));
  const double azimuth = deg(std::atan2(d.x, d.z));
  const double lensMm = std::max(1.0, kSensorMm) / (2 * std::tan(rad(fovDegrees) / 2));
  return {{"t", seconds},
          {"target", {{"kind", "point"}, {"at", {target.x, target.y, target.z}}}},
          {"offset", {0, 0, 0}},
          {"azimuth", azimuth},
          {"elevation", elevation},
          {"distance", {{"fit", false}, {"value", dist}}},
          {"roll", 0},
          {"lensMm", lensMm},
          {"focus", "target"},
          {"blur", 0}};
}

Json addKey(const Json& track, Json key, double fps, double duration) {
  Json t = trackOrEmpty(track);
  Json keys = t["keys"];
  key["id"] = newKeyId();
  key["origin"] = "user";
  key["t"] = freeTime(keys, number(key, "t", 0), fps, duration);
  keys.push_back(std::move(key));
  const Json old = t["transitions"];
  return finish(std::move(t), std::move(keys), old);
}

Json setKeyView(const Json& track, const std::string& id, const Json& view) {
  Json patch = Json::object();
  for (const char* name : {"target", "offset", "azimuth", "elevation", "distance", "lensMm"})
    if (view.contains(name)) patch[name] = view[name];
  return updateKey(track, id, patch);
}

Json moveKey(const Json& track, const std::string& id, double seconds, double fps, double duration) {
  Json t = trackOrEmpty(track);
  Json keys = t["keys"];
  const double at = freeTime(keys, seconds, fps, duration, id);
  const std::string before = order(keys);
  for (auto& k : keys)
    if (text(k, "id") == id) k["t"] = at, k["origin"] = "user";
  Json transitions = t["transitions"];
  if (order(keys) != before) {
    // a key that changes place starts new pairs: the moves follow the keys' new neighbours
    Json kept = Json::array();
    for (const auto& tr : transitions)
      if (text(tr, "from") != id && text(tr, "to") != id) kept.push_back(tr);
    transitions = std::move(kept);
  }
  return finish(std::move(t), std::move(keys), transitions);
}

Json removeKey(const Json& track, const std::string& id) {
  Json t = trackOrEmpty(track);
  Json keys = Json::array(), transitions = Json::array();
  for (const auto& k : t["keys"])
    if (text(k, "id") != id) keys.push_back(k);
  // the move arriving at the deleted key carries on to the next key
  for (const auto& tr : t["transitions"])
    if (text(tr, "from") != id) transitions.push_back(tr);
  return finish(std::move(t), std::move(keys), transitions);
}

Json choosePreset(const Json& track, const std::string& fromId, const std::string& presetId, double distance) {
  Json t = trackOrEmpty(track);
  const Preset& preset = presetById(presetId);
  std::string toId;
  for (auto& tr : t["transitions"])
    if (text(tr, "from") == fromId) {
      tr["preset"] = preset.info.id;
      tr["settings"] = preset.settings;
      tr["origin"] = "user";
      toId = text(tr, "to");
    }
  if (toId.empty() || !preset.key) return t;
  const Json* start = nullptr;
  for (const auto& k : t["keys"])
    if (text(k, "id") == fromId) start = &k;
  const auto a = start ? keyOf(*start) : std::nullopt;
  if (!a) return t;
  // presets.ts endKeyForPreset: the start view with the preset's change applied
  const PresetChange& c = *preset.key;
  const double scale = c.distanceScale.value_or(1);
  const Json dist = a->fit ? Json{{"fit", true}, {"margin", round3(std::clamp(a->margin * scale, 0.5, 4.0))}}
                           : Json{{"fit", false}, {"value", round3(std::max(0.0, a->distance * scale))}};
  bm::Vec3 offset = a->offset;
  if (c.slide) {
    const double d = a->fit ? distance : a->distance;
    const double az = rad(a->azimuth);
    const bm::Vec3 right{std::cos(az), 0, -std::sin(az)};
    offset = offset + bm::Vec3{right.x * c.slide->first * d, c.slide->second * d, right.z * c.slide->first * d};
  }
  Json view = {{"azimuth", wrapDegrees(a->azimuth + c.azimuth.value_or(0))},
               {"elevation", std::clamp(a->elevation + c.elevation.value_or(0), -85.0, 89.0)},
               {"roll", std::clamp(a->roll + c.roll.value_or(0), -180.0, 180.0)},
               {"lensMm", std::clamp(a->lensMm + c.lensMm.value_or(0), 8.0, 400.0)},
               {"blur", std::clamp(a->blur + c.blur.value_or(0), 0.0, 1.0)},
               {"distance", dist},
               {"offset", {offset.x, offset.y, offset.z}}};
  if (c.focus) view["focus"] = *c.focus;
  else if (start->contains("focus")) view["focus"] = (*start)["focus"];
  return updateKey(t, toId, view);
}

Json setKeyFields(const Json& track, const CameraTrackKey& f) {
  Json t = trackOrEmpty(track);
  const Json* found = nullptr;
  for (const auto& k : t["keys"])
    if (text(k, "id") == f.id) found = &k;
  const auto key = found ? keyOf(*found) : std::nullopt;
  if (!key) return t;
  const auto finite = [](double v, double fallback) { return std::isfinite(v) ? v : fallback; };
  double azimuth = std::clamp(finite(f.azimuth, key->azimuth), -720.0, 720.0);
  double elevation = std::clamp(finite(f.elevation, key->elevation), kMinElevation, kMaxElevation);
  Json distance = f.fitted ? Json{{"fit", true}, {"margin", std::clamp(finite(f.margin, 1.15), 0.3, 5.0)}}
                           : Json{{"fit", false}, {"value", std::clamp(finite(f.distance, key->distance), kMinDistance, 5000.0)}};
  Json patch = Json::object();
  if (key->target == "point") {
    const bm::Vec3 was = key->at + key->offset;
    bm::Vec3 at = toWeb(bm::Vec3{finite(f.point.x, 0), finite(f.point.y, 0), finite(f.point.z, 0)});
    if (bm::length(at - was) < 1e-9) at = was;
    patch["target"] = {{"kind", "point"}, {"at", {at.x, at.y, at.z}}};
    patch["offset"] = {0, 0, 0};
    // a camera standing still: its position, typed in, decides the angles and distance
    if (!key->fit && !f.fitted) {
      const bm::Vec3 eye = toWeb(bm::Vec3{finite(f.eye.x, 0), finite(f.eye.y, 0), finite(f.eye.z, 0)});
      const bm::Vec3 shown = spherical(was, key->distance, key->azimuth, key->elevation);
      if (bm::length(eye - shown) > 1e-6) {
        const bm::Vec3 v = eye - at;
        const double d = std::max(kMinDistance, bm::length(v));
        azimuth = deg(std::atan2(v.x, v.z));
        elevation = std::clamp(deg(std::asin(std::clamp(v.y / d, -1.0, 1.0))), kMinElevation, kMaxElevation);
        distance = {{"fit", false}, {"value", d}};
      }
    }
  }
  patch["azimuth"] = azimuth;
  patch["elevation"] = elevation;
  patch["distance"] = distance;
  patch["roll"] = std::clamp(finite(f.roll, 0), -180.0, 180.0);
  patch["lensMm"] = std::clamp(finite(f.lensMm, key->lensMm), 8.0, 400.0);
  patch["focus"] = f.focusTarget ? Json("target") : Json(clamp01(finite(f.focus, 0.5)));
  patch["blur"] = clamp01(finite(f.blur, 0));
  return updateKey(t, f.id, patch);
}

Json setMoveFields(const Json& track, const CameraMove& m) {
  Json t = trackOrEmpty(track);
  static const std::set<std::string> curves = {"easeInOut", "easeIn", "easeOut", "linear", "holdThenMove", "snap"};
  const auto finite = [](double v, double fallback) { return std::isfinite(v) ? v : fallback; };
  for (auto& tr : t["transitions"]) {
    if (text(tr, "from") != m.from) continue;
    Json s = tr.value("settings", baseSettings());
    if (!s.is_object()) s = baseSettings();
    const std::string kind = curves.count(m.curve) ? m.curve : "easeInOut";
    s["cut"] = m.cut;
    s["flowThrough"] = m.flowThrough;
    s["curve"] = {{"kind", kind}, {"strength", clamp01(finite(m.strength, 0.5))}};
    s["path"] = m.straight ? "straight" : "arc";
    s["orbit"] = m.orbit == "cw" || m.orbit == "ccw" ? m.orbit : "shortest";
    s["extraTurns"] = std::clamp(m.extraTurns, 0, 5);
    s["overshoot"] = clamp01(finite(m.overshoot, 0));
    s["motionBlur"] = clamp01(finite(m.motionBlur, 0.5));
    s["shake"] = {{"amount", std::clamp(finite(m.shake, 0), 0.0, 3.0)}, {"frequency", std::clamp(finite(m.shakeFrequency, 0.6), 0.1, 4.0)}};
    if (finite(m.turnLast, 0) > 0) s["turnLast"] = m.turnLast;
    else s.erase("turnLast");
    tr["settings"] = std::move(s);
    tr["origin"] = "user";
  }
  return t;
}

Json setKeyTarget(const Json& track, const std::string& id, const std::string& target) {
  Json t = trackOrEmpty(track);
  if (target != "model" && target != "build" && target != "piece") return t;
  const Json* found = nullptr;
  for (const auto& k : t["keys"])
    if (text(k, "id") == id) found = &k;
  const auto key = found ? keyOf(*found) : std::nullopt;
  if (!key || key->target == target) return t;
  return updateKey(t, id, {{"target", {{"kind", target}}},
                           {"offset", {0, 0, 0}},
                           {"distance", {{"fit", true}, {"margin", key->fit ? key->margin : 1.1}}}});
}

}  // namespace bmapp::camtrack

// ---- autoDirect.ts ----

namespace bmapp::camtrack {
namespace {

enum class Finish { Arc, Cut, Whip };
struct StyleRules {
  double elStart, elEnd;
  double swingEvery[2];  ///< seconds between side swings at swings 0 and 1; 0 = none
  const char* big;
  const char* small;
  std::optional<double> lens, shutter;
  Finish finish;
  std::optional<double> finishEl, cutAt, turnSeconds, orbitDegrees;
  double margin;
};

const StyleRules& rulesOf(const std::string& style) {
  static const std::map<std::string, StyleRules> styles = {
      {"reference", {60, 15, {6, 2.2}, "swoop", "swoop", {}, {}, Finish::Cut, 10, 0.8, {}, {}, 1.15}},
      {"showcase", {52, 18, {0, 0}, "glide", "glide", {}, {}, Finish::Cut, 8, 0.82, {}, 200, 1.15}},
      {"turntable", {38, 16, {0, 0}, "swoop", "swoop", {}, {}, Finish::Whip, {}, {}, 12, {}, 1.1}},
      {"calm", {50, 22, {0, 0}, "glide", "glide", 85, {}, Finish::Arc, {}, {}, {}, {}, 1.15}},
      {"energetic", {62, 12, {3, 1.5}, "whip-pan", "swoop", {}, 0.7, Finish::Arc, {}, {}, {}, {}, 1.15}},
      {"overhead", {78, 70, {0, 0}, "glide", "glide", {}, {}, Finish::Arc, {}, {}, {}, {}, 1.15}},
  };
  const auto found = styles.find(style);
  return found != styles.end() ? found->second : styles.at("reference");
}

/// quick move lengths, seconds
double moveLength(const std::string& preset) {
  if (preset == "swoop") return 0.5;
  if (preset == "whip-pan") return 0.35;
  if (preset == "orbit" || preset == "glide") return 1.1;
  return 1;
}
constexpr double kTall = 0.25, kPullLead = 0.6, kMinGap = 0.6;
constexpr int kMaxSwings = 10, kMaxTurns = 5;
constexpr double kTurnBase = 225, kTurnStep = 120;
int priority(const std::string& preset) {
  static const std::map<std::string, int> p = {{"cut", 5}, {"whip-pan", 4}, {"swoop", 4}, {"arc-reveal", 3},
                                               {"pull-back", 2}, {"push-in", 1}, {"hold", 1}, {"glide", 0}};
  const auto found = p.find(preset);
  return found != p.end() ? found->second : 0;
}
/// JS Math.sign(x) || 1
double signOr1(double x) { return x > 0 ? 1 : x < 0 ? -1 : 1; }

struct Arrive {
  std::string preset;
  double len = 0;
};
struct DirectorPlan {
  double t = 0, az = 0, el = 0, margin = 1.15;
  std::string target = "build", preset;
  Json tweak;  ///< null, or settings on top of the preset
  std::optional<Arrive> arrive;
};

double azAt(const std::vector<DirectorPlan>& plans, double t) {
  const DirectorPlan* best = &plans.front();
  for (const auto& p : plans)
    if (p.t <= t + 1e-9 && p.t >= best->t) best = &p;
  return best->az;
}

}  // namespace

Json autoDirect(const DirectorBuild& tl, const DirectorOptions& opts) {
  const StyleRules& rules = rulesOf(opts.style);
  const std::string style = &rules == &rulesOf("reference") ? "reference" : opts.style;  // unknown styles direct as reference
  const double lensMm = rules.lens.value_or(opts.lensMm);
  const double shutter = rules.shutter.value_or(opts.shutter);
  const bm::Box& model = tl.model;
  const double ground = model.min.y;
  const double height = std::max(1e-6, model.max.y - ground);
  const bm::Vec3 mid = centre(model);
  struct Land {
    double t, start;
    bm::Box box;
  };
  std::vector<Land> lands;
  for (const auto& l : tl.lands)
    if (!l.box.empty()) lands.push_back({l.end, l.start, l.box});
  std::stable_sort(lands.begin(), lands.end(), [](const Land& a, const Land& b) { return a.t < b.t; });
  const double front = 0;  // LDraw models face the LDraw front view (web frontAzimuth)
  const double start = std::max(0.0, std::min(tl.intro, tl.buildEnd));
  const double end = tl.buildEnd;
  const double busy = clamp01(opts.swings);

  // built height share at time t (pieces landed by then)
  const auto builtAt = [&](double t) {
    double top = ground;
    for (const auto& l : lands)
      if (l.t <= t + 1e-9) top = std::max(top, l.box.max.y);
    return std::min(1.0, (top - ground) / height);
  };
  // the camera lowers with the height that will be built shortly after t (never rises)
  const auto elAt = [&](double t) {
    double lowest = rules.elStart;
    for (double x = 0; x <= t + 1e-9; x += std::max(0.05, t / 200))
      lowest = std::min(lowest, lerp(rules.elStart, rules.elEnd, builtAt(x + 1)));
    return std::min(lowest, lerp(rules.elStart, rules.elEnd, builtAt(t + 1)));
  };

  // the finish cut comes for the last details: a share of the build, at most the last 8 s
  constexpr double inf = std::numeric_limits<double>::infinity();
  const double cutAt = rules.finish == Finish::Cut ? std::max(start + rules.cutAt.value_or(0.8) * (end - start), end - 8) : inf;
  std::vector<DirectorPlan> plans, tail;
  const auto build = [&](double t, double az, const std::string& preset, double margin, Json tweak = nullptr) {
    DirectorPlan p;
    p.t = t, p.az = az, p.el = elAt(t), p.margin = margin, p.target = "build", p.preset = preset, p.tweak = std::move(tweak);
    return p;
  };
  const Json flow = {{"orbit", "cw"}, {"flowThrough", true}};

  if (rules.turnSeconds) {
    // Turntable: fixed on the finished model, turning clockwise from the front three-quarter
    // view to behind the far side; a whole turn more for every turnSeconds past a short build
    const double orbitEnd = std::max(start + 0.5, end - kMinGap - 0.05);
    const double az0 = wrapDegrees(front - 35);
    const double len = orbitEnd - start;
    const double extra = std::min<double>(kMaxTurns, std::max(0.0, std::round((len - 9) / *rules.turnSeconds)));
    const double total = kTurnBase + 360 * extra;
    // a short build speeds up as it goes (as the videos do); a long one turns evenly
    const double ease = extra == 0 ? 1.8 : 1;
    const int steps = std::max(4, static_cast<int>(std::ceil(total / kTurnStep)));
    const auto still = [&](double t, double az, const std::string& preset, Json tweak = nullptr) {
      DirectorPlan p;
      p.t = t, p.az = az, p.el = elAt(t), p.margin = rules.margin, p.target = "model", p.preset = preset, p.tweak = std::move(tweak);
      return p;
    };
    plans.push_back(still(0, az0, "orbit", flow));
    if (start > 0.3) plans.push_back(still(start, az0, "orbit", flow));
    for (int i = 1; i <= steps; ++i) {
      const double u = static_cast<double>(i) / steps;
      plans.push_back(still(lerp(start, orbitEnd, u), az0 + total * std::pow(u, ease), i == steps ? "swoop" : "orbit",
                            i == steps ? Json(nullptr) : flow));
    }
    // the whip onto the front, then a still hold
    DirectorPlan hold;
    hold.t = std::min(tl.duration, end + 0.05), hold.az = front, hold.el = rules.elEnd, hold.margin = rules.margin;
    hold.target = "model", hold.preset = "hold";
    tail.push_back(hold);
    if (tl.duration > end + 0.6) {
      DirectorPlan last = hold;
      last.t = tl.duration, last.margin = rules.margin - 0.04, last.preset = "glide";
      tail.push_back(last);
    }
  } else {
    double az = wrapDegrees(front + 35);
    plans.push_back(build(0, az, "glide", 1.15));

    // Showcase: lower onto the front by the middle of the build, then circle round the back
    if (rules.orbitDegrees) {
      const double middle = start + 0.45 * (end - start);
      az = wrapDegrees(front + 20);
      plans.push_back(build(middle, az, "orbit", rules.margin, flow));
      const double orbitEnd = std::min(cutAt, end) - kMinGap - 0.05;
      const int steps = std::max(2, static_cast<int>(std::ceil(*rules.orbitDegrees / 90)));
      for (int i = 1; i <= steps; ++i) {
        const double t = lerp(middle, orbitEnd, static_cast<double>(i) / steps);
        plans.push_back(build(t, az + *rules.orbitDegrees * i / steps, "orbit", rules.margin,
                              {{"orbit", "cw"}, {"flowThrough", i < steps}}));
      }
    }

    // side swings: each window of the build looks from the side most pieces land on
    const double every = lerp(rules.swingEvery[0], rules.swingEvery[1], busy);
    const double swingEnd = std::min(end, cutAt - 0.3);
    if (every > 0 && swingEnd > start) {
      const double win = std::max({1.5, every, (swingEnd - start) / kMaxSwings});
      for (double w0 = start; w0 < swingEnd - 1e-6; w0 += win) {
        const double w1 = std::min(swingEnd, w0 + win);
        double px = 0, py = 0, size = 0;
        for (const auto& l : lands) {
          if (l.t < w0 || l.t >= w1) continue;
          const bm::Vec3 p = centre(l.box) - mid;
          const bm::Vec3 s = l.box.max - l.box.min;
          const double v = std::cbrt(std::max(1e-6, s.x * s.y * s.z));
          px += p.x * v, py += p.z * v, size += v;
        }
        const double reach = std::max(model.max.x - model.min.x, model.max.z - model.min.z) / 2;
        double want;
        if (size != 0 && std::hypot(px, py) / size >= 0.2 * reach) want = wrapDegrees(deg(std::atan2(px, py)));
        // pieces all over (or none): swap to the other three-quarter view of the front
        else want = wrapDegrees(front + (wrapDegrees(az - front) >= 0 ? -35 : 35));
        // keep a three-quarter view of that side rather than flat on
        double target = wrapDegrees(want + 30 * signOr1(wrapDegrees(az - want)));
        // already on that side: cross to its other three-quarter view, so the shot keeps moving
        if (std::abs(wrapDegrees(target - az)) < 30) target = wrapDegrees(want - 30 * signOr1(wrapDegrees(az - want)));
        const double delta = std::abs(wrapDegrees(target - az));
        if (delta < 30) continue;
        const std::string preset = delta > 60 ? rules.big : rules.small;
        const double len = moveLength(preset);
        const double t = std::max(w0, len);
        if (t >= swingEnd) break;
        // one key: the move into it holds the old view, then swings round in its last moment
        az = target;
        DirectorPlan p = build(t, az, "glide", 1.15);
        p.arrive = Arrive{preset, len};
        plans.push_back(std::move(p));
      }
    }

    // pull back and lower before a tall part arrives
    double before = 0;
    for (const auto& l : lands) {
      const double after = std::min(1.0, (std::max(ground, l.box.max.y) - ground) / height);
      if (after - before > kTall && l.t - kPullLead < cutAt - 0.3) {
        const double t = std::max(0.0, l.t - kPullLead);
        const double t0 = std::max(0.0, t - 1);
        plans.push_back(build(t0, azAt(plans, t0), "pull-back", 1.15));
        plans.push_back(build(t, azAt(plans, t), "glide", 1.45));
      }
      before = std::max(before, after);
    }

    const auto frontKey = [&](double t, double el, double margin, const char* preset) {
      DirectorPlan p;
      p.t = t, p.az = front, p.el = el, p.margin = margin, p.target = "model", p.preset = preset;
      return p;
    };
    if (rules.finish == Finish::Cut) {
      // hard cut to a low front view for the last details, then a slow push in; the key
      // before the cut gets the cut (its view holds, following the build, until the cut)
      const double el = rules.finishEl.value_or(rules.elEnd);
      tail.push_back(frontKey(cutAt, el, 1.2, "push-in"));
      tail.push_back(frontKey(tl.duration, el, 1.05, "glide"));
    } else {
      // the reveal: swing to the front, then a slow push in to the end
      const double revealAt = std::min(tl.duration, end + 0.2);
      plans.push_back(build(std::max(0.0, end - 0.9), azAt(plans, end - 0.9), "arc-reveal", 1.15));
      tail.push_back(frontKey(revealAt, rules.elEnd, 1.12, "push-in"));
      if (tl.duration > revealAt + 0.5) tail.push_back(frontKey(tl.duration, rules.elEnd, 1.02, "glide"));
    }
  }

  // in time order, without near-duplicate times; the camera never rises again
  std::stable_sort(plans.begin(), plans.end(), [](const DirectorPlan& a, const DirectorPlan& b) { return a.t < b.t; });
  const double lastBody = tail.empty() ? inf : tail.front().t - kMinGap;
  std::vector<DirectorPlan> kept;
  for (const auto& p : plans) {
    if (p.t > lastBody) continue;
    if (!kept.empty() && p.t - kept.back().t < kMinGap) {
      const DirectorPlan prev = kept.back();
      const DirectorPlan& win = priority(p.preset) >= priority(prev.preset) ? p : prev;
      DirectorPlan merged = p;
      merged.t = prev.t, merged.preset = win.preset, merged.tweak = win.tweak;
      merged.arrive = prev.arrive ? prev.arrive : p.arrive;
      kept.back() = std::move(merged);
      continue;
    }
    kept.push_back(p);
  }
  // the key before a cut finish: its move is the cut
  if (rules.finish == Finish::Cut && !kept.empty()) kept.back().preset = "cut", kept.back().tweak = nullptr;
  const double lastKept = kept.empty() ? -1 : kept.back().t;
  for (const auto& p : tail)
    if (p.t > lastKept + 1e-6) kept.push_back(p);
  for (size_t i = 1; i < kept.size(); ++i)
    if (kept[i].target == "build") kept[i].el = std::min(kept[i].el, kept[i - 1].el);

  Json keys = Json::array();
  for (size_t i = 0; i < kept.size(); ++i) {
    const auto& p = kept[i];
    keys.push_back({{"id", "auto-" + std::to_string(i)},
                    {"t", p.t},
                    {"target", {{"kind", p.target}}},
                    {"offset", {0, 0, 0}},
                    {"azimuth", p.az},
                    {"elevation", p.el},
                    {"distance", {{"fit", true}, {"margin", p.margin}}},
                    {"roll", 0},
                    {"lensMm", lensMm},
                    {"focus", "target"},
                    {"blur", 0},
                    {"origin", "auto"}});
  }
  Json transitions = Json::array();
  for (size_t i = 0; i + 1 < kept.size(); ++i) {
    // a quick swing into the next key (unless this key cuts away) turns late in the gap
    const std::optional<Arrive> arrive = kept[i].preset != "cut" ? kept[i + 1].arrive : std::nullopt;
    const Preset& preset = presetById(arrive ? arrive->preset : kept[i].preset);
    const double gap = kept[i + 1].t - kept[i].t;
    Json settings = preset.settings;
    if (!arrive && kept[i].tweak.is_object())
      for (const auto& [k, v] : kept[i].tweak.items()) settings[k] = v;
    if (arrive && gap > arrive->len + 1e-6) settings["turnLast"] = arrive->len;
    transitions.push_back({{"from", keys[i]["id"]}, {"to", keys[i + 1]["id"]}, {"preset", preset.info.id}, {"settings", settings}, {"origin", "auto"}});
  }
  return {{"keys", keys}, {"transitions", transitions}, {"shutter", shutter}, {"style", style}};
}

Json mergeAuto(const Json& existing, const Json& autoTrack, double duration) {
  const Json old = trackOrEmpty(existing);
  const Json fresh = trackOrEmpty(autoTrack);
  Json mine = Json::array();
  for (const auto& k : old["keys"])
    if (text(k, "origin") == "user") {
      Json m = k;
      m["t"] = std::min(std::max(0.0, keyTime(k)), duration);
      mine.push_back(std::move(m));
    }
  // an automatic key you edited keeps its auto-N id: new automatic keys never reuse it
  std::set<std::string> taken;
  for (const auto& k : mine) taken.insert(text(k, "id"));
  std::map<std::string, std::string> rename;
  for (const auto& k : fresh["keys"]) {
    const std::string base = text(k, "id");
    std::string id = base;
    for (int n = 2; taken.count(id); ++n) id = base + "-" + std::to_string(n);
    taken.insert(id);
    rename[base] = id;
  }
  const auto renamed = [&](const std::string& id) {
    const auto found = rename.find(id);
    return found != rename.end() ? found->second : id;
  };
  Json keys = mine;
  for (const auto& k : fresh["keys"]) {
    bool near = false;
    for (const auto& m : mine) near = near || std::abs(keyTime(m) - keyTime(k)) < 0.4;
    if (near) continue;
    Json a = k;
    a["id"] = renamed(text(k, "id"));
    keys.push_back(std::move(a));
  }
  Json moves = Json::array();
  for (const auto& tr : old["transitions"])
    if (text(tr, "origin") == "user") moves.push_back(tr);
  for (const auto& tr : fresh["transitions"]) {
    Json m = tr;
    m["from"] = renamed(text(tr, "from")), m["to"] = renamed(text(tr, "to"));
    moves.push_back(std::move(m));
  }
  Json out = fresh;
  if (existing.is_object() && existing.contains("shutter")) out["shutter"] = existing["shutter"];
  return finish(std::move(out), std::move(keys), moves);
}

}  // namespace bmapp::camtrack
