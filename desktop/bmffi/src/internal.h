#pragma once
// The handles and helpers behind the C interface's opaque types, shared by bmffi's source files.
#include <cstdlib>
#include <cstring>
#include <exception>
#include <string>
#include <vector>

#include "bmffi.h"
#include "bmapp/assembly_inspection.h"
#include "bmapp/session.h"
#include "bmapp/viewport.h"

struct BmSession {
  bmapp::Session* s;
};
struct BmViewport {
  bmapp::Viewport* v;
};
struct BmInspection {
  bmapp::AssemblyInspection* inspection;
};
struct BmStrings {
  std::vector<std::string> items;
};

namespace bmffi {

inline BmString make(const std::string& text) {
  BmString out{nullptr, text.size()};
  out.ptr = static_cast<char*>(std::malloc(text.size() + 1));
  if (!out.ptr) return BmString{nullptr, 0};
  std::memcpy(out.ptr, text.data(), text.size());
  out.ptr[text.size()] = '\0';
  return out;
}

template <typename R, typename F>
R guard(R neutral, F&& f) {
  try {
    return f();
  } catch (...) {
    return neutral;
  }
}

template <typename F>
void guardVoid(F&& f) {
  try {
    f();
  } catch (...) {
  }
}

template <typename T, typename F>
T* handle(F&& f) {
  try {
    return f();
  } catch (...) {
    return nullptr;
  }
}

template <typename F>
BmChange change(BmSession* s, F&& f) {
  BmChange out{false, 0, {nullptr, 0}};
  if (!s) {
    out.refused = make("no document");
    return out;
  }
  try {
    bmapp::Changed c = f();
    out.structure = c.structure;
    out.version = c.version;
    out.refused = make(c.refused);
  } catch (const std::exception& e) {
    out.refused = make(e.what());
  } catch (...) {
    out.refused = make("the engine failed during the edit");
  }
  return out;
}

inline std::vector<uint32_t> list(const uint32_t* pieces, size_t n) {
  return std::vector<uint32_t>(pieces, pieces + (pieces ? n : 0));
}

inline bmapp::Vec2 to_vec2(BmVec2 v) { return bmapp::Vec2{v.x, v.y}; }
inline BmVec2 from_vec2(bmapp::Vec2 v) { return BmVec2{v.x, v.y}; }

inline bmapp::Vec3 to_vec3(BmVec3 v) { return bmapp::Vec3{v.x, v.y, v.z}; }
inline BmVec3 from_vec3(bmapp::Vec3 v) { return BmVec3{v.x, v.y, v.z}; }

inline bmapp::Mat3 to_mat3(BmMat3 m) {
  bmapp::Mat3 out;
  std::memcpy(out.m, m.m, sizeof(out.m));
  return out;
}
inline BmMat3 from_mat3(const bmapp::Mat3& m) {
  BmMat3 out;
  std::memcpy(out.m, m.m, sizeof(out.m));
  return out;
}

inline bmapp::CameraState to_camera(BmCamera c) {
  bmapp::CameraState out;
  out.yaw = c.yaw;
  out.pitch = c.pitch;
  out.distance = c.distance;
  out.target = to_vec3(c.target);
  out.orthographic = c.orthographic;
  out.verticalFOV = c.vertical_fov;
  return out;
}
inline BmCamera from_camera(const bmapp::CameraState& c) {
  return BmCamera{c.yaw, c.pitch, c.distance, from_vec3(c.target), c.orthographic, c.verticalFOV};
}

}  // namespace bmffi
