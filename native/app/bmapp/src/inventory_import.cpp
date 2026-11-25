#include "inventory_import_impl.h"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <map>
#include <set>
#include <sstream>
#include <string_view>
#include "bm/ldraw/mesh.h"

namespace bmapp {
namespace {

constexpr size_t kInventoryLimit = 200000;
constexpr double kGap = 12;

struct Row {
  std::string name;
  int color = 0;
  size_t quantity = 1;
  bool spare = false;
};

std::string_view trim(std::string_view text) {
  const auto first = text.find_first_not_of(" \t\r\n");
  return first == text.npos ? std::string_view{} : text.substr(first, text.find_last_not_of(" \t\r\n") - first + 1);
}

std::string folded(std::string_view text) {
  std::string out(trim(text));
  for (char& c : out)
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  return out;
}

template<class Number>
bool number(std::string_view text, Number& result) {
  text = trim(text);
  if (text.empty()) return false;
  const auto [last, error] = std::from_chars(text.data(), text.data() + text.size(), result);
  return error == std::errc{} && last == text.data() + text.size();
}

std::vector<std::string> csvFields(std::string_view line) {
  std::vector<std::string> fields;
  while (true) {
    line = trim(line);
    std::string field;
    if (line.starts_with('"')) {
      line.remove_prefix(1);
      bool closed = false;
      while (!line.empty()) {
        const char c = line.front();
        line.remove_prefix(1);
        if (c == '"') {
          if (!line.starts_with('"')) { closed = true; break; }
          line.remove_prefix(1);
        }
        field += c;
      }
      line = trim(line);
      if (!closed || (!line.empty() && line.front() != ',')) return {};
    } else {
      const auto comma = line.find(',');
      field = trim(line.substr(0, comma));
      line.remove_prefix(comma == line.npos ? line.size() : comma);
    }
    fields.push_back(std::move(field));
    if (line.empty()) return fields;
    line.remove_prefix(1);
  }
}

std::vector<Row> readCsv(std::istream& file, InventoryReport& out) {
  std::vector<Row> rows;
  size_t part = 0, color = 1, quantity = 2, spare = 3;
  bool firstLine = true, header = false;
  std::string raw;
  while (std::getline(file, raw)) {
    std::string_view line = trim(raw);
    if (firstLine && line.starts_with("\xef\xbb\xbf")) line = trim(line.substr(3));
    if (line.empty()) continue;
    const auto fields = csvFields(line);
    header = firstLine;
    if (firstLine) {
      firstLine = false;
      const auto column = [&](std::string_view name, std::string_view alternate) {
        const auto found = std::find_if(fields.begin(), fields.end(), [&](const auto& value) {
          const auto key = folded(value);
          return key == name || key == alternate;
        });
        return static_cast<size_t>(found - fields.begin());
      };
      const auto partColumn = column("part", "part_num");
      const auto colorColumn = column("color", "color_id");
      const auto quantityColumn = column("quantity", "qty");
      if (partColumn < fields.size() && colorColumn < fields.size() && quantityColumn < fields.size()) {
        part = partColumn;
        color = colorColumn;
        quantity = quantityColumn;
        spare = column("is spare", "is_spare");
        if (spare == fields.size()) spare = SIZE_MAX;
        continue;
      }
    }
    Row row;
    if (fields.size() <= std::max({part, color, quantity}) || trim(fields[part]).empty() ||
        !number(fields[color], row.color) || row.color < 0 || !number(fields[quantity], row.quantity)) {
      if (!header) ++out.invalidRows;  // an unrecognised header is a title, not a lost part
      continue;
    }
    row.name = trim(fields[part]);
    if (spare < fields.size()) {
      const auto flag = folded(fields[spare]);
      row.spare = flag == "true" || flag == "yes" || flag == "1" || flag == "spare";
    }
    rows.push_back(std::move(row));
  }
  return rows;
}

std::vector<Row> readBin(std::istream& file, InventoryReport& out) {
  std::vector<Row> rows;
  bool items = false;
  std::string raw;
  while (std::getline(file, raw)) {
    std::string_view line = trim(raw);
    if (line.starts_with("\xef\xbb\xbf")) line = trim(line.substr(3));
    if (line.empty() || line.starts_with(';') || line.starts_with('#')) continue;
    if (line.starts_with('[') || line.starts_with('<')) {
      const auto key = folded(line);
      items = key == "[items]" || key == "<items>";
      continue;
    }
    if (!items) continue;
    const auto separator = line.find(':');
    if (separator == line.npos || trim(line.substr(0, separator)).empty()) {
      ++out.invalidRows;
      continue;
    }
    Row row;
    row.name = trim(line.substr(0, separator));
    std::string attributes(line.substr(separator + 1));
    std::replace(attributes.begin(), attributes.end(), '[', ' ');
    std::replace(attributes.begin(), attributes.end(), ']', ' ');
    std::istringstream tokens(attributes);
    bool valid = true;
    for (std::string token; tokens >> token;) {
      const auto equals = token.find('=');
      if (equals == token.npos) continue;
      const auto key = folded(std::string_view(token).substr(0, equals));
      const auto value = std::string_view(token).substr(equals + 1);
      if (key == "count") valid = number(value, row.quantity) && valid;
      if (key == "color") valid = number(value, row.color) && row.color >= 0 && valid;
    }
    if (valid) rows.push_back(std::move(row));
    else ++out.invalidRows;
  }
  return rows;
}

}  // namespace

InventoryImport::InventoryImport(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
InventoryImport::~InventoryImport() = default;

InventoryImport* InventoryImport::capture(const Session* session, int step) {
  if (!session || !session->impl().model) return nullptr;
  return new InventoryImport(std::make_unique<Impl>(session->shared(), step));
}

InventoryReport InventoryImport::prepare(const std::string& file) {
  auto& draft = *impl_;
  if (draft.prepared) return draft.report;
  draft.prepared = true;
  auto& report = draft.report;
  try {
    const auto extension = folded(std::filesystem::path(file).extension().string());
    if (extension != ".pbg" && extension != ".csv") {
      report.error = "Choose a Rebrickable CSV or a Studio PBG parts bin.";
      return report;
    }
    std::ifstream input(file, std::ios::binary);
    if (!input) { report.error = "The parts inventory could not be opened."; return report; }
    const auto rows = extension == ".pbg" ? readBin(input, report) : readCsv(input, report);
    if (input.bad()) { report.error = "The parts inventory could not be read."; return report; }

    struct Group { Row row; bm::Box bounds; };
    std::vector<Group> known;
    std::map<std::pair<std::string, int>, size_t> grouped;
    std::set<std::string> missing;
    auto& cache = *draft.backing->full;
    double area = 0, widest = 0;
    size_t count = 0;
    for (auto row : rows) {
      if (row.spare) {
        report.spares += std::min(row.quantity, SIZE_MAX - report.spares);
        continue;
      }
      if (row.quantity == 0) continue;
      row.name = bm::ldraw::normalizeName(row.name);
      if (!row.name.ends_with(".dat")) row.name += ".dat";
      if (missing.contains(row.name)) continue;
      auto mesh = draft.model.mesh(row.name, cache);
      if (!mesh || mesh->bounds.empty() || mesh->triangles.empty()) {
        missing.insert(row.name);
        continue;
      }
      if (row.quantity > kInventoryLimit - count) {
        report.error = "This inventory exceeds 200,000 pieces. Split it into smaller files.";
        return report;
      }
      count += row.quantity;
      const auto bounds = mesh->bounds;
      const double width = bounds.max.x - bounds.min.x + kGap;
      area += width * (bounds.max.z - bounds.min.z + kGap) * static_cast<double>(row.quantity);
      widest = std::max(widest, width);
      const auto [entry, added] = grouped.emplace(std::make_pair(row.name, row.color), known.size());
      if (added) known.push_back({std::move(row), bounds});
      else known[entry->second].row.quantity += row.quantity;
    }
    report.missing.assign(missing.begin(), missing.end());
    if (count == 0) return report;
    const auto model = draft.model.bounds(cache);
    const double left = model.empty() ? 0 : model.max.x + kGap * 2;
    const double front = model.empty() ? 0 : model.min.z;
    const double ground = model.empty() ? 0 : model.max.y;
    const double span = std::max(widest, std::sqrt(area));
    double x = 0, z = 0, depth = 0;
    draft.parts.reserve(count);
    for (const auto& group : known) {
      const auto& box = group.bounds;
      const double width = box.max.x - box.min.x + kGap, length = box.max.z - box.min.z + kGap;
      for (size_t i = 0; i < group.row.quantity; ++i) {
        if (x > 0 && x + width > span) { x = 0; z += depth; depth = 0; }
        draft.parts.push_back({group.row.name, group.row.color,
                               {left + x - box.min.x, ground - box.max.y, front + z - box.min.z}});
        x += width;
        depth = std::max(depth, length);
      }
    }
    report.pieces = draft.parts.size();
  } catch (const std::exception&) {
    draft.parts.clear();
    report.error = "The parts inventory could not be prepared.";
  }
  return report;
}

}  // namespace bmapp

void bmappRetainInventoryImport(bmapp::InventoryImport* p) { p->refs_.fetch_add(1, std::memory_order_relaxed); }
void bmappReleaseInventoryImport(bmapp::InventoryImport* p) {
  if (p->refs_.fetch_sub(1, std::memory_order_acq_rel) == 1) delete p;
}
