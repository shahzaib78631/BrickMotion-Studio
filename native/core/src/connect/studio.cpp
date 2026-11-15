#include "bm/connect/studio.h"

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <mutex>
#include <shared_mutex>
#include <sstream>
#include <unordered_map>
#include "bm/ldraw/parse.h"

namespace bm::connect {
namespace fs = std::filesystem;
namespace {

constexpr size_t kHead = 4 + 9 * 4 + 3 * 4;  // code, rotation, position
constexpr size_t kPlainTail = 8;             // u16 flags, f32 length, u16 flags
constexpr size_t kPairedTail = 17;
constexpr int kMaxGridCells = 4096;
constexpr double kStud = 20;

template <typename T>
T read(std::string_view b, size_t at) {
  T v;
  std::memcpy(&v, b.data() + at, sizeof v);
  return v;
}

struct Head {
  int32_t code;
  double m[9];  // rows of the frame
  Vec3 pos;
  /// A vector given in the record's frame, in part space (the transpose of the rows).
  Vec3 out(double x, double y, double z) const { return {m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z}; }
  Vec3 axis() const { return normalized(Vec3{-m[3], -m[4], -m[5]}); }  // the frame's -Y
};

bool readHead(std::string_view b, size_t at, Head& h) {
  if (at + kHead > b.size()) return false;
  h.code = read<int32_t>(b, at);
  if (h.code == 0) return false;
  for (int i = 0; i < 9; i++) h.m[i] = read<float>(b, at + 4 + static_cast<size_t>(i) * 4);
  h.pos = {read<float>(b, at + 40), read<float>(b, at + 44), read<float>(b, at + 48)};
  // A real record's frame is a rotation and its position is on the part.
  for (int r = 0; r < 3; r++) {
    const double len = std::sqrt(h.m[r * 3] * h.m[r * 3] + h.m[r * 3 + 1] * h.m[r * 3 + 1] + h.m[r * 3 + 2] * h.m[r * 3 + 2]);
    if (!(std::abs(len - 1) < 1e-3)) return false;
  }
  for (int a = 0; a < 3; a++)
    for (int c = a + 1; c < 3; c++)
      if (std::abs(h.m[a * 3] * h.m[c * 3] + h.m[a * 3 + 1] * h.m[c * 3 + 1] + h.m[a * 3 + 2] * h.m[c * 3 + 2]) > 1e-3) return false;
  for (double v : {h.pos.x, h.pos.y, h.pos.z})
    if (!std::isfinite(v) || std::abs(v) > 5000) return false;
  return true;
}

Connector cylinder(Gender g, char shape, double radius, Vec3 start, Vec3 axis, double length, bool openStart, bool openEnd, bool slide) {
  Connector c;
  c.kind = SnapKind::Cyl;
  c.gender = g;
  c.source = Source::Studio;
  c.start = start;
  c.axis = axis;
  const Vec3 hint = std::abs(axis.x) < 0.9 ? Vec3{1, 0, 0} : Vec3{0, 0, 1};
  c.side = normalized(hint - axis * dot(hint, axis));
  c.length = length;
  c.radius = radius;
  c.profile = {{shape, radius, 0, length}};
  c.openStart = openStart;
  c.openEnd = openEnd;
  c.slide = slide;
  return c;
}

/// A hinge or wheel half. Halves of one family mate: the family is the type number without
/// its lowest bit, and that bit says which half this is.
Connector paired(const Head& h, int kind) {
  const int type = (h.code >> 16) & 0xFFFF;
  Connector c;
  c.kind = SnapKind::Generic;
  c.gender = type & 1 ? Gender::Male : Gender::Female;
  c.source = Source::Studio;
  c.start = h.pos;
  c.axis = h.axis();
  const Vec3 hint = std::abs(c.axis.x) < 0.9 ? Vec3{1, 0, 0} : Vec3{0, 0, 1};
  c.side = normalized(hint - c.axis * dot(hint, c.axis));
  c.group = (kind == 6 ? "studio-hinge-" : "studio-wheel-") + std::to_string(type >> 1);
  c.placement = kind == 6 ? "hinge" : "fixed";
  return c;
}

}  // namespace

std::vector<Connector> parseStudioConn(std::string_view b, bool* complete) {
  std::vector<Connector> out;
  size_t at = 0;
  bool ok = true;
  while (at < b.size()) {
    Head h;
    if (!readHead(b, at, h)) {
      ok = false;
      break;
    }
    const int kind = h.code & 0xFFFF, type = (h.code >> 16) & 0xFFFF;
    const size_t body = at + kHead;
    if (kind == 2 || kind == 3) {
      // A grid of 20 LDU cells; the position is the first cell's corner. Counts are stored doubled.
      if (body + 4 > b.size()) { ok = false; break; }
      const int nz2 = read<int16_t>(b, body), nx2 = read<int16_t>(b, body + 2);
      if (nz2 < 2 || nx2 < 2 || nz2 % 2 || nx2 % 2 || (nx2 / 2) * (nz2 / 2) > kMaxGridCells) { ok = false; break; }
      const int nx = nx2 / 2, nz = nz2 / 2;
      const size_t tail = 8 + 16 * static_cast<size_t>(nx) * static_cast<size_t>(nz) + 8 * static_cast<size_t>(nx + nz);
      if (body + tail > b.size()) { ok = false; break; }
      const bool stud = h.code == 0x170003, antiStud = h.code == 0x2 || h.code == 0x10002;
      if (stud || antiStud)
        for (int i = 0; i < nx; i++)
          for (int j = 0; j < nz; j++)
            out.push_back(cylinder(stud ? Gender::Male : Gender::Female, 'R', 6, h.pos + h.out(kStud / 2 + kStud * i, 0, -(kStud / 2 + kStud * j)), h.axis(), 4, true, false, false));
      at = body + tail;
    } else if (kind == 0) {
      if (body + kPlainTail > b.size()) { ok = false; break; }
      const double length = read<float>(b, body + 2);
      if (std::isfinite(length) && length > 0 && length < 2000) {
        const Vec3 axis = h.axis();
        if (type == 0x2) out.push_back(cylinder(Gender::Female, 'R', 6, h.pos, axis, length, true, true, true));
        else if (type == 0x3) out.push_back(cylinder(Gender::Male, 'R', 6, h.pos + axis * length, axis * -1.0, length, true, false, true));  // stored from the tip
        else if (type == 0x7) out.push_back(cylinder(Gender::Male, 'A', 6, h.pos, axis, length, true, true, true));
        else if (type == 0x6) out.push_back(cylinder(Gender::Female, 'A', 6, h.pos, axis, length, true, true, true));
      }
      at = body + kPlainTail;
    } else if (kind == 6) {
      if (body + kPairedTail > b.size()) { ok = false; break; }
      out.push_back(paired(h, 6));
      at = body + kPairedTail;
    } else if (kind == 4) {
      out.push_back(paired(h, 4));
      ok = false;  // the length of a wheel record's tail is not known: nothing after it is read
      break;
    } else {
      ok = false;
      break;
    }
  }
  if (complete) *complete = ok;
  return out;
}

struct StudioLibrary::State {
  std::unordered_map<std::string, fs::path> index;  // part stem -> file
  mutable std::shared_mutex mutex;
  mutable std::unordered_map<std::string, std::shared_ptr<const std::vector<Connector>>> parsed;
};

StudioLibrary::StudioLibrary(fs::path directory) : state_(std::make_unique<State>()) {
  std::error_code ec;
  if (!fs::is_directory(directory, ec)) return;
  for (auto it = fs::directory_iterator(directory, fs::directory_options::skip_permission_denied, ec); !ec && it != fs::directory_iterator(); it.increment(ec))
    if (ldraw::normalizeName(it->path().extension().string()) == ".conn") state_->index.emplace(ldraw::normalizeName(it->path().stem().string()), it->path());
}

StudioLibrary::~StudioLibrary() = default;
size_t StudioLibrary::size() const { return state_->index.size(); }

std::shared_ptr<const std::vector<Connector>> StudioLibrary::find(std::string_view partName) const {
  static const auto none = std::make_shared<const std::vector<Connector>>();
  std::string stem = ldraw::normalizeName(partName);
  if (stem.size() > 4 && stem.compare(stem.size() - 4, 4, ".dat") == 0) stem.resize(stem.size() - 4);
  fs::path path;
  {
    std::shared_lock lock(state_->mutex);
    if (const auto it = state_->parsed.find(stem); it != state_->parsed.end()) return it->second;
    const auto at = state_->index.find(stem);
    if (at == state_->index.end()) return none;
    path = at->second;
  }
  auto result = none;
  if (std::ifstream in(path, std::ios::binary); in) {
    std::ostringstream bytes;
    bytes << in.rdbuf();
    result = std::make_shared<const std::vector<Connector>>(parseStudioConn(bytes.str()));
  }
  std::unique_lock lock(state_->mutex);
  return state_->parsed.emplace(stem, std::move(result)).first->second;
}

fs::path StudioLibrary::defaultDirectory() {
  if (const char* dir = std::getenv("BM_STUDIO_DIR")) return dir;
  const fs::path mac = "/Applications/Studio 2.0/ldraw/connectivity";
  std::error_code ec;
  return fs::is_directory(mac, ec) ? mac : fs::path();
}

}  // namespace bm::connect
