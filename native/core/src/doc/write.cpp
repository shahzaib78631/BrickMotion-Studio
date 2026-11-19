// Writing the document: .brickmotion projects and LDraw MPD.
#include "bm/doc/write.h"

#include <charconv>
#include <chrono>
#include <cstdio>
#include <ctime>
#include <unordered_map>

namespace bm::doc {

namespace {

using Json = nlohmann::ordered_json;

/// Shortest text that reads back as the same double, never "-0".
void number(std::string& out, double v) {
  char buf[32];
  const auto r = std::to_chars(buf, buf + sizeof buf, v == 0 ? 0.0 : v);
  out += ' ';
  out.append(buf, r.ptr);
}

std::string nowIso() {
  const auto now = std::chrono::system_clock::now();
  const std::time_t t = std::chrono::system_clock::to_time_t(now);
  const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count() % 1000;
  std::tm utc{};
  gmtime_r(&t, &utc);
  char buf[32];
  std::snprintf(buf, sizeof buf, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday, utc.tm_hour,
                utc.tm_min, utc.tm_sec, static_cast<int>(ms));
  return buf;
}

}  // namespace

Project readProjectFile(std::string_view text) {
  io::readProject(text);  // the same checks, the same messages
  return Project{Json::parse(text.begin(), text.end())};
}

std::string writeProject(const Project& base, const Source& source, bool planChanged) {
  Json j = base.json.is_object() ? base.json : Json{{"format", "brickmotion-project"}, {"version", 1}, {"savedAt", ""}};
  j["savedAt"] = nowIso();
  j["plan"] = toPlan(source).json;
  if (planChanged) j.erase("timelines");
  return j.dump();
}

std::string writeMpd(const Source& source, const ldraw::Library& library) {
  ldraw::PartCache cache(library, ldraw::PartCache::defaultDirectory());
  const std::unordered_map<ItemId, Xform> locals = placements(source, library, cache);
  auto colorOf = [&](const Item& item) { return item.submodel && source.origin == Origin::Plan ? 16 : colorCode(item, library); };

  std::string out;
  auto def = [&](const std::string& name, const Def& d) {
    out += "0 FILE " + name + "\n0 " + name + "\n";
    for (size_t si = 0; si < d.steps.size(); si++) {
      if (si > 0) out += "0 STEP\n";
      for (const Item& item : d.steps[si].items) {
        const auto found = locals.find(item.id);
        const Xform xf = found != locals.end() ? found->second : item.at.grid ? placeOnGrid(item.at, kPlaceholderBox) : item.at.exact;
        out += "1 " + std::to_string(colorOf(item));
        number(out, xf.t.x), number(out, xf.t.y), number(out, xf.t.z);
        for (double v : xf.r.m) number(out, v);
        out += " " + item.name + "\n";
      }
    }
  };
  def(source.rootName.empty() ? "main.ldr" : source.rootName, source.root);
  for (const auto& [name, d] : source.submodels) def(name, d);
  // A plan keeps its part files' text as written; an LDraw file's are written back from their commands.
  const Json* texts = source.extra.is_object() && source.extra.contains("parts") ? &source.extra["parts"] : nullptr;
  for (const ldraw::File& part : source.inlineParts) {
    if (texts && texts->contains(part.name) && (*texts)[part.name].is_string()) {
      std::string text = (*texts)[part.name].get<std::string>();
      if (!text.empty() && text.back() != '\n') text += '\n';
      out += "0 FILE " + part.name + "\n" + text;
    } else {
      out += io::partFileText(part);
    }
  }
  return out;
}

}  // namespace bm::doc
