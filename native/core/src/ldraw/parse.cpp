#include "bm/ldraw/parse.h"

#include <cmath>
#include <cstdlib>
#include <cstring>

namespace bm::ldraw {
namespace {

bool isSpace(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\f' || c == '\v'; }

std::string_view trim(std::string_view s) {
  while (!s.empty() && isSpace(s.front())) s.remove_prefix(1);
  while (!s.empty() && isSpace(s.back())) s.remove_suffix(1);
  return s;
}

/// Takes the next whitespace-separated token off the front of `rest`.
std::string_view nextToken(std::string_view& rest) {
  rest = trim(rest);
  size_t n = 0;
  while (n < rest.size() && !isSpace(rest[n])) n++;
  const std::string_view tok = rest.substr(0, n);
  rest.remove_prefix(n);
  return tok;
}

std::string upper(std::string_view s) {
  std::string out(s);
  for (char& c : out)
    if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
  return out;
}

/// A finite number, the whole token. LDraw files are written by many tools, so this takes
/// anything strtod does (exponents, leading '+') and nothing else.
bool parseNumber(std::string_view tok, double& out) {
  char buf[64];
  if (tok.empty() || tok.size() >= sizeof buf) return false;
  std::memcpy(buf, tok.data(), tok.size());
  buf[tok.size()] = '\0';
  char* end = nullptr;
  out = std::strtod(buf, &end);
  return end == buf + tok.size() && std::isfinite(out);
}

/// A colour code: decimal, or a direct colour such as 0x2FF8800.
bool parseColor(std::string_view tok, int& out) {
  char buf[32];
  if (tok.empty() || tok.size() >= sizeof buf) return false;
  std::memcpy(buf, tok.data(), tok.size());
  buf[tok.size()] = '\0';
  char* end = nullptr;
  const long v = std::strtol(buf, &end, 0);
  if (end != buf + tok.size()) return false;
  out = static_cast<int>(v);
  return true;
}

bool parseNumbers(std::string_view& rest, double* out, int count) {
  for (int i = 0; i < count; i++)
    if (!parseNumber(nextToken(rest), out[i])) return false;
  return true;
}

struct Parser {
  File file;
  bool invertNext = false;
  bool sawFirstLine = false;
  std::string nextGroup;          // MLCAD: applies to the next reference
  std::vector<std::string> groups;  // LeoCAD: open group stack

  void meta(std::string_view rest) {
    const std::string_view body = trim(rest);
    std::string_view scan = body;
    const std::string_view first = nextToken(scan);
    if (!sawFirstLine) {
      sawFirstLine = true;
      const bool isMeta = first.empty() || first.front() == '!' || first == "BFC" || first == "STEP" || first == "FILE" || first == "Name:";
      if (!isMeta) {
        file.description = std::string(body);
        return;
      }
    }
    const std::string key = upper(first);
    if (key == "STEP") {
      Command c;
      c.type = Cmd::Step;
      file.cmds.push_back(std::move(c));
    } else if (key == "MLCAD") {
      if (upper(nextToken(scan)) == "BTG") nextGroup = std::string(trim(scan));
    } else if (key == "!LEOCAD") {
      if (upper(nextToken(scan)) != "GROUP") return;
      const std::string what = upper(nextToken(scan));
      if (what == "BEGIN") groups.emplace_back(trim(scan));
      else if (what == "END" && !groups.empty()) groups.pop_back();
    } else if (key == "!CATEGORY") {
      file.category = std::string(trim(scan));
    } else if (key == "!HELP") {
      file.help.emplace_back(trim(scan));
    } else if (key == "BFC") {
      bfc(scan);
    }
  }

  void bfc(std::string_view rest) {
    std::vector<std::string> words;
    for (std::string_view t = nextToken(rest); !t.empty(); t = nextToken(rest)) words.push_back(upper(t));
    if (words.empty()) return;
    if (words[0] == "INVERTNEXT") {
      invertNext = true;
      return;
    }
    Command c;
    c.type = Cmd::Bfc;
    if (words[0] == "NOCERTIFY") {
      c.cert = Command::Cert::NoCertify;
    } else if (words[0] == "CERTIFY") {
      c.cert = words.size() > 1 && words[1] == "CW" ? Command::Cert::CW : Command::Cert::CCW;
    } else {
      for (const std::string& w : words) {
        if (w == "CW") c.winding = Command::Wind::CW;
        else if (w == "CCW") c.winding = Command::Wind::CCW;
        else if (w == "CLIP") c.clip = 1;
        else if (w == "NOCLIP") c.clip = 0;
      }
      if (c.winding == Command::Wind::None && c.clip < 0) return;
    }
    file.cmds.push_back(std::move(c));
  }

  bool reference(std::string_view rest) {
    Command c;
    c.type = Cmd::Ref;
    double n[12];
    if (!parseColor(nextToken(rest), c.color) || !parseNumbers(rest, n, 12)) return false;
    const std::string_view name = trim(rest);
    if (name.empty()) return false;
    c.xf.t = {n[0], n[1], n[2]};
    for (int i = 0; i < 9; i++) c.xf.r.m[i] = n[3 + i];
    c.file = normalizeName(name);
    c.invert = invertNext;
    c.group = !nextGroup.empty() ? nextGroup : groups.empty() ? std::string() : groups.back();
    file.cmds.push_back(std::move(c));
    return true;
  }

  bool geometry(Cmd type, int values, std::string_view rest) {
    Command c;
    c.type = type;
    if (!parseColor(nextToken(rest), c.color) || !parseNumbers(rest, c.pts, values)) return false;
    file.cmds.push_back(std::move(c));
    return true;
  }

  void line(std::string_view raw) {
    std::string_view rest = trim(raw);
    if (rest.empty()) return;
    const std::string_view type = nextToken(rest);
    if (type == "0") {
      meta(rest);
      return;
    }
    sawFirstLine = true;
    bool ok = false;
    if (type == "1") {
      ok = reference(rest);
      // INVERTNEXT and an MLCAD group apply to the one line that follows, well-formed or not.
      invertNext = false;
      nextGroup.clear();
    } else if (type == "2") {
      ok = geometry(Cmd::Line, 6, rest);
    } else if (type == "3") {
      ok = geometry(Cmd::Tri, 9, rest);
    } else if (type == "4") {
      ok = geometry(Cmd::Quad, 12, rest);
    } else if (type == "5") {
      ok = true;  // conditional edge lines are not used
    }
    if (!ok) file.skipped++;
  }
};

/// Calls fn(line) for each line of text (split on '\n'; '\r' is trimmed by the caller).
template <typename Fn>
void eachLine(std::string_view text, Fn&& fn) {
  size_t at = 0;
  while (at <= text.size()) {
    size_t end = text.find('\n', at);
    if (end == std::string_view::npos) end = text.size();
    fn(text.substr(at, end - at));
    at = end + 1;
  }
}

/// If `line` is `0 <keyword> rest`, returns true and the trimmed rest.
bool metaLine(std::string_view line, std::string_view keyword, std::string_view& rest) {
  std::string_view scan = line;
  if (nextToken(scan) != "0") return false;
  if (upper(nextToken(scan)) != keyword) return false;
  rest = trim(scan);
  return true;
}

}  // namespace

std::string normalizeName(std::string_view name) {
  std::string out(trim(name));
  for (char& c : out) {
    if (c == '\\') c = '/';
    else if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return out;
}

File parse(std::string_view text, std::string_view name) {
  Parser p;
  p.file.name = normalizeName(name);
  eachLine(text, [&](std::string_view l) { p.line(l); });
  return std::move(p.file);
}

std::vector<File> parseMpd(std::string_view text, std::string_view name) {
  // Find the section boundaries first, then parse each file's own text.
  struct Section {
    std::string name;
    size_t begin, end;
    bool data;
  };
  std::vector<Section> sections;
  bool open = false;
  size_t at = 0;
  auto close = [&](size_t end) {
    if (open) sections.back().end = end;
    open = false;
  };
  while (at <= text.size()) {
    size_t end = text.find('\n', at);
    if (end == std::string_view::npos) end = text.size();
    const std::string_view line = text.substr(at, end - at);
    std::string_view rest;
    if (!line.empty() && (line.front() == '0' || isSpace(line.front()))) {
      if (metaLine(line, "FILE", rest)) {
        close(at);
        sections.push_back({std::string(rest), std::min(end + 1, text.size()), text.size(), false});
        open = true;
      } else if (metaLine(line, "!DATA", rest)) {
        close(at);
        sections.push_back({std::string(rest), std::min(end + 1, text.size()), text.size(), true});
        open = true;
      } else if (metaLine(line, "NOFILE", rest)) {
        close(at);
      }
    }
    at = end + 1;
  }
  std::vector<File> files;
  for (const Section& s : sections)
    if (!s.data) files.push_back(parse(text.substr(s.begin, s.end - s.begin), s.name));
  if (files.empty()) files.push_back(parse(text, name));
  return files;
}

}  // namespace bm::ldraw
