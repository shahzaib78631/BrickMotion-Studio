// BrickMotion plan and project JSON -> Model.
#include <algorithm>
#include <cmath>
#include <fstream>
#include <sstream>
#include <unordered_map>
#include "bm/io.h"

namespace bm::io {

Model modelFromLDraw(std::string_view text, const std::string& fileName, const ldraw::Library& library,
                     std::vector<ldraw::File> embeddedParts = {}, size_t studioCustomPartsAvailable = 0);

namespace {

using Json = nlohmann::ordered_json;

constexpr double kStud = 20, kPlate = 8;
constexpr int kDefaultColor = 71;
/// The size an empty submodel is given for grid placement (one 1x1 brick).
constexpr Box kEmptySubBox{{0, -24, 0}, {20, 0, 20}};

// ---- structure check ------------------------------------------------------------------

void checkItem(const Json& item, const std::string& where, std::vector<std::string>& errors) {
  if (!item.is_object()) {
    errors.push_back(where + ": must be an object");
    return;
  }
  const bool part = item.contains("part"), sub = item.contains("submodel");
  if (part == sub) errors.push_back(where + ": needs either \"part\" or \"submodel\"");
  if (part && !item["part"].is_string()) errors.push_back(where + ".part: must be text");
  if (sub && !item["submodel"].is_string()) errors.push_back(where + ".submodel: must be text");
  if (part && item.contains("color") && !item["color"].is_number_integer() && !item["color"].is_string()) errors.push_back(where + ".color: must be a colour code or name");
  auto numbers = [&](const char* key, size_t count) {
    if (!item.contains(key) || !item[key].is_array() || item[key].size() != count) return false;
    for (const Json& v : item[key])
      if (!v.is_number()) return false;
    return true;
  };
  if (item.contains("rot")) {
    for (const char* key : {"x", "y", "z", "rot"})
      if (!item.contains(key) || !item[key].is_number()) errors.push_back(where + "." + key + ": must be a number");
    if (item["rot"].is_number()) {
      const double rot = item["rot"].get<double>();
      if (rot != 0 && rot != 90 && rot != 180 && rot != 270) errors.push_back(where + ".rot: must be 0, 90, 180 or 270");
    }
  } else if (!numbers("ldu", 3) || !numbers("matrix", 9)) {
    errors.push_back(where + ": needs a grid placement (x, y, z, rot) or an exact one (ldu, matrix)");
  }
}

void checkSteps(const Json& owner, const std::string& where, std::vector<std::string>& errors) {
  if (!owner.is_object() || !owner.contains("steps") || !owner["steps"].is_array()) {
    errors.push_back(where + "steps: must be a list");
    return;
  }
  size_t si = 0;
  for (const Json& step : owner["steps"]) {
    const std::string at = where + "steps." + std::to_string(si++);
    if (!step.is_object() || !step.contains("pieces") || !step["pieces"].is_array()) {
      errors.push_back(at + ".pieces: must be a list");
      continue;
    }
    size_t pi = 0;
    for (const Json& item : step["pieces"]) checkItem(item, at + ".pieces." + std::to_string(pi++), errors);
    if (errors.size() > 50) return;
  }
}

void checkPlan(const Json& j) {
  std::vector<std::string> errors;
  if (!j.is_object()) throw Error("(root): a plan file must be a JSON object");
  if (!j.contains("format") || j["format"] != "brickmotion-plan") errors.push_back("format: this is not a BrickMotion plan file");
  checkSteps(j, "", errors);
  if (j.contains("submodels")) {
    if (!j["submodels"].is_object()) errors.push_back("submodels: must be an object");
    else
      for (const auto& [name, sub] : j["submodels"].items()) checkSteps(sub, "submodels." + name + ".", errors);
  }
  if (j.contains("parts")) {
    if (!j["parts"].is_object()) errors.push_back("parts: must be an object");
    else
      for (const auto& [name, text] : j["parts"].items())
        if (!text.is_string()) errors.push_back("parts." + name + ": must be text");
  }
  if (errors.empty()) return;
  std::string all;
  for (const std::string& e : errors) all += (all.empty() ? "" : "\n") + e;
  throw Error(all);
}

Json parseJson(std::string_view text) {
  try {
    return Json::parse(text.begin(), text.end());
  } catch (const nlohmann::json::exception& e) {
    throw Error(std::string("Not valid JSON: ") + e.what());
  }
}

// ---- placement --------------------------------------------------------------------------

/// Colour names compare without case, with '_' for spaces and "gray" for "grey".
std::string colorKey(std::string_view name) {
  std::string out;
  for (char c : name) {
    if (c == ' ' || c == '-') c = '_';
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    out += c;
  }
  for (size_t at = out.find("grey"); at != std::string::npos; at = out.find("grey", at)) out.replace(at, 4, "gray");
  return out;
}

Xform gridPlacement(const Json& item, const Box& body) {
  const int rot = ((static_cast<int>(std::lround(item["rot"].get<double>())) % 360) + 360) % 360;
  const double c = rot == 0 ? 1 : rot == 180 ? -1 : 0, s = rot == 90 ? 1 : rot == 270 ? -1 : 0;
  Xform xf;
  xf.r = Mat3{{c, 0, s, 0, 1, 0, -s, 0, c}};
  const Box rb = body.transformed(Xform{xf.r, {}});
  const double fw = std::max(1.0, std::round((rb.max.x - rb.min.x) / kStud)), fd = std::max(1.0, std::round((rb.max.z - rb.min.z) / kStud));
  xf.t = {
      (item["x"].get<double>() + fw / 2) * kStud - (rb.min.x + rb.max.x) / 2,
      -item["y"].get<double>() * kPlate - rb.max.y,
      (item["z"].get<double>() + fd / 2) * kStud - (rb.min.z + rb.max.z) / 2,
  };
  return xf;
}

Xform placement(const Json& item, const Box& body) {
  if (item.contains("rot")) return gridPlacement(item, body);
  Xform xf;
  for (int i = 0; i < 3; i++) (i == 0 ? xf.t.x : i == 1 ? xf.t.y : xf.t.z) = item["ldu"][i].get<double>();
  for (int i = 0; i < 9; i++) xf.r.m[i] = item["matrix"][i].get<double>();
  return xf;
}

struct Node {
  bool sub = false;
  std::string id, name;  // name: part file or submodel
  int color = kDefaultColor;
  int step = 0;
  Xform local;
  Box body;  // in the node's own space
  std::vector<Node> children;
};

struct PlanBuilder {
  const Json& plan;
  const ldraw::Library& lib;
  ldraw::PartCache& cache;
  Model::Data& out;
  std::unordered_map<std::string, int> colorNames;
  std::unordered_map<std::string, Box> bodies;

  int color(const Json& item) {
    if (!item.contains("color")) return kDefaultColor;
    const Json& c = item["color"];
    auto code = [](long v) { return v == 16 ? kDefaultColor : static_cast<int>(v); };
    if (c.is_number_integer()) return code(c.get<long>());
    const std::string text = c.get<std::string>();
    char* end = nullptr;
    const long v = std::strtol(text.c_str(), &end, 10);
    if (!text.empty() && end == text.c_str() + text.size()) return code(v);
    if (colorNames.empty())
      for (const auto& [number, def] : lib.colors()) colorNames.emplace(colorKey(def.name), number);
    if (const auto it = colorNames.find(colorKey(text)); it != colorNames.end()) return it->second;
    if (std::find(out.report.unknownColors.begin(), out.report.unknownColors.end(), text) == out.report.unknownColors.end()) out.report.unknownColors.push_back(text);
    return kDefaultColor;
  }

  const Box& partBody(const std::string& part) {
    auto it = bodies.find(part);
    if (it != bodies.end()) return it->second;
    const auto mesh = lib.isInline(part) ? std::make_shared<const ldraw::Mesh>(ldraw::flatten(part, lib)) : cache.get(part);
    if (!lib.find(part) && std::find(out.report.missing.begin(), out.report.missing.end(), part) == out.report.missing.end()) out.report.missing.push_back(part);
    return bodies.emplace(part, mesh->body.empty() ? kPlaceholderBox : mesh->body).first->second;
  }

  std::vector<Node> model(const std::string& name, const Json& steps, std::vector<std::string>& stack) {
    std::vector<Node> nodes;
    int si = 0;
    for (const Json& step : steps) {
      int order = 0;
      for (const Json& item : step["pieces"]) {
        Node n;
        n.id = item.contains("id") && item["id"].is_string() ? item["id"].get<std::string>() : name + ":" + std::to_string(si) + ":" + std::to_string(order);
        order++;
        n.step = si;
        if (item.contains("submodel")) {
          n.sub = true;
          n.name = item["submodel"].get<std::string>();
          const bool known = plan.contains("submodels") && plan["submodels"].contains(n.name);
          if (!known) {
            if (std::find(out.report.missing.begin(), out.report.missing.end(), n.name) == out.report.missing.end()) out.report.missing.push_back(n.name);
            continue;
          }
          if (std::find(stack.begin(), stack.end(), n.name) != stack.end() || stack.size() >= 16) {
            std::string loop;
            for (const std::string& s : stack) loop += s + " > ";
            loop += n.name;
            if (std::find(out.report.cycles.begin(), out.report.cycles.end(), loop) == out.report.cycles.end()) out.report.cycles.push_back(loop);
            continue;
          }
          if (std::find(out.submodels.begin(), out.submodels.end(), n.name) == out.submodels.end()) out.submodels.push_back(n.name);
          stack.push_back(n.name);
          n.children = model(n.name, plan["submodels"][n.name]["steps"], stack);
          stack.pop_back();
          for (const Node& child : n.children) n.body.merge(child.body.transformed(child.local));
          if (n.body.empty()) n.body = kEmptySubBox;
        } else {
          n.name = ldraw::normalizeName(item["part"].get<std::string>());
          if (n.name.find('.') == std::string::npos) n.name += ".dat";
          n.color = color(item);
          n.body = partBody(n.name);
        }
        n.local = placement(item, n.body);
        nodes.push_back(std::move(n));
      }
      si++;
    }
    return nodes;
  }

  void collect(const std::vector<Node>& nodes, const Xform& parent, const std::string& prefix, int rootStep, bool root, std::vector<std::string>& path) {
    for (const Node& n : nodes) {
      const Xform world = parent * n.local;
      const std::string id = prefix.empty() ? n.id : prefix + "/" + n.id;
      const int step = root ? n.step : rootStep;
      if (n.sub) {
        path.push_back(n.name);
        collect(n.children, world, id, step, false, path);
        path.pop_back();
      } else {
        out.pieces.push_back(Piece{id, n.name, n.color, world, step, path});
      }
    }
  }
};

std::string readFile(const std::filesystem::path& path) {
  std::error_code ec;
  if (!std::filesystem::is_regular_file(path, ec)) throw Error("Cannot read " + path.string() + ": not a file");
  std::ifstream in(path, std::ios::binary);
  if (!in) throw Error("Cannot read " + path.string());
  std::ostringstream out;
  out << in.rdbuf();
  return std::move(out).str();
}

}  // namespace

PlanDoc readPlan(std::string_view text) {
  PlanDoc doc{parseJson(text)};
  checkPlan(doc.json);
  return doc;
}

std::string writePlan(const PlanDoc& doc) { return doc.json.dump(); }

PlanDoc readProject(std::string_view text) {
  Json j = parseJson(text);
  if (!j.is_object() || !j.contains("format") || j["format"] != "brickmotion-project") throw Error("This is not a BrickMotion project file.");
  if (!j.contains("version") || j["version"] != 1) throw Error("This project file is from a newer version than this engine understands.");
  if (!j.contains("plan")) throw Error("The project file has no plan in it.");
  PlanDoc doc{std::move(j["plan"])};
  checkPlan(doc.json);
  return doc;
}

Model fromPlan(const PlanDoc& doc, const ldraw::Library& library, ldraw::PartCache& cache) {
  std::vector<ldraw::File> inlineParts;
  if (doc.json.contains("parts"))
    for (const auto& [name, text] : doc.json["parts"].items()) inlineParts.push_back(ldraw::parse(text.get<std::string>(), name));
  Model::Data data{{}, {}, {}, inlineParts.empty() ? library : library.withInline(inlineParts), inlineParts};
  PlanBuilder b{doc.json, data.library, cache, data, {}, {}};
  std::vector<std::string> stack, path;
  const std::vector<Node> nodes = b.model("", doc.json["steps"], stack);
  b.collect(nodes, Xform::identity(), "", 0, true, path);
  return Model(std::move(data));
}

Format sniff(const std::filesystem::path&, std::string_view head) {
  if (head.size() >= 4 && head[0] == 'P' && head[1] == 'K' && (head[2] == 3 || head[2] == 5) && (head[3] == 4 || head[3] == 6)) return Format::StudioIo;
  size_t i = 0;
  while (i < head.size() && (head[i] == ' ' || head[i] == '\t' || head[i] == '\r' || head[i] == '\n' || static_cast<unsigned char>(head[i]) >= 0xEF)) i++;
  if (i < head.size() && head[i] == '{') {
    if (head.find("brickmotion-project") != std::string_view::npos) return Format::Project;
    return Format::Plan;
  }
  return Format::LDraw;
}

Model load(const std::filesystem::path& path, const ldraw::Library& library, ldraw::PartCache* cache) {
  const std::string bytes = readFile(path);
  const Format format = sniff(path, std::string_view(bytes).substr(0, 4096));
  const std::string name = path.filename().string();
  if (format == Format::LDraw) return modelFromLDraw(bytes, name, library);
  if (format == Format::StudioIo) {
    StudioArchive archive = readStudioArchive(bytes);
    return modelFromLDraw(archive.model, name, library, std::move(archive.customParts), archive.availableCustomParts);
  }
  const PlanDoc doc = format == Format::Project ? readProject(bytes) : readPlan(bytes);
  if (cache) return fromPlan(doc, library, *cache);
  ldraw::PartCache own(library, ldraw::PartCache::defaultDirectory());
  return fromPlan(doc, library, own);
}

}  // namespace bm::io
