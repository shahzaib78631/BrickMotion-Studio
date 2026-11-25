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
#include <unordered_map>
#include <nlohmann/json.hpp>

namespace bmapp {
namespace {

std::string compact(std::string_view text, bool lowercase = false) {
  std::string out;
  out.reserve(text.size());
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

struct CatalogData {
  std::vector<CatalogEntry> entries;
  StringList categories;
  std::unordered_map<std::string_view, size_t> byName;
};

constexpr const char* kCommonParts[] = {"3001.dat", "3003.dat", "3004.dat", "3005.dat", "3020.dat", "3022.dat",
                                        "3023b.dat", "3024.dat", "3068b.dat", "6141.dat", "3700.dat", "2780.dat"};

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

StringList computeTopCategories(const CatalogData& catalog) {
  std::set<std::string> essential;
  for (const auto name : kCommonParts)
    if (const auto it = catalog.byName.find(name); it != catalog.byName.end())
      essential.insert(catalog.entries[it->second].part.category);
  std::map<std::string, size_t> counts;
  for (const CatalogEntry& entry : catalog.entries) {
    if (entry.part.category.empty() || entry.part.category == "FILE") continue;
    counts[entry.part.category]++;
  }
  std::vector<std::pair<std::string, size_t>> ranked(counts.begin(), counts.end());
  constexpr size_t kMaxCategories = 60;
  const size_t keep = std::min(ranked.size(), kMaxCategories);
  std::partial_sort(ranked.begin(), ranked.begin() + keep, ranked.end(), [&](const auto& a, const auto& b) {
    const bool first = essential.contains(a.first), second = essential.contains(b.first);
    if (first != second) return first;
    return a.second != b.second ? a.second > b.second : a.first < b.first;
  });
  StringList out;
  out.reserve(keep);
  for (size_t i = 0; i < keep; i++) out.push_back(std::move(ranked[i].first));
  std::sort(out.begin(), out.end());
  return out;
}

bool loadFromWebCatalogJson(const std::string& ldraw, std::vector<CatalogEntry>& entries) {
  const auto path = std::filesystem::path(ldraw).parent_path() / "data" / "catalog.json";
  std::ifstream file(path);
  if (!file) return false;
  try {
    const auto json = nlohmann::json::parse(file);
    if (!json.is_array() || json.empty()) return false;
    entries.reserve(json.size());
    for (const auto& item : json) {
      if (!item.is_object()) continue;
      const auto idIt = item.find("id");
      const auto nameIt = item.find("name");
      const auto catIt = item.find("category");
      if (idIt == item.end() || nameIt == item.end() || catIt == item.end()) continue;
      if (!idIt->is_string() || !nameIt->is_string() || !catIt->is_string()) continue;
      std::string id = idIt->get<std::string>();
      if (id.empty()) continue;
      std::transform(id.begin(), id.end(), id.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
      if (!id.ends_with(".dat")) id += ".dat";
      std::string description = compact(nameIt->get<std::string>());
      if (description.empty()) continue;
      std::string category = catIt->get<std::string>();
      std::string folded = compact(description, true);
      std::string searchable = id + " " + folded;
      entries.push_back({{std::move(id), std::move(description), std::move(category)}, std::move(folded), std::move(searchable)});
    }
    return !entries.empty();
  } catch (...) {
    entries.clear();
    return false;
  }
}

std::shared_ptr<const CatalogData> catalog(const std::string& ldraw) {
  static std::mutex mutex;
  static std::map<std::string, std::shared_ptr<const CatalogData>> catalogs;
  auto data = std::make_shared<CatalogData>();
  if (ldraw.empty()) return data;
  {
    std::lock_guard lock(mutex);
    if (const auto it = catalogs.find(ldraw); it != catalogs.end()) return it->second;
  }
  // Fast path: load the prebuilt web catalog JSON (single file read, ~15 ms) instead of opening
  // 30,000+ individual .dat files on disk.
  if (!loadFromWebCatalogJson(ldraw, data->entries)) {
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
      data->entries.push_back({std::move(part), folded, std::move(searchable)});
    }
    if (ec) return data;
  }
  std::sort(data->entries.begin(), data->entries.end(), [](const auto& a, const auto& b) { return a.part.name < b.part.name; });
  data->byName.reserve(data->entries.size());
  for (size_t i = 0; i < data->entries.size(); i++) data->byName.emplace(data->entries[i].part.name, i);
  data->categories = computeTopCategories(*data);
  std::lock_guard lock(mutex);
  return catalogs.try_emplace(ldraw, data).first->second;
}

PartMatch resolveDecoratedIfNeeded(const std::string& ldraw, PartMatch part) {
  if (part.category == "FILE" || part.description.starts_with("FILE ")) {
    auto resolved = readPart(std::filesystem::path(ldraw) / "parts" / part.name, part.name);
    if (!resolved.name.empty()) return resolved;
  }
  return part;
}

}  // namespace

std::vector<PartMatch> libraryParts(const std::string& ldraw, const std::string& query,
                                    const std::string& category, size_t limit) {
  if (limit == 0) return {};
  const std::string q = compact(query, true);
  std::vector<std::string> words;
  std::istringstream tokens(q);
  for (std::string word; tokens >> word;) words.push_back(word);
  const auto data = catalog(ldraw);
  struct Hit {
    int rank;
    const CatalogEntry* entry;
  };
  std::vector<Hit> hits;
  for (const CatalogEntry& entry : data->entries) {
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
  for (size_t i = 0; i < count; i++) out.push_back(resolveDecoratedIfNeeded(ldraw, hits[i].entry->part));
  return out;
}

StringList partCategories(const std::string& ldraw) {
  return catalog(ldraw)->categories;
}

std::vector<PartMatch> commonParts(const std::string& ldraw) {
  std::vector<PartMatch> out;
  if (ldraw.empty()) return out;
  const auto data = catalog(ldraw);
  for (const char* name : kCommonParts) {
    if (const auto it = data->byName.find(name); it != data->byName.end())
      out.push_back(data->entries[it->second].part);
  }
  return out;
}

}  // namespace bmapp
