#include "bmapp/part_catalog.h"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>

namespace bmapp {
namespace {

std::string compact(std::string_view text, bool lowercase = false) {
  std::string out;
  for (unsigned char c : text) {
    if (std::isspace(c)) {
      if (!out.empty() && out.back() != ' ') out += ' ';
    } else {
      out += static_cast<char>(lowercase ? std::tolower(c) : c);
    }
  }
  if (!out.empty() && out.back() == ' ') out.pop_back();
  return out;
}

struct CatalogEntry {
  PartMatch part;
  std::string descriptionFolded;
  std::string searchable;
};

PartMatch readPart(const std::filesystem::path& path, std::string name) {
  std::ifstream file(path);
  std::string line;
  if (!std::getline(file, line)) return {};
  line = compact(line);
  // Decorated parts can be MPDs whose first comment names the file rather than the part.
  if (line.starts_with("0 FILE ")) {
    do {
      if (!std::getline(file, line)) return {};
      line = compact(line);
    } while (line.empty());
  }
  if (!line.starts_with("0 ") || line.size() < 3 || line[2] == '~') return {};
  std::string description = line.substr(2);
  // LDraw uses the description's first word as the category when !CATEGORY is absent.
  const size_t first = description.find_first_not_of("_=|");
  std::string category = first == std::string::npos ? "Other" : description.substr(first, description.find(' ', first) - first);
  for (const auto prefix = std::string_view("0 !CATEGORY "); std::getline(file, line);) {
    line = compact(line);
    if (line.empty()) continue;
    if (line[0] != '0') break;
    if (line.starts_with(prefix)) {
      category = line.substr(prefix.size());
      break;
    }
  }
  return {std::move(name), std::move(description), std::move(category)};
}

std::shared_ptr<const std::vector<CatalogEntry>> catalog(const std::string& ldraw) {
  static std::mutex mutex;
  static std::map<std::string, std::shared_ptr<const std::vector<CatalogEntry>>> catalogs;
  auto entries = std::make_shared<std::vector<CatalogEntry>>();
  if (ldraw.empty()) return entries;
  {
    std::lock_guard lock(mutex);
    if (const auto it = catalogs.find(ldraw); it != catalogs.end()) return it->second;
  }
  std::error_code ec;
  const auto directory = std::filesystem::path(ldraw) / "parts";
  for (auto it = std::filesystem::directory_iterator(directory, ec); !ec && it != std::filesystem::directory_iterator{}; it.increment(ec)) {
    std::string name = it->path().filename().string();
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (name.size() <= 4 || !name.ends_with(".dat")) continue;
    auto part = readPart(it->path(), std::move(name));
    if (part.name.empty()) continue;
    const std::string folded = compact(part.description, true);
    std::string searchable = part.name + " " + folded;
    entries->push_back({std::move(part), folded, std::move(searchable)});
  }
  if (ec) return entries;
  std::sort(entries->begin(), entries->end(), [](const auto& a, const auto& b) { return a.part.name < b.part.name; });
  std::lock_guard lock(mutex);
  return catalogs.try_emplace(ldraw, entries).first->second;
}

}  // namespace

std::vector<PartMatch> libraryParts(const std::string& ldraw, const std::string& query,
                                    const std::string& category, size_t limit) {
  if (limit == 0) return {};
  const std::string q = compact(query, true);
  std::vector<std::string> words;
  std::istringstream tokens(q);
  for (std::string word; tokens >> word;) words.push_back(word);
  const auto entries = catalog(ldraw);
  struct Hit {
    int rank;
    const CatalogEntry* entry;
  };
  std::vector<Hit> hits;
  for (const CatalogEntry& entry : *entries) {
    if (!category.empty() && category != entry.part.category) continue;
    if (!std::all_of(words.begin(), words.end(), [&](const auto& word) { return entry.searchable.find(word) != std::string::npos; })) continue;
    const std::string_view stem(entry.part.name.data(), entry.part.name.size() - 4);
    const std::string& description = entry.descriptionFolded;
    const int rank = entry.part.name == q || stem == q ? 0 :
      description == q ? 1 : description.starts_with(q) ? 2 : stem.starts_with(q) ? 3 : 4;
    hits.push_back({rank, &entry});
  }
  const size_t count = std::min(hits.size(), limit);
  std::partial_sort(hits.begin(), hits.begin() + count, hits.end(), [&](const Hit& a, const Hit& b) {
    if (q.empty() && a.entry->descriptionFolded != b.entry->descriptionFolded)
      return a.entry->descriptionFolded < b.entry->descriptionFolded;
    if (a.rank != b.rank) return a.rank < b.rank;
    if (a.entry->part.description.size() != b.entry->part.description.size())
      return a.entry->part.description.size() < b.entry->part.description.size();
    return a.entry->part.name < b.entry->part.name;
  });
  std::vector<PartMatch> out;
  out.reserve(count);
  for (size_t i = 0; i < count; i++) out.push_back(hits[i].entry->part);
  return out;
}

StringList partCategories(const std::string& ldraw) {
  const auto entries = catalog(ldraw);
  std::set<std::string> names;
  for (const CatalogEntry& entry : *entries) names.insert(entry.part.category);
  return {names.begin(), names.end()};
}

std::vector<PartMatch> commonParts(const std::string& ldraw) {
  std::vector<PartMatch> out;
  if (ldraw.empty()) return out;
  const auto directory = std::filesystem::path(ldraw) / "parts";
  for (const char* name : {"3001.dat", "3003.dat", "3004.dat", "3005.dat", "3020.dat", "3022.dat",
                           "3023b.dat", "3024.dat", "3068b.dat", "6141.dat", "3700.dat", "2780.dat"}) {
    auto part = readPart(directory / name, name);
    if (!part.name.empty()) out.push_back(std::move(part));
  }
  return out;
}

}  // namespace bmapp
