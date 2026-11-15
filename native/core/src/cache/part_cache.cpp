#include "bm/ldraw/part_cache.h"

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <atomic>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <mutex>
#include <unordered_map>

namespace bm::ldraw {
namespace fs = std::filesystem;

namespace {

constexpr char kMagic[4] = {'B', 'M', 'P', '1'};
constexpr uint32_t kVersion = 1;

// File layout, little-endian (the only byte order this engine runs on):
//   Header, then the payload: dependency table, missing-name table, bounds, the four arrays.
struct Header {
  char magic[4];
  uint32_t version;
  uint32_t options;
  uint32_t reserved;
  uint64_t sourceHash;
  uint64_t payloadBytes;
  uint64_t payloadChecksum;
};
static_assert(sizeof(Header) == 40);

uint32_t optionBits(const FlattenOptions& o) { return (o.hiResPrimitives ? 1u : 0u) | (o.logoStuds ? 2u : 0u); }

uint64_t checksum(const unsigned char* data, size_t size) {
  uint64_t h = 0x9E3779B97F4A7C15ull ^ size;
  size_t i = 0;
  for (; i + 8 <= size; i += 8) {
    uint64_t w;
    std::memcpy(&w, data + i, 8);
    h = (h ^ w) * 0xFF51AFD7ED558CCDull;
    h ^= h >> 32;
  }
  for (; i < size; i++) h = (h ^ data[i]) * 1099511628211ull;
  return h;
}

struct Writer {
  std::string out;
  template <typename T>
  void put(const T& v) { out.append(reinterpret_cast<const char*>(&v), sizeof v); }
  void text(const std::string& s) {
    put(static_cast<uint32_t>(s.size()));
    out.append(s);
  }
  template <typename T>
  void array(const std::vector<T>& v) {
    put(static_cast<uint64_t>(v.size()));
    out.append(reinterpret_cast<const char*>(v.data()), v.size() * sizeof(T));
  }
};

/// Bounds-checked reader: every read reports failure instead of running off the end.
struct Reader {
  const unsigned char* at;
  const unsigned char* end;
  bool ok = true;
  template <typename T>
  T get() {
    T v{};
    if (static_cast<size_t>(end - at) < sizeof v) ok = false;
    else {
      std::memcpy(&v, at, sizeof v);
      at += sizeof v;
    }
    return v;
  }
  std::string text() {
    const uint32_t n = get<uint32_t>();
    if (!ok || static_cast<size_t>(end - at) < n) {
      ok = false;
      return {};
    }
    std::string s(reinterpret_cast<const char*>(at), n);
    at += n;
    return s;
  }
  template <typename T>
  void array(std::vector<T>& v) {
    const uint64_t n = get<uint64_t>();
    if (!ok || n > static_cast<size_t>(end - at) / sizeof(T)) {
      ok = false;
      return;
    }
    v.resize(n);
    std::memcpy(v.data(), at, n * sizeof(T));
    at += n * sizeof(T);
  }
};

std::string encode(const Mesh& m) {
  Writer w;
  w.put(static_cast<uint32_t>(m.deps.size()));
  for (const auto& [name, stamp] : m.deps) {
    w.text(name);
    w.put(stamp);
  }
  w.put(static_cast<uint32_t>(m.missing.size()));
  for (const std::string& name : m.missing) w.text(name);
  for (double v : {m.bounds.min.x, m.bounds.min.y, m.bounds.min.z, m.bounds.max.x, m.bounds.max.y, m.bounds.max.z}) w.put(v);
  w.array(m.positions);
  w.array(m.triangles);
  w.array(m.triColor);
  w.array(m.edges);
  return std::move(w.out);
}

bool decode(const unsigned char* data, size_t size, Mesh& m) {
  Reader r{data, data + size};
  const uint32_t deps = r.get<uint32_t>();
  for (uint32_t i = 0; r.ok && i < deps; i++) {
    std::string name = r.text();
    const uint64_t stamp = r.get<uint64_t>();
    m.deps.emplace_back(std::move(name), stamp);
  }
  const uint32_t missing = r.get<uint32_t>();
  for (uint32_t i = 0; r.ok && i < missing; i++) m.missing.push_back(r.text());
  double b[6];
  for (double& v : b) v = r.get<double>();
  m.bounds.min = {b[0], b[1], b[2]};
  m.bounds.max = {b[3], b[4], b[5]};
  r.array(m.positions);
  r.array(m.triangles);
  r.array(m.triColor);
  r.array(m.edges);
  if (!r.ok || r.at != r.end) return false;
  // Indices must point at real vertices: a mesh that decodes but indexes out of range would
  // crash its users later.
  const size_t vertices = m.positions.size() / 3;
  if (m.positions.size() % 3 || m.triangles.size() % 3 || m.edges.size() % 6 || m.triColor.size() != m.triangles.size() / 3) return false;
  for (uint32_t i : m.triangles)
    if (i >= vertices) return false;
  return true;
}

/// A read-only mapping of a whole file; empty if it cannot be opened.
struct Mapping {
  const unsigned char* data = nullptr;
  size_t size = 0;
  explicit Mapping(const fs::path& path) {
    const int fd = ::open(path.c_str(), O_RDONLY);
    if (fd < 0) return;
    struct stat st {};
    if (::fstat(fd, &st) == 0 && st.st_size > 0) {
      void* p = ::mmap(nullptr, static_cast<size_t>(st.st_size), PROT_READ, MAP_PRIVATE, fd, 0);
      if (p != MAP_FAILED) {
        data = static_cast<const unsigned char*>(p);
        size = static_cast<size_t>(st.st_size);
      }
    }
    ::close(fd);
  }
  ~Mapping() {
    if (data) ::munmap(const_cast<unsigned char*>(data), size);
  }
  Mapping(const Mapping&) = delete;
  Mapping& operator=(const Mapping&) = delete;
};

}  // namespace

struct PartCache::State {
  const Library& library;
  fs::path dir;
  FlattenOptions options;

  struct Entry {
    std::once_flag once;
    std::shared_ptr<const Mesh> mesh;
  };
  std::mutex mutex;  // guards entries
  std::unordered_map<std::string, std::shared_ptr<Entry>> entries;
  std::atomic<size_t> memoryHits{0}, diskHits{0}, flattened{0}, rebuilt{0};
  std::atomic<unsigned> tempCounter{0};

  fs::path fileFor(const std::string& name) const {
    std::string flat = name;
    for (char& c : flat)
      if (c == '/') c = '_';
    return dir / (flat + "." + std::to_string(optionBits(options)) + ".bmp1");
  }

  /// Reads a cache file. `exists` reports whether there was a file at all.
  std::shared_ptr<const Mesh> read(const fs::path& path, bool& exists) const {
    std::error_code ec;
    exists = fs::exists(path, ec);
    if (!exists) return nullptr;
    const Mapping map(path);
    if (map.size < sizeof(Header)) return nullptr;
    Header h;
    std::memcpy(&h, map.data, sizeof h);
    if (std::memcmp(h.magic, kMagic, 4) != 0 || h.version != kVersion || h.options != optionBits(options)) return nullptr;
    if (h.payloadBytes != map.size - sizeof(Header)) return nullptr;
    const unsigned char* payload = map.data + sizeof(Header);
    if (checksum(payload, h.payloadBytes) != h.payloadChecksum) return nullptr;
    auto mesh = std::make_shared<Mesh>();
    if (!decode(payload, h.payloadBytes, *mesh)) return nullptr;
    // Unchanged sources: every file it was made from still has the stamp it had then.
    for (const auto& [name, stamp] : mesh->deps)
      if (library.stamp(name) != stamp) return nullptr;
    mesh->sourceHash = hashDeps(mesh->deps);
    if (mesh->sourceHash != h.sourceHash) return nullptr;
    return mesh;
  }

  /// Writes to a temporary file and renames it into place, so a reader never sees half a file.
  void write(const fs::path& path, const Mesh& mesh) {
    std::error_code ec;
    fs::create_directories(dir, ec);
    if (ec) return;
    const std::string payload = encode(mesh);
    Header h{};
    std::memcpy(h.magic, kMagic, 4);
    h.version = kVersion;
    h.options = optionBits(options);
    h.sourceHash = mesh.sourceHash;
    h.payloadBytes = payload.size();
    h.payloadChecksum = checksum(reinterpret_cast<const unsigned char*>(payload.data()), payload.size());
    const fs::path temp = path.string() + ".tmp" + std::to_string(::getpid()) + "_" + std::to_string(tempCounter++);
    {
      std::ofstream out(temp, std::ios::binary | std::ios::trunc);
      out.write(reinterpret_cast<const char*>(&h), sizeof h);
      out.write(payload.data(), static_cast<std::streamsize>(payload.size()));
      out.close();
      if (!out) {
        fs::remove(temp, ec);
        return;
      }
    }
    fs::rename(temp, path, ec);
    if (ec) fs::remove(temp, ec);
  }

  std::shared_ptr<const Mesh> build(const std::string& name) {
    const bool onDisk = !library.isInline(name) && library.resolve(name).has_value();
    if (!onDisk) {
      flattened++;
      return std::make_shared<const Mesh>(flatten(name, library, options));
    }
    const fs::path path = fileFor(name);
    bool existed = false;
    if (auto mesh = read(path, existed)) {
      diskHits++;
      return mesh;
    }
    (existed ? rebuilt : flattened)++;
    auto mesh = std::make_shared<const Mesh>(flatten(name, library, options));
    write(path, *mesh);
    return mesh;
  }
};

PartCache::PartCache(const Library& library, fs::path cacheDir, FlattenOptions options)
    : state_(new State{library, std::move(cacheDir), options, {}, {}, {}, {}, {}, {}, {}}) {}

PartCache::~PartCache() = default;

std::shared_ptr<const Mesh> PartCache::get(std::string_view partName) {
  std::string name = normalizeName(partName);
  if (name.find('.') == std::string::npos) name += ".dat";
  std::shared_ptr<State::Entry> entry;
  {
    std::lock_guard lock(state_->mutex);
    auto& slot = state_->entries[name];
    if (!slot) slot = std::make_shared<State::Entry>();
    entry = slot;
  }
  bool built = false;
  std::call_once(entry->once, [&] {
    entry->mesh = state_->build(name);
    built = true;
  });
  if (!built) state_->memoryHits++;
  return entry->mesh;
}

PartCache::Stats PartCache::stats() const { return {state_->memoryHits, state_->diskHits, state_->flattened, state_->rebuilt}; }

fs::path PartCache::defaultDirectory() {
  const char* home = std::getenv("HOME");
  return fs::path(home ? home : "/tmp") / "Library" / "Caches" / "BrickMotion" / "parts";
}

}  // namespace bm::ldraw
