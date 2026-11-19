// The editable document: reading it from plan and LDraw files, writing the plan back, and
// flattening it to a Model the way io::fromPlan and io::load do.
#include "bm/doc/source.h"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <sstream>
#include <unordered_map>

namespace bm::doc {

namespace {

using Json = nlohmann::ordered_json;

constexpr double kStud = 20, kPlate = 8;
/// The size an empty submodel is given for grid placement (one 1x1 brick), as plan_json.cpp.
constexpr Box kEmptySubBox{{0, -24, 0}, {20, 0, 20}};

bool endsWith(std::string_view s, std::string_view tail) { return s.size() >= tail.size() && s.substr(s.size() - tail.size()) == tail; }

void addOnce(std::vector<std::string>& list, const std::string& value) {
  if (std::find(list.begin(), list.end(), value) == list.end()) list.push_back(value);
}

/// Colour names compare without case, with '_' for spaces and "gray" for "grey" (plan_json.cpp).
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

// ---- reading a plan ----------------------------------------------------------------------

Item planItem(const Json& j, Source& source) {
  Item item;
  item.id = source.newId();
  item.extra = j;
  item.submodel = j.contains("submodel");
  if (item.submodel) {
    item.name = j["submodel"].get<std::string>();
  } else {
    item.name = ldraw::normalizeName(j["part"].get<std::string>());
    if (item.name.find('.') == std::string::npos) item.name += ".dat";
    item.color = kPlanDefaultColor;
    if (j.contains("color")) {
      const Json& c = j["color"];
      auto code = [](long v) { return v == 16 ? kPlanDefaultColor : static_cast<int>(v); };
      if (c.is_number_integer()) {
        item.colorText = std::to_string(c.get<long>());
        item.color = code(c.get<long>());
      } else {
        item.colorText = c.get<std::string>();
        char* end = nullptr;
        const long v = std::strtol(item.colorText.c_str(), &end, 10);
        item.color = !item.colorText.empty() && end == item.colorText.c_str() + item.colorText.size() ? code(v) : kColorByName;
      }
    }
  }
  if (j.contains("rot")) {
    item.at.grid = true;
    item.at.x = j["x"].get<double>(), item.at.y = j["y"].get<double>(), item.at.z = j["z"].get<double>();
    item.at.rot = static_cast<int>(std::lround(j["rot"].get<double>()));
  } else {
    item.at.exact.t = {j["ldu"][0].get<double>(), j["ldu"][1].get<double>(), j["ldu"][2].get<double>()};
    for (int i = 0; i < 9; i++) item.at.exact.r.m[i] = j["matrix"][i].get<double>();
  }
  return item;
}

Def planDef(const Json& owner, Source& source) {
  Def def;
  def.extra = owner;
  for (const Json& s : owner["steps"]) {
    Step step;
    step.extra = s;
    for (const Json& i : s["pieces"]) step.items.push_back(planItem(i, source));
    def.steps.push_back(std::move(step));
  }
  return def;
}

// ---- writing a plan ----------------------------------------------------------------------

/// Sets `key` to `value` unless it already holds that value (so 2 stays 2, never 2.0).
template <typename T>
void put(Json& j, const char* key, const T& value) {
  if (j.contains(key) && j[key] == Json(value)) return;
  j[key] = value;
}

Json writeItem(const Item& item) {
  Json j = item.extra.is_object() ? item.extra : Json::object();
  if (item.submodel) {
    j.erase("part");
    put(j, "submodel", item.name);
  } else {
    j.erase("submodel");
    // The name as read when it still names the same part; else the normalised name.
    const bool same = j.contains("part") && j["part"].is_string() && [&] {
      std::string read = ldraw::normalizeName(j["part"].get<std::string>());
      if (read.find('.') == std::string::npos) read += ".dat";
      return read == item.name;
    }();
    if (!same) j["part"] = item.name;
    if (item.colorText.empty()) {
      j.erase("color");
    } else if (!(j.contains("color") && (j["color"].is_string() ? j["color"].get<std::string>() == item.colorText
                                                                  : j["color"].is_number_integer() && std::to_string(j["color"].get<long>()) == item.colorText))) {
      char* end = nullptr;
      const long v = std::strtol(item.colorText.c_str(), &end, 10);
      if (end == item.colorText.c_str() + item.colorText.size()) j["color"] = v;
      else j["color"] = item.colorText;
    }
  }
  const Placement& at = item.at;
  if (at.grid) {
    j.erase("ldu"), j.erase("matrix");
    put(j, "x", at.x), put(j, "y", at.y), put(j, "z", at.z), put(j, "rot", at.rot);
  } else {
    j.erase("x"), j.erase("y"), j.erase("z"), j.erase("rot");
    const Json ldu = Json::array({at.exact.t.x, at.exact.t.y, at.exact.t.z});
    Json matrix = Json::array();
    for (double v : at.exact.r.m) matrix.push_back(v);
    put(j, "ldu", ldu), put(j, "matrix", matrix);
  }
  return j;
}

Json writeSteps(const Def& def) {
  Json steps = Json::array();
  for (const Step& s : def.steps) {
    Json step = s.extra.is_object() ? s.extra : Json::object();
    Json pieces = Json::array();
    for (const Item& i : s.items) pieces.push_back(writeItem(i));
    step["pieces"] = std::move(pieces);
    steps.push_back(std::move(step));
  }
  return steps;
}

// ---- flattening --------------------------------------------------------------------------

struct Node {
  const Item* item = nullptr;
  std::string id;
  int color = 16;
  int step = 0;
  Xform local;
  Box body;
  std::vector<Node> children;
};

struct Flattener {
  const Source& source;
  const ldraw::Library& lib;
  ldraw::PartCache& cache;
  Model::Data& out;
  std::vector<PieceRef>& refs;
  std::unordered_map<std::string, int> colorNames;
  std::unordered_map<std::string, Box> bodies;
  std::unordered_map<std::string, const Def*> defs;

  bool ldrawOrigin() const { return source.origin == Origin::LDraw; }

  int color(const Item& item) {
    if (item.color != kColorByName) return item.color;
    if (colorNames.empty())
      for (const auto& [number, def] : lib.colors()) colorNames.emplace(colorKey(def.name), number);
    if (const auto it = colorNames.find(colorKey(item.colorText)); it != colorNames.end()) return it->second;
    addOnce(out.report.unknownColors, item.colorText);
    return kPlanDefaultColor;
  }

  const Box& partBody(const std::string& part) {
    auto it = bodies.find(part);
    if (it != bodies.end()) return it->second;
    const auto mesh = lib.isInline(part) ? std::make_shared<const ldraw::Mesh>(ldraw::flatten(part, lib)) : cache.get(part);
    if (!lib.find(part)) addOnce(out.report.missing, part);
    return bodies.emplace(part, mesh->body.empty() ? kPlaceholderBox : mesh->body).first->second;
  }

  std::vector<Node> def(const std::string& name, const Def& d, std::vector<std::string>& stack) {
    std::vector<Node> nodes;
    for (size_t si = 0; si < d.steps.size(); si++) {
      int order = 0;
      for (const Item& item : d.steps[si].items) {
        Node n;
        n.item = &item;
        if (ldrawOrigin()) n.id = std::to_string(si) + ":" + std::to_string(order);
        else
          n.id = item.extra.contains("id") && item.extra["id"].is_string() ? item.extra["id"].get<std::string>()
                                                                           : name + ":" + std::to_string(si) + ":" + std::to_string(order);
        order++;
        n.step = static_cast<int>(si);
        if (item.submodel) {
          const auto found = defs.find(item.name);
          if (found == defs.end()) {
            addOnce(out.report.missing, item.name);
            continue;
          }
          const size_t limit = ldrawOrigin() ? 64 : 16;
          if (std::find(stack.begin(), stack.end(), item.name) != stack.end() || stack.size() >= limit) {
            std::string loop;
            for (const std::string& s : stack) loop += s + " > ";
            addOnce(out.report.cycles, loop + item.name);
            continue;
          }
          addOnce(out.submodels, item.name);
          n.color = item.color;
          stack.push_back(item.name);
          n.children = def(item.name, *found->second, stack);
          stack.pop_back();
          for (const Node& child : n.children) n.body.merge(child.body.transformed(child.local));
          if (n.body.empty()) n.body = kEmptySubBox;
        } else {
          n.color = color(item);
          if (ldrawOrigin()) {
            if (!lib.find(item.name)) addOnce(out.report.missing, item.name);  // exact placements need no body
          } else {
            n.body = partBody(item.name);
          }
        }
        n.local = item.at.grid ? placeOnGrid(item.at, n.body) : item.at.exact;
        nodes.push_back(std::move(n));
      }
    }
    return nodes;
  }

  void collect(const std::vector<Node>& nodes, const Xform& parent, int inherited, const std::string& prefix, int rootStep,
               bool root, std::vector<std::string>& path, std::vector<int>& steps, std::vector<ItemId>& chain) {
    for (const Node& n : nodes) {
      const Xform world = parent * n.local;
      const std::string id = prefix.empty() ? n.id : prefix + "/" + n.id;
      const int step = root ? n.step : rootStep;
      const int own = n.color == 16 ? inherited : n.color;
      steps.push_back(n.step);
      chain.push_back(n.item->id);
      if (n.item->submodel) {
        path.push_back(n.item->name);
        collect(n.children, world, own, id, step, false, path, steps, chain);
        path.pop_back();
      } else {
        // LDraw files carry no per-level steps: the planner reads them from the id.
        out.pieces.push_back(Piece{id, n.item->name, own, world, step, path, ldrawOrigin() ? std::vector<int>{} : steps});
        refs.push_back(PieceRef{chain});
      }
      chain.pop_back();
      steps.pop_back();
    }
  }
};

std::string readFile(const std::filesystem::path& path) {
  std::error_code ec;
  if (!std::filesystem::is_regular_file(path, ec)) throw io::Error("Cannot read " + path.string() + ": not a file");
  std::ifstream in(path, std::ios::binary);
  if (!in) throw io::Error("Cannot read " + path.string());
  std::ostringstream out;
  out << in.rdbuf();
  return std::move(out).str();
}

Source fromLDrawFiles(std::vector<ldraw::File> files, std::vector<ldraw::File> embedded, size_t embeddedAvailable) {
  Source source = fromLDraw(files);
  // Archive parts come first, so a .dat in the MPD of the same name wins, as in io::load.
  std::vector<ldraw::File> parts = std::move(embedded);
  source.carried.studioCustomPartsAvailable = embeddedAvailable;
  source.carried.studioCustomPartsLoaded = parts.size();
  for (const ldraw::File& f : parts) source.carried.studioCustomPartSkippedLines += static_cast<size_t>(f.skipped);
  for (ldraw::File& f : source.inlineParts) parts.push_back(std::move(f));
  source.inlineParts = std::move(parts);
  return source;
}

}  // namespace

Xform placeOnGrid(const Placement& at, const Box& body) {
  const int rot = ((at.rot % 360) + 360) % 360;
  const double c = rot == 0 ? 1 : rot == 180 ? -1 : 0, s = rot == 90 ? 1 : rot == 270 ? -1 : 0;
  Xform xf;
  xf.r = Mat3{{c, 0, s, 0, 1, 0, -s, 0, c}};
  const Box rb = body.transformed(Xform{xf.r, {}});
  const double fw = std::max(1.0, std::round((rb.max.x - rb.min.x) / kStud)), fd = std::max(1.0, std::round((rb.max.z - rb.min.z) / kStud));
  xf.t = {
      (at.x + fw / 2) * kStud - (rb.min.x + rb.max.x) / 2,
      -at.y * kPlate - rb.max.y,
      (at.z + fd / 2) * kStud - (rb.min.z + rb.max.z) / 2,
  };
  return xf;
}

const Def* Source::def(const std::string& submodel) const {
  if (submodel.empty()) return &root;
  for (const auto& [name, d] : submodels)
    if (name == submodel) return &d;
  return nullptr;
}

Def* Source::def(const std::string& submodel) { return const_cast<Def*>(std::as_const(*this).def(submodel)); }

Source fromPlan(const io::PlanDoc& plan) {
  const Json& j = plan.json;
  Source source;
  source.origin = Origin::Plan;
  source.extra = j;
  source.root = planDef(j, source);
  source.root.extra = Json();  // the root's keys live in source.extra
  if (j.contains("submodels"))
    for (const auto& [name, sub] : j["submodels"].items()) source.submodels.emplace_back(name, planDef(sub, source));
  if (j.contains("parts"))
    for (const auto& [name, text] : j["parts"].items()) source.inlineParts.push_back(ldraw::parse(text.get<std::string>(), name));
  return source;
}

io::PlanDoc toPlan(const Source& source) {
  Json j = source.extra.is_object() ? source.extra : Json{{"format", "brickmotion-plan"}, {"version", 1}};
  j["steps"] = writeSteps(source.root);
  if (!source.submodels.empty() || j.contains("submodels")) {
    Json subs = Json::object();
    for (const auto& [name, def] : source.submodels) {
      Json sub = def.extra.is_object() ? def.extra : Json::object();
      sub["steps"] = writeSteps(def);
      subs[name] = std::move(sub);
    }
    j["submodels"] = std::move(subs);
  }
  return io::PlanDoc{std::move(j)};
}

Source fromLDraw(const std::vector<ldraw::File>& files) {
  Source source;
  source.origin = Origin::LDraw;
  if (files.empty()) return source;
  source.rootName = files.front().name;
  std::vector<std::string> models;  // the model files, by name: a reference to one is a submodel
  for (size_t i = 0; i < files.size(); i++)
    if (i == 0 || !endsWith(files[i].name, ".dat")) models.push_back(files[i].name);
  auto isModel = [&](const std::string& name) { return !endsWith(name, ".dat") && std::find(models.begin(), models.end(), name) != models.end(); };
  auto readDef = [&](const ldraw::File& f) {
    source.carried.skippedLines += f.skipped;
    Def def;
    def.steps.emplace_back();
    for (const ldraw::Command& c : f.cmds) {
      if (c.type == ldraw::Cmd::Step) {
        def.steps.emplace_back();
        continue;
      }
      if (c.type != ldraw::Cmd::Ref) continue;
      Item item;
      item.id = source.newId();
      item.submodel = isModel(c.file);
      item.name = c.file;
      item.color = c.color;
      item.colorText = std::to_string(c.color);
      item.at.exact = c.xf;
      def.steps.back().items.push_back(std::move(item));
    }
    if (def.steps.size() > 1 && def.steps.back().items.empty()) def.steps.pop_back();
    return def;
  };
  for (size_t i = 0; i < files.size(); i++) {
    if (i == 0) source.root = readDef(files[i]);
    else if (isModel(files[i].name)) source.submodels.emplace_back(files[i].name, readDef(files[i]));
    else source.inlineParts.push_back(files[i]);
  }
  return source;
}

Source fromFile(const std::filesystem::path& path) {
  const std::string bytes = readFile(path);
  const io::Format format = io::sniff(path, std::string_view(bytes).substr(0, 4096));
  switch (format) {
    case io::Format::Plan: return fromPlan(io::readPlan(bytes));
    case io::Format::Project: return fromPlan(io::readProject(bytes));
    case io::Format::LDraw: return fromLDrawFiles(ldraw::parseMpd(bytes, path.filename().string()), {}, 0);
    case io::Format::StudioIo: {
      io::StudioArchive archive = io::readStudioArchive(bytes);
      return fromLDrawFiles(ldraw::parseMpd(archive.model, path.filename().string()), std::move(archive.customParts),
                            archive.availableCustomParts);
    }
  }
  return {};
}

Flat flatten(const Source& source, const ldraw::Library& library, ldraw::PartCache& cache) {
  Model::Data data{{}, {}, source.carried, source.inlineParts.empty() ? library : library.withInline(source.inlineParts), {}};
  // As io::load: a model's own part files, once each by name.
  for (const ldraw::File& f : source.inlineParts)
    if (std::none_of(data.inlineParts.begin(), data.inlineParts.end(), [&](const ldraw::File& g) { return g.name == f.name; }))
      if (const ldraw::File* found = data.library.find(f.name)) data.inlineParts.push_back(*found);
  std::vector<PieceRef> refs;
  Flattener f{source, data.library, cache, data, refs, {}, {}, {}};
  for (const auto& [name, d] : source.submodels) f.defs.emplace(name, &d);
  if (source.origin == Origin::LDraw && !source.rootName.empty()) f.defs.emplace(source.rootName, &source.root);
  std::vector<std::string> stack, path;
  if (source.origin == Origin::LDraw) stack.push_back(source.rootName);
  const std::vector<Node> nodes = f.def("", source.root, stack);
  std::vector<int> steps;
  std::vector<ItemId> chain;
  f.collect(nodes, Xform::identity(), 16, "", 0, true, path, steps, chain);
  return Flat{Model(std::move(data)), std::move(refs)};
}

}  // namespace bm::doc
