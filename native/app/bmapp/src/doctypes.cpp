#include "bmapp/doctypes.h"

#include <algorithm>
#include <cctype>

namespace bmapp {

std::vector<DocType> documentTypes() {
  return {
      {"com.brickmotion.project", "brickmotion", "BrickMotion Project", true},
      {"com.brickmotion.plan", "json", "BrickMotion Plan", false},
      {"com.ldraw.model", "ldr", "LDraw Model", false},
      {"com.ldraw.mpd", "mpd", "LDraw Multi-Part Model", false},
      {"com.ldraw.part", "dat", "LDraw Part", false},
      {"com.stud.io", "io", "Studio Model", false},
  };
}

bool isProjectExtension(const std::string& extension) {
  std::string e = extension;
  std::transform(e.begin(), e.end(), e.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return e == "brickmotion";
}

}  // namespace bmapp
