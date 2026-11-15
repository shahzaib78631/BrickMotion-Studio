#include "bm/ldraw/library.h"

#include <fstream>
#include <mutex>
#include <shared_mutex>
#include <sstream>

namespace bm::ldraw {
namespace fs = std::filesystem;

namespace {

bool isLDrawFile(const fs::path& p) {
  const std::string ext = normalizeName(p.extension().string());
  return ext == ".dat" || ext == ".ldr" || ext == ".mpd";
}

std::optional<std::string> readText(const fs::path& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return std::nullopt;
  std::ostringstream out;
  out << in.rdbuf();
  return std::move(out).str();
}

}  // namespace

struct Library::Disk {
  std::unordered_map<std::string, fs::path> index;  // normalised name -> file
  std::unordered_map<int, Color> colors;
  mutable std::shared_mutex mutex;  // guards index and parsed
  mutable std::unordered_map<std::string, std::unique_ptr<File>> parsed;  // null: unreadable
  mutable std::unordered_map<std::string, uint64_t> stamps;

  /// Lists `dir` under names relative to it. The first file to claim a name keeps it.
  void scan(const fs::path& dir, bool recursive) {
    std::error_code ec;
    if (!fs::is_directory(dir, ec)) return;
    const size_t prefix = dir.generic_string().size() + 1;
    auto add = [&](const fs::directory_entry& e) {
      if (!e.is_regular_file(ec) || !isLDrawFile(e.path())) return;
      // The name is the path below `dir`; cut by length, since fs::relative is slow over 25,000 files.
      const std::string full = e.path().generic_string();
      if (full.size() > prefix) index.emplace(normalizeName(std::string_view(full).substr(prefix)), e.path());
    };
    if (recursive) {
      for (auto it = fs::recursive_directory_iterator(dir, fs::directory_options::skip_permission_denied, ec); !ec && it != fs::recursive_directory_iterator(); it.increment(ec)) add(*it);
    } else {
      for (auto it = fs::directory_iterator(dir, fs::directory_options::skip_permission_denied, ec); !ec && it != fs::directory_iterator(); it.increment(ec)) add(*it);
    }
  }

  void addRoot(const fs::path& root) {
    std::unique_lock lock(mutex);
    scan(root / "parts", true);
    scan(root / "p", true);
    scan(root / "models", true);
    scan(root, false);
    scan(root / "unofficial" / "parts", true);
    scan(root / "unofficial" / "p", true);
  }
};

Library::Library(fs::path root) : disk_(std::make_shared<Disk>()) {
  disk_->addRoot(root);
  if (const auto text = readText(root / "LDConfig.ldr")) disk_->colors = parseColors(*text);
}

void Library::addSearchRoot(fs::path root) { disk_->addRoot(root); }

Library Library::withInline(std::vector<File> files) const {
  auto map = std::make_shared<std::unordered_map<std::string, File>>();
  if (inline_) *map = *inline_;
  for (File& f : files) {
    std::string name = f.name;
    map->insert_or_assign(std::move(name), std::move(f));
  }
  Library out = *this;
  out.inline_ = std::move(map);
  return out;
}

bool Library::isInline(std::string_view name) const { return inline_ && inline_->count(normalizeName(name)) > 0; }

const File* Library::find(std::string_view rawName) const {
  const std::string name = normalizeName(rawName);
  if (inline_) {
    if (const auto it = inline_->find(name); it != inline_->end()) return &it->second;
  }
  fs::path path;
  {
    std::shared_lock lock(disk_->mutex);
    if (const auto it = disk_->parsed.find(name); it != disk_->parsed.end()) return it->second.get();
    const auto at = disk_->index.find(name);
    if (at == disk_->index.end()) return nullptr;
    path = at->second;
  }
  // Parsed outside the lock; if two threads race, the first one stored wins and both return it.
  std::unique_ptr<File> file;
  if (const auto text = readText(path)) file = std::make_unique<File>(parse(*text, name));
  std::unique_lock lock(disk_->mutex);
  return disk_->parsed.emplace(name, std::move(file)).first->second.get();
}

std::optional<fs::path> Library::resolve(std::string_view rawName) const {
  const std::string name = normalizeName(rawName);
  std::shared_lock lock(disk_->mutex);
  const auto at = disk_->index.find(name);
  if (at == disk_->index.end()) return std::nullopt;
  return at->second;
}

uint64_t Library::contentHash(std::string_view name) const {
  const File* f = find(name);
  return f ? f->hash : 0;
}

uint64_t Library::stamp(std::string_view rawName) const {
  const std::string name = normalizeName(rawName);
  if (inline_) {
    if (const auto it = inline_->find(name); it != inline_->end()) return it->second.hash;
  }
  fs::path path;
  {
    std::shared_lock lock(disk_->mutex);
    if (const auto it = disk_->stamps.find(name); it != disk_->stamps.end()) return it->second;
    const auto at = disk_->index.find(name);
    if (at == disk_->index.end()) return 0;
    path = at->second;
  }
  std::error_code ec;
  const auto size = fs::file_size(path, ec);
  const auto time = fs::last_write_time(path, ec).time_since_epoch().count();
  uint64_t h = ec ? 0 : (static_cast<uint64_t>(size) * 0x9E3779B97F4A7C15ull) ^ (static_cast<uint64_t>(time) * 0xC2B2AE3D27D4EB4Full);
  if (!ec && h == 0) h = 1;
  std::unique_lock lock(disk_->mutex);
  return disk_->stamps.emplace(name, h).first->second;
}

const std::unordered_map<int, Color>& Library::colors() const { return disk_->colors; }

}  // namespace bm::ldraw
