// LDraw / MPD -> Model, and Model -> LDraw text.
#include <algorithm>
#include <cstdio>
#include <unordered_set>
#include "bm/io.h"

namespace bm::io {
namespace {

bool endsWith(std::string_view s, std::string_view tail) { return s.size() >= tail.size() && s.substr(s.size() - tail.size()) == tail; }

void addOnce(std::vector<std::string>& list, const std::string& value) {
  if (std::find(list.begin(), list.end(), value) == list.end()) list.push_back(value);
}

struct Expander {
  const ldraw::Library& lib;
  Model::Data& out;
  std::vector<std::string> stack;  // submodel files being expanded
  std::unordered_set<const ldraw::File*> counted;  // files whose skipped lines are in the report

  /// A reference is a submodel when it names a model file (not a .dat part) that exists.
  const ldraw::File* submodel(const std::string& name) const {
    if (endsWith(name, ".dat")) return nullptr;
    return lib.find(name);
  }

  void file(const ldraw::File& f, const Xform& xf, int color, int rootStep, const std::string& idPrefix, std::vector<std::string>& path) {
    if (counted.insert(&f).second) out.report.skippedLines += f.skipped;
    const bool root = stack.size() == 1;
    int step = 0, order = 0;
    for (const ldraw::Command& c : f.cmds) {
      if (c.type == ldraw::Cmd::Step) {
        step++;
        order = 0;
        continue;
      }
      if (c.type != ldraw::Cmd::Ref) continue;
      const std::string id = idPrefix + std::to_string(step) + ":" + std::to_string(order++);
      const int own = c.color == 16 ? color : c.color;
      const int atStep = root ? step : rootStep;  // a submodel's pieces go on with the step that places it
      const Xform world = xf * c.xf;
      if (const ldraw::File* sub = submodel(c.file)) {
        if (std::find(stack.begin(), stack.end(), c.file) != stack.end() || stack.size() >= 64) {
          std::string loop;
          for (const std::string& s : stack) loop += s + " > ";
          addOnce(out.report.cycles, loop + c.file);
          continue;
        }
        addOnce(out.submodels, c.file);
        stack.push_back(c.file);
        path.push_back(c.file);
        file(*sub, world, own, atStep, id + "/", path);
        path.pop_back();
        stack.pop_back();
        continue;
      }
      if (!lib.find(c.file)) addOnce(out.report.missing, c.file);
      out.pieces.push_back(Piece{id, c.file, own, world, atStep, path});
    }
  }
};

void number(std::string& out, double v) {
  char buf[40];
  std::snprintf(buf, sizeof buf, " %.9g", v == 0 ? 0.0 : v);  // no "-0"
  out += buf;
}

void reference(std::string& out, int color, const Xform& xf, const std::string& name) {
  out += "1 " + std::to_string(color);
  number(out, xf.t.x);
  number(out, xf.t.y);
  number(out, xf.t.z);
  for (double v : xf.r.m) number(out, v);
  out += " " + name + "\n";
}

void geometry(std::string& out, int type, const ldraw::Command& c, int values) {
  out += std::to_string(type) + " " + std::to_string(c.color);
  for (int i = 0; i < values; i++) number(out, c.pts[i]);
  out += "\n";
}

/// An inline part file, written back from its commands.
void partFile(std::string& out, const ldraw::File& f) {
  out += "0 FILE " + f.name + "\n0 " + f.description + "\n";
  if (!f.category.empty()) out += "0 !CATEGORY " + f.category + "\n";
  for (const std::string& h : f.help) out += "0 !HELP " + h + "\n";
  for (const ldraw::Command& c : f.cmds) {
    switch (c.type) {
      case ldraw::Cmd::Ref:
        if (c.invert) out += "0 BFC INVERTNEXT\n";
        reference(out, c.color, c.xf, c.file);
        break;
      case ldraw::Cmd::Line: geometry(out, 2, c, 6); break;
      case ldraw::Cmd::Tri: geometry(out, 3, c, 9); break;
      case ldraw::Cmd::Quad: geometry(out, 4, c, 12); break;
      case ldraw::Cmd::Step: out += "0 STEP\n"; break;
      case ldraw::Cmd::Bfc:
        out += "0 BFC";
        if (c.cert == ldraw::Command::Cert::NoCertify) out += " NOCERTIFY";
        else if (c.cert == ldraw::Command::Cert::CCW) out += " CERTIFY CCW";
        else if (c.cert == ldraw::Command::Cert::CW) out += " CERTIFY CW";
        if (c.winding == ldraw::Command::Wind::CCW) out += " CCW";
        else if (c.winding == ldraw::Command::Wind::CW) out += " CW";
        if (c.clip == 1) out += " CLIP";
        else if (c.clip == 0) out += " NOCLIP";
        out += "\n";
        break;
    }
  }
}

}  // namespace

/// Builds a model from LDraw text. Defined here, declared for load() in io.cpp.
Model modelFromLDraw(std::string_view text, const std::string& fileName, const ldraw::Library& library,
                     std::vector<ldraw::File> embeddedParts, size_t studioCustomPartsAvailable) {
  std::vector<ldraw::File> files = ldraw::parseMpd(text, fileName);
  const std::string rootName = files.front().name;
  // Archive geometry is scoped to this model, never installed into the process-global
  // library or written onto disk. A .dat declared in the MPD overrides an archive part
  // of the same name, which in turn overrides the installed LDraw library.
  std::vector<ldraw::File> merged = std::move(embeddedParts);
  const size_t embeddedCount = merged.size();
  for (ldraw::File& f : files) merged.push_back(std::move(f));
  std::unordered_set<std::string> unique;
  std::vector<std::string> partNames;
  for (const ldraw::File& f : merged)
    if (endsWith(f.name, ".dat") && unique.insert(f.name).second)
      partNames.push_back(f.name);
  // Inspect embedded metadata before moving the files into Library. Accessing
  // `merged` after withInline(std::move(merged)) would be undefined behaviour.
  size_t customSkippedLines = 0;
  for (size_t i = 0; i < embeddedCount; ++i)
    customSkippedLines += static_cast<size_t>(merged[i].skipped);
  Model::Data data{{}, {}, {}, library.withInline(std::move(merged)), {}};
  data.report.studioCustomPartsAvailable = studioCustomPartsAvailable;
  data.report.studioCustomPartsLoaded = embeddedCount;
  data.report.studioCustomPartSkippedLines = customSkippedLines;
  data.inlineParts.reserve(partNames.size());
  for (const std::string& part : partNames) data.inlineParts.push_back(*data.library.find(part));
  const ldraw::File* root = data.library.find(rootName);
  Expander e{data.library, data, {rootName}, {}};
  std::vector<std::string> path;
  if (root) e.file(*root, Xform::identity(), 16, 0, "", path);
  return Model(std::move(data));
}

std::string toLDraw(const Model& model) {
  std::string out = "0 FILE main.ldr\n0 Model\n";
  int step = 0;
  for (const Piece& p : model.pieces()) {
    for (; step < p.step; step++) out += "0 STEP\n";
    reference(out, p.color, p.world, p.part);
  }
  for (const ldraw::File& f : model.inlineParts()) partFile(out, f);
  return out;
}

}  // namespace bm::io
