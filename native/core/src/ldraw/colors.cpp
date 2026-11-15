#include <cstdlib>
#include <sstream>
#include "bm/ldraw/library.h"

namespace bm::ldraw {

std::unordered_map<int, Color> parseColors(std::string_view ldconfig) {
  std::unordered_map<int, Color> table;
  std::istringstream in{std::string(ldconfig)};
  std::string line;
  while (std::getline(in, line)) {
    std::istringstream words(line);
    std::vector<std::string> tok;
    for (std::string w; words >> w;) tok.push_back(std::move(w));
    if (tok.size() < 3 || tok[0] != "0" || tok[1] != "!COLOUR") continue;
    auto value = [&](const char* key) -> const std::string* {
      for (size_t i = 3; i + 1 < tok.size(); i++)
        if (tok[i] == key) return &tok[i + 1];
      return nullptr;
    };
    auto has = [&](const char* key) {
      for (size_t i = 3; i < tok.size(); i++)
        if (tok[i] == key) return true;
      return false;
    };
    auto integer = [](const std::string& s, int base, long& out) {
      char* end = nullptr;
      out = std::strtol(s.c_str(), &end, base);
      return !s.empty() && end == s.c_str() + s.size();
    };
    auto hex = [&](const char* key, uint32_t fallback) {
      const std::string* v = value(key);
      long n = 0;
      if (!v || v->size() != 7 || (*v)[0] != '#' || !integer(v->substr(1), 16, n)) return fallback;
      return static_cast<uint32_t>(n);
    };
    const std::string* code = value("CODE");
    long codeValue = 0;
    if (!code || !integer(*code, 10, codeValue)) continue;
    Color c;
    c.code = static_cast<int>(codeValue);
    c.name = tok[2];
    c.rgb = hex("VALUE", 0x888888);
    c.edge = hex("EDGE", 0x333333);
    long alpha = 255;
    if (const std::string* a = value("ALPHA"); a && !integer(*a, 10, alpha)) alpha = 255;
    c.alpha = static_cast<float>(alpha < 0 ? 0 : alpha > 255 ? 255 : alpha) / 255.0f;
    if (has("CHROME")) c.finish = Finish::Chrome;
    else if (has("METAL")) c.finish = Finish::Metal;
    else if (has("PEARLESCENT")) c.finish = Finish::Pearl;
    else if (has("RUBBER")) c.finish = Finish::Rubber;
    if (alpha < 255) c.finish = Finish::Trans;
    table[c.code] = std::move(c);
  }
  return table;
}

}  // namespace bm::ldraw
