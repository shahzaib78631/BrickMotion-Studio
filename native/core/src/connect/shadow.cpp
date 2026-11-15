#include "bm/connect/shadow.h"

#include <cmath>
#include <cstdlib>
#include <fstream>
#include <mutex>
#include <shared_mutex>
#include <sstream>
#include <unordered_map>
#include "bm/ldraw/parse.h"

namespace bm::connect {
namespace fs = std::filesystem;
namespace {

constexpr double kDefaultFingerRadius = 4;  // the library's usual value, for fingers that omit it
constexpr size_t kMaxGridCopies = 4096;

std::string lower(std::string_view s) {
  std::string out(s);
  for (char& c : out)
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  return out;
}

std::string_view trim(std::string_view s) {
  auto space = [](char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; };
  while (!s.empty() && space(s.front())) s.remove_prefix(1);
  while (!s.empty() && space(s.back())) s.remove_suffix(1);
  return s;
}

std::vector<std::string_view> words(std::string_view s) {
  std::vector<std::string_view> out;
  size_t i = 0;
  while (i < s.size()) {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t')) i++;
    size_t j = i;
    while (j < s.size() && s[j] != ' ' && s[j] != '\t') j++;
    if (j > i) out.push_back(s.substr(i, j - i));
    i = j;
  }
  return out;
}

bool number(std::string_view tok, double& out) {
  char buf[64];
  if (tok.empty() || tok.size() >= sizeof buf) return false;
  tok.copy(buf, tok.size());
  buf[tok.size()] = '\0';
  char* end = nullptr;
  out = std::strtod(buf, &end);
  return end == buf + tok.size() && std::isfinite(out);
}

/// All numbers of a value, or an empty list if any token is not a number.
std::vector<double> numbers(std::string_view value) {
  std::vector<double> out;
  for (std::string_view w : words(value)) {
    double v;
    if (!number(w, v)) return {};
    out.push_back(v);
  }
  return out;
}

/// `[key=value]` pairs of one line; keys lower-cased, values trimmed.
std::unordered_map<std::string, std::string> params(std::string_view text) {
  std::unordered_map<std::string, std::string> out;
  size_t at = 0;
  while ((at = text.find('[', at)) != std::string_view::npos) {
    const size_t close = text.find(']', at);
    if (close == std::string_view::npos) break;
    const std::string_view body = text.substr(at + 1, close - at - 1);
    const size_t eq = body.find('=');
    // A '[' inside the body means the previous bracket was never closed: not a parameter.
    if (eq != std::string_view::npos && body.find('[') == std::string_view::npos) out.emplace(lower(trim(body.substr(0, eq))), std::string(trim(body.substr(eq + 1))));
    at = close + 1;
  }
  return out;
}

std::vector<Frame> frames(const std::unordered_map<std::string, std::string>& p) {
  auto get = [&](const char* key) -> std::string_view {
    const auto it = p.find(key);
    return it == p.end() ? std::string_view() : std::string_view(it->second);
  };
  const std::vector<double> pos = numbers(get("pos")), ori = numbers(get("ori"));
  Frame base;
  if (pos.size() == 3) base.t = {pos[0], pos[1], pos[2]};
  if (ori.size() == 9)
    for (int i = 0; i < 9; i++) base.r.m[i] = ori[static_cast<size_t>(i)];
  std::vector<Frame> out;
  for (const Vec3& o : gridOffsets(get("grid"))) out.push_back({base.r, base.t + base.r * o});
  return out;
}

std::vector<Section> sections(std::string_view value) {
  const std::vector<std::string_view> t = words(value);
  std::vector<Section> out;
  for (size_t k = 0; k + 2 < t.size(); k += 3) {
    const std::string shape = lower(t[k]);
    Section s;
    if (shape == "r") s.shape = 'R';
    else if (shape == "a") s.shape = 'A';
    else if (shape == "s") s.shape = 'S';
    else if (shape == "l_" || shape == "_l") s.shape = 'L';
    else return {};
    if (!number(t[k + 1], s.radius) || !number(t[k + 2], s.length) || s.radius <= 0 || s.length < 0) return {};
    out.push_back(s);
  }
  return t.size() % 3 == 0 ? out : std::vector<Section>{};
}

}  // namespace

std::vector<Vec3> gridOffsets(std::string_view grid) {
  const std::vector<Vec3> single{{0, 0, 0}};
  const std::vector<std::string_view> t = words(grid);
  if (t.empty()) return single;
  size_t k = 0;
  struct Axis {
    bool centred = false;
    double count = 0;
    bool ok = false;
  };
  auto axis = [&]() {
    Axis a;
    if (k < t.size() && (t[k] == "C" || t[k] == "c")) {
      a.centred = true;
      k++;
    }
    a.ok = k < t.size() && number(t[k], a.count);
    k++;
    a.count = std::max(1.0, std::round(a.count));
    return a;
  };
  const Axis x = axis(), z = axis();
  double sx = 0, sz = 0;
  if (!x.ok || !z.ok || k + 1 >= t.size() || !number(t[k], sx) || !number(t[k + 1], sz)) return single;
  if (x.count * z.count > static_cast<double>(kMaxGridCopies)) return single;
  auto along = [](const Axis& a, double step, int i) { return a.centred ? (i - (a.count - 1) / 2) * step : i * step; };
  std::vector<Vec3> out;
  for (int i = 0; i < static_cast<int>(x.count); i++)
    for (int j = 0; j < static_cast<int>(z.count); j++) out.push_back({along(x, sx, i), 0, along(z, sz, j)});
  return out;
}

ShadowInfo parseShadow(std::string_view text) {
  ShadowInfo info;
  size_t at = 0;
  while (at <= text.size()) {
    size_t end = text.find('\n', at);
    if (end == std::string_view::npos) end = text.size();
    std::string_view line = trim(text.substr(at, end - at));
    at = end + 1;
    // "0 !LDCAD SNAP_xxx ..."; a commented-out "0 //!LDCAD" does not match.
    const std::vector<std::string_view> head = words(line.substr(0, std::min<size_t>(line.size(), 64)));
    if (head.size() < 3 || head[0] != "0" || lower(head[1]) != "!ldcad") continue;
    const std::string cmd = lower(head[2]);
    if (cmd.rfind("snap_", 0) != 0) continue;
    const auto p = params(line);
    auto get = [&](const char* key) -> std::string {
      const auto it = p.find(key);
      return it == p.end() ? std::string() : it->second;
    };
    auto gender = [&](const char* key, Gender& out) {
      const std::string v = lower(get(key));
      if (v == "m") out = Gender::Male;
      else if (v == "f") out = Gender::Female;
      else return false;
      return true;
    };
    SnapDef def;
    def.id = lower(get("id"));
    def.group = lower(get("group"));
    def.frames = frames(p);
    def.center = lower(get("center")) == "true";
    def.slide = lower(get("slide")) == "true";
    if (cmd == "snap_clear") {
      if (def.id.empty()) info.clearAll = true;
      else info.clearIds.push_back(def.id);
    } else if (cmd == "snap_incl") {
      const std::string ref = ldraw::normalizeName(get("ref"));
      if (!ref.empty()) info.includes.push_back({ref, def.frames});
    } else if (cmd == "snap_cyl") {
      def.kind = SnapKind::Cyl;
      def.sections = sections(get("secs"));
      if (const std::string caps = lower(get("caps")); !caps.empty()) def.caps = caps;
      if (gender("gender", def.gender) && !def.sections.empty()) info.snaps.push_back(std::move(def));
    } else if (cmd == "snap_clp") {
      def.kind = SnapKind::Clip;
      def.gender = Gender::Female;
      const bool ok = number(get("radius"), def.radius) && def.radius > 0;
      if (!number(get("length"), def.length) || def.length < 0) def.length = 0;
      if (ok) info.snaps.push_back(std::move(def));
    } else if (cmd == "snap_fgr") {
      def.kind = SnapKind::Finger;
      def.seq = numbers(get("seq"));
      // Fingers are laid out about their position: a one-finger half and the two-finger half
      // it sits in are both written at the hinge's centre.
      def.center = lower(get("center")) != "false";
      if (p.count("radius") == 0) def.radius = kDefaultFingerRadius;
      else if (!number(get("radius"), def.radius) || def.radius <= 0) continue;
      if (gender("genderofs", def.gender) && !def.seq.empty()) info.snaps.push_back(std::move(def));
    } else if (cmd == "snap_gen") {
      def.kind = SnapKind::Generic;
      def.bounding = lower(get("bounding"));
      def.match = lower(get("match"));
      def.placement = lower(get("placement"));
      if (gender("gender", def.gender)) info.snaps.push_back(std::move(def));
    }
  }
  return info;
}

struct ShadowLibrary::State {
  std::unordered_map<std::string, fs::path> index;
  mutable std::shared_mutex mutex;
  mutable std::unordered_map<std::string, std::unique_ptr<ShadowInfo>> parsed;

  void scan(const fs::path& dir) {
    std::error_code ec;
    if (!fs::is_directory(dir, ec)) return;
    const size_t prefix = dir.generic_string().size() + 1;
    for (auto it = fs::recursive_directory_iterator(dir, fs::directory_options::skip_permission_denied, ec); !ec && it != fs::recursive_directory_iterator(); it.increment(ec)) {
      if (!it->is_regular_file(ec)) continue;
      const std::string full = it->path().generic_string();
      if (full.size() > prefix && ldraw::normalizeName(it->path().extension().string()) == ".dat") index.emplace(ldraw::normalizeName(std::string_view(full).substr(prefix)), it->path());
    }
  }
};

ShadowLibrary::ShadowLibrary(fs::path root) : state_(std::make_unique<State>()) {
  state_->scan(root / "parts");
  state_->scan(root / "p");
}

ShadowLibrary::~ShadowLibrary() = default;

size_t ShadowLibrary::size() const { return state_->index.size(); }

const ShadowInfo* ShadowLibrary::find(std::string_view rawName) const {
  const std::string name = ldraw::normalizeName(rawName);
  fs::path path;
  {
    std::shared_lock lock(state_->mutex);
    if (const auto it = state_->parsed.find(name); it != state_->parsed.end()) return it->second.get();
    const auto at = state_->index.find(name);
    if (at == state_->index.end()) return nullptr;
    path = at->second;
  }
  std::unique_ptr<ShadowInfo> info;
  if (std::ifstream in(path, std::ios::binary); in) {
    std::ostringstream text;
    text << in.rdbuf();
    info = std::make_unique<ShadowInfo>(parseShadow(text.str()));
  }
  std::unique_lock lock(state_->mutex);
  return state_->parsed.emplace(name, std::move(info)).first->second.get();
}

}  // namespace bm::connect
