#include <node_api.h>

#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "bmapp/assembly_inspection.h"
#include "bmapp/motion_audit.h"
#include "bmapp/part_catalog.h"
#include "bmapp/session.h"
#include "bmapp/types.h"
#include "bmapp/viewport.h"

namespace {

std::mutex g_mutex;
std::unique_ptr<bmapp::Session> g_session;
std::unique_ptr<bmapp::Viewport> g_viewport;

bmapp::Session& ensureSession() {
  if (!g_session) {
    g_session = std::make_unique<bmapp::Session>();
    g_session->newBlank();
  }
  return *g_session;
}

bmapp::Viewport& ensureViewport() {
  auto& sess = ensureSession();
  if (!g_viewport || g_viewport->sessionAddress() != sess.address()) {
    g_viewport = std::make_unique<bmapp::Viewport>(sess);
  }
  return *g_viewport;
}

// ---------------------------------------------------------------------------
// N-API conversion helpers
// ---------------------------------------------------------------------------

napi_value makeString(napi_env env, const std::string& s) {
  napi_value out;
  napi_create_string_utf8(env, s.data(), s.size(), &out);
  return out;
}

napi_value makeBool(napi_env env, bool v) {
  napi_value out;
  napi_get_boolean(env, v, &out);
  return out;
}

napi_value makeDouble(napi_env env, double v) {
  napi_value out;
  napi_create_double(env, v, &out);
  return out;
}

napi_value makeInt32(napi_env env, int32_t v) {
  napi_value out;
  napi_create_int32(env, v, &out);
  return out;
}

napi_value makeUint32(napi_env env, uint32_t v) {
  napi_value out;
  napi_create_uint32(env, v, &out);
  return out;
}

void setProp(napi_env env, napi_value obj, const char* key, napi_value val) {
  napi_set_named_property(env, obj, key, val);
}

std::string getString(napi_env env, napi_value val) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, val, nullptr, 0, &len) != napi_ok) return {};
  std::string out(len, '\0');
  napi_get_value_string_utf8(env, val, out.data(), len + 1, &len);
  return out;
}

double getDouble(napi_env env, napi_value val, double fallback = 0.0) {
  double out = fallback;
  napi_get_value_double(env, val, &out);
  return out;
}

int32_t getInt32(napi_env env, napi_value val, int32_t fallback = 0) {
  int32_t out = fallback;
  napi_get_value_int32(env, val, &out);
  return out;
}

bool getBool(napi_env env, napi_value val, bool fallback = false) {
  bool out = fallback;
  napi_get_value_bool(env, val, &out);
  return out;
}

std::vector<uint32_t> getPieceList(napi_env env, napi_value arr) {
  std::vector<uint32_t> out;
  bool isArr = false;
  if (napi_is_array(env, arr, &isArr) != napi_ok || !isArr) return out;
  uint32_t len = 0;
  napi_get_array_length(env, arr, &len);
  out.reserve(len);
  for (uint32_t i = 0; i < len; ++i) {
    napi_value el;
    if (napi_get_element(env, arr, i, &el) == napi_ok) {
      uint32_t v = 0;
      if (napi_get_value_uint32(env, el, &v) == napi_ok) out.push_back(v);
    }
  }
  return out;
}

std::vector<std::string> getStringList(napi_env env, napi_value arr) {
  std::vector<std::string> out;
  bool isArr = false;
  if (napi_is_array(env, arr, &isArr) != napi_ok || !isArr) return out;
  uint32_t len = 0;
  napi_get_array_length(env, arr, &len);
  out.reserve(len);
  for (uint32_t i = 0; i < len; ++i) {
    napi_value el;
    if (napi_get_element(env, arr, i, &el) == napi_ok) {
      out.push_back(getString(env, el));
    }
  }
  return out;
}

napi_value makeVec3(napi_env env, const bmapp::Vec3& v) {
  napi_value obj;
  napi_create_object(env, &obj);
  setProp(env, obj, "x", makeDouble(env, v.x));
  setProp(env, obj, "y", makeDouble(env, v.y));
  setProp(env, obj, "z", makeDouble(env, v.z));
  return obj;
}

napi_value makeUint32Array(napi_env env, const std::vector<uint32_t>& list) {
  napi_value arr;
  napi_create_array_with_length(env, list.size(), &arr);
  for (size_t i = 0; i < list.size(); ++i) {
    napi_set_element(env, arr, static_cast<uint32_t>(i), makeUint32(env, list[i]));
  }
  return arr;
}

napi_value makeOpenResult(napi_env env, const bmapp::OpenResult& r, const bmapp::Session& s) {
  napi_value obj;
  napi_create_object(env, &obj);
  setProp(env, obj, "ok", makeBool(env, r.ok));
  setProp(env, obj, "error", makeString(env, r.error));
  setProp(env, obj, "warnings", makeString(env, r.warnings));
  setProp(env, obj, "generation", makeDouble(env, static_cast<double>(s.generation())));
  setProp(env, obj, "title", makeString(env, s.title()));
  setProp(env, obj, "pieceCount", makeDouble(env, static_cast<double>(s.pieceCount())));
  setProp(env, obj, "imported", makeBool(env, s.imported()));
  return obj;
}

napi_value makeChanged(napi_env env, const bmapp::Changed& c) {
  napi_value obj;
  napi_create_object(env, &obj);
  setProp(env, obj, "structure", makeBool(env, c.structure));
  setProp(env, obj, "keyframesOnly", makeBool(env, c.keyframesOnly));
  setProp(env, obj, "moved", makeUint32Array(env, c.moved));
  setProp(env, obj, "recolored", makeUint32Array(env, c.recolored));
  setProp(env, obj, "removed", makeUint32Array(env, c.removed));
  setProp(env, obj, "version", makeDouble(env, static_cast<double>(c.version)));
  setProp(env, obj, "refused", makeString(env, c.refused));
  return obj;
}

const char* planStateName(bmapp::PlanState s) {
  switch (s) {
    case bmapp::PlanState::Idle: return "idle";
    case bmapp::PlanState::Planning: return "planning";
    case bmapp::PlanState::Ready: return "ready";
    case bmapp::PlanState::Failed: return "failed";
  }
  return "idle";
}

const char* planStageName(bmapp::PlanStage s) {
  switch (s) {
    case bmapp::PlanStage::Waiting: return "waiting";
    case bmapp::PlanStage::Solving: return "solving";
    case bmapp::PlanStage::CheckingFlights: return "checking-flights";
    case bmapp::PlanStage::Preparing: return "preparing";
    case bmapp::PlanStage::StandardPreview: return "standard-preview";
  }
  return "waiting";
}

const char* jointTypeName(bmapp::JointType t) {
  switch (t) {
    case bmapp::JointType::Fixed: return "fixed";
    case bmapp::JointType::Hinge: return "hinge";
    case bmapp::JointType::Slider: return "slider";
    case bmapp::JointType::Cylindrical: return "cylindrical";
    case bmapp::JointType::Ball: return "ball";
    case bmapp::JointType::Flexible: return "flexible";
  }
  return "fixed";
}

// ---------------------------------------------------------------------------
// Exported N-API functions
// ---------------------------------------------------------------------------

napi_value fnEngineInfo(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  napi_value obj;
  napi_create_object(env, &obj);
  setProp(env, obj, "version", makeString(env, bmapp::Session::engineVersion()));
  setProp(env, obj, "ldrawDir", makeString(env, bmapp::Session::ldrawDirectory()));
  setProp(env, obj, "metalAvailable", makeBool(env, bmapp::Viewport::metalDevice() != nullptr));
  return obj;
}

napi_value fnSessionNewBlank(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto& sess = ensureSession();
  auto res = sess.newBlank();
  if (g_viewport) g_viewport->fitAll();
  return makeOpenResult(env, res, sess);
}

napi_value fnSessionOpenFile(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string path = argc >= 1 ? getString(env, argv[0]) : "";
  std::lock_guard<std::mutex> lock(g_mutex);
  auto& sess = ensureSession();
  auto res = sess.open(path);
  if (res.ok && g_viewport) g_viewport->fitAll();
  return makeOpenResult(env, res, sess);
}

napi_value fnSessionOpenBytes(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string bytes = argc >= 1 ? getString(env, argv[0]) : "";
  std::string path = argc >= 2 ? getString(env, argv[1]) : "project.brickmotion";
  std::lock_guard<std::mutex> lock(g_mutex);
  auto& sess = ensureSession();
  auto res = sess.openBytes(bytes, path);
  if (res.ok && g_viewport) g_viewport->fitAll();
  return makeOpenResult(env, res, sess);
}

napi_value fnSessionProjectBytes(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto& sess = ensureSession();
  return makeString(env, sess.projectBytes());
}

napi_value fnSessionMpdBytes(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto& sess = ensureSession();
  return makeString(env, sess.mpdBytes());
}

napi_value fnSessionSnapshot(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto& sess = ensureSession();
  auto snap = sess.snapshot();
  napi_value obj;
  napi_create_object(env, &obj);
  setProp(env, obj, "version", makeDouble(env, static_cast<double>(snap.version)));
  setProp(env, obj, "generation", makeDouble(env, static_cast<double>(sess.generation())));
  setProp(env, obj, "title", makeString(env, sess.title()));
  setProp(env, obj, "pieces", makeDouble(env, static_cast<double>(snap.pieces)));
  setProp(env, obj, "selection", makeUint32Array(env, snap.selection));
  setProp(env, obj, "undoName", makeString(env, snap.undoName));
  setProp(env, obj, "redoName", makeString(env, snap.redoName));
  setProp(env, obj, "dirty", makeBool(env, snap.dirty));
  setProp(env, obj, "hidden", makeDouble(env, static_cast<double>(snap.hidden)));
  setProp(env, obj, "focus", makeString(env, snap.focus));

  napi_value selectedArr;
  napi_create_array_with_length(env, snap.selected.size(), &selectedArr);
  for (size_t i = 0; i < snap.selected.size(); ++i) {
    const auto& p = snap.selected[i];
    napi_value item;
    napi_create_object(env, &item);
    setProp(env, item, "piece", makeUint32(env, p.piece));
    setProp(env, item, "part", makeString(env, p.part));
    setProp(env, item, "description", makeString(env, p.description));
    setProp(env, item, "colorName", makeString(env, p.colorName));
    setProp(env, item, "color", makeInt32(env, p.color));
    setProp(env, item, "step", makeInt32(env, p.step));
    setProp(env, item, "submodelPath", makeString(env, p.submodelPath));
    setProp(env, item, "inSharedSubmodel", makeBool(env, p.inSharedSubmodel));
    setProp(env, item, "position", makeVec3(env, p.position));
    napi_set_element(env, selectedArr, static_cast<uint32_t>(i), item);
  }
  setProp(env, obj, "selected", selectedArr);
  return obj;
}

napi_value fnSessionOutline(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto rows = ensureSession().outline();
  napi_value arr;
  napi_create_array_with_length(env, rows.size(), &arr);
  for (size_t i = 0; i < rows.size(); ++i) {
    const auto& r = rows[i];
    napi_value o;
    napi_create_object(env, &o);
    setProp(env, o, "id", makeString(env, r.id));
    setProp(env, o, "def", makeString(env, r.def));
    setProp(env, o, "name", makeString(env, r.name));
    setProp(env, o, "group", makeString(env, r.group));
    setProp(env, o, "depth", makeInt32(env, r.depth));
    setProp(env, o, "parent", makeInt32(env, r.parent));
    setProp(env, o, "pieces", makeDouble(env, static_cast<double>(r.pieces)));
    setProp(env, o, "uses", makeDouble(env, static_cast<double>(r.uses)));
    setProp(env, o, "shared", makeBool(env, r.shared));
    setProp(env, o, "unused", makeBool(env, r.unused));
    napi_set_element(env, arr, static_cast<uint32_t>(i), o);
  }
  return arr;
}

napi_value fnSessionSteps(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto rows = ensureSession().steps();
  napi_value arr;
  napi_create_array_with_length(env, rows.size(), &arr);
  for (size_t i = 0; i < rows.size(); ++i) {
    const auto& r = rows[i];
    napi_value o;
    napi_create_object(env, &o);
    setProp(env, o, "index", makeDouble(env, static_cast<double>(r.index)));
    setProp(env, o, "title", makeString(env, r.title));
    setProp(env, o, "notes", makeString(env, r.notes));
    setProp(env, o, "pauseAfter", makeDouble(env, r.pauseAfter));
    setProp(env, o, "pinOrder", makeBool(env, r.pinOrder));
    setProp(env, o, "automatic", makeBool(env, r.automatic));
    setProp(env, o, "items", makeDouble(env, static_cast<double>(r.items)));
    setProp(env, o, "pieces", makeDouble(env, static_cast<double>(r.pieces)));
    setProp(env, o, "submodels", makeDouble(env, static_cast<double>(r.submodels)));
    napi_set_element(env, arr, static_cast<uint32_t>(i), o);
  }
  return arr;
}

napi_value fnSessionColors(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto colors = ensureSession().colors();
  napi_value arr;
  napi_create_array_with_length(env, colors.size(), &arr);
  for (size_t i = 0; i < colors.size(); ++i) {
    const auto& c = colors[i];
    napi_value o;
    napi_create_object(env, &o);
    setProp(env, o, "code", makeInt32(env, c.code));
    setProp(env, o, "name", makeString(env, c.name));
    setProp(env, o, "rgb", makeUint32(env, c.rgb));
    setProp(env, o, "alpha", makeDouble(env, c.alpha));
    setProp(env, o, "group", makeInt32(env, c.group));
    napi_set_element(env, arr, static_cast<uint32_t>(i), o);
  }
  return arr;
}

napi_value fnSessionSearchParts(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string query = argc >= 1 ? getString(env, argv[0]) : "";
  size_t limit = argc >= 2 ? static_cast<size_t>(std::max(1, getInt32(env, argv[1], 50))) : 50;
  std::lock_guard<std::mutex> lock(g_mutex);
  auto matches = ensureSession().searchParts(query, limit);
  napi_value arr;
  napi_create_array_with_length(env, matches.size(), &arr);
  for (size_t i = 0; i < matches.size(); ++i) {
    napi_value o;
    napi_create_object(env, &o);
    setProp(env, o, "name", makeString(env, matches[i].name));
    setProp(env, o, "description", makeString(env, matches[i].description));
    setProp(env, o, "category", makeString(env, matches[i].category));
    napi_set_element(env, arr, static_cast<uint32_t>(i), o);
  }
  return arr;
}

napi_value fnSessionUndo(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  return makeChanged(env, ensureSession().undo());
}

napi_value fnSessionRedo(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  return makeChanged(env, ensureSession().redo());
}

napi_value fnSessionSelect(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto pieces = argc >= 1 ? getPieceList(env, argv[0]) : std::vector<uint32_t>{};
  std::string modeStr = argc >= 2 ? getString(env, argv[1]) : "replace";
  bmapp::SelectMode mode = bmapp::SelectMode::Replace;
  if (modeStr == "add") mode = bmapp::SelectMode::Add;
  else if (modeStr == "toggle") mode = bmapp::SelectMode::Toggle;
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureSession().select(pieces, mode);
  if (g_viewport) g_viewport->showSelection();
  return makeBool(env, true);
}

napi_value fnSessionSelectAll(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureSession().selectAll();
  if (g_viewport) g_viewport->showSelection();
  return makeBool(env, true);
}

napi_value fnSessionSelectNone(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureSession().selectNone();
  if (g_viewport) g_viewport->showSelection();
  return makeBool(env, true);
}

napi_value fnSessionHide(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto pieces = argc >= 1 ? getPieceList(env, argv[0]) : std::vector<uint32_t>{};
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureSession().hide(pieces);
  return makeBool(env, true);
}

napi_value fnSessionShowAll(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureSession().showAll();
  return makeBool(env, true);
}

napi_value fnSessionRecolor(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto pieces = argc >= 1 ? getPieceList(env, argv[0]) : std::vector<uint32_t>{};
  int color = argc >= 2 ? getInt32(env, argv[1], 16) : 16;
  std::lock_guard<std::mutex> lock(g_mutex);
  return makeChanged(env, ensureSession().recolor(pieces, color));
}

napi_value fnSessionRemove(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto pieces = argc >= 1 ? getPieceList(env, argv[0]) : std::vector<uint32_t>{};
  std::lock_guard<std::mutex> lock(g_mutex);
  return makeChanged(env, ensureSession().remove(pieces));
}

napi_value fnSessionMove(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto pieces = argc >= 1 ? getPieceList(env, argv[0]) : std::vector<uint32_t>{};
  bmapp::Vec3 delta{
      argc >= 2 ? getDouble(env, argv[1]) : 0.0,
      argc >= 3 ? getDouble(env, argv[2]) : 0.0,
      argc >= 4 ? getDouble(env, argv[3]) : 0.0,
  };
  bool cont = argc >= 5 ? getBool(env, argv[4], false) : false;
  std::lock_guard<std::mutex> lock(g_mutex);
  return makeChanged(env, ensureSession().move(pieces, delta, cont));
}

napi_value fnSessionFocus(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto path = argc >= 1 ? getStringList(env, argv[0]) : std::vector<std::string>{};
  std::lock_guard<std::mutex> lock(g_mutex);
  auto changed = ensureSession().focus(path);
  if (g_viewport) g_viewport->fitAll();
  return makeChanged(env, changed);
}

// ---------------------------------------------------------------------------
// Metal Viewport N-API bindings
// ---------------------------------------------------------------------------

napi_value fnViewportResize(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  int w = argc >= 1 ? std::max(1, getInt32(env, argv[0], 640)) : 640;
  int h = argc >= 2 ? std::max(1, getInt32(env, argv[1], 480)) : 480;
  double scale = argc >= 3 ? std::max(1.0, getDouble(env, argv[2], 1.0)) : 1.0;
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().resize(w, h, scale);
  return makeBool(env, true);
}

napi_value fnViewportSetBackground(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double r = argc >= 1 ? getDouble(env, argv[0], 0.12) : 0.12;
  double g = argc >= 2 ? getDouble(env, argv[1], 0.13) : 0.13;
  double b = argc >= 3 ? getDouble(env, argv[2], 0.15) : 0.15;
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().setBackground(r, g, b);
  return makeBool(env, true);
}

napi_value fnViewportSetPreferences(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  bmapp::ViewportPreferences prefs;
  if (argc >= 1) {
    napi_value v;
    if (napi_get_named_property(env, argv[0], "edges", &v) == napi_ok) prefs.edges = getBool(env, v, true);
    if (napi_get_named_property(env, argv[0], "floor", &v) == napi_ok) prefs.floor = getBool(env, v, true);
    if (napi_get_named_property(env, argv[0], "shadows", &v) == napi_ok) prefs.shadows = getBool(env, v, true);
    if (napi_get_named_property(env, argv[0], "ambientOcclusion", &v) == napi_ok) prefs.ambientOcclusion = getBool(env, v, true);
    if (napi_get_named_property(env, argv[0], "autoPlan", &v) == napi_ok) prefs.autoPlan = getBool(env, v, true);
  }
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().setPreferences(prefs);
  return makeBool(env, true);
}

napi_value fnViewportSetViewStyle(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string style = argc >= 1 ? getString(env, argv[0]) : "shaded";
  bmapp::ViewStyle vs = bmapp::ViewStyle::Shaded;
  if (style == "clay") vs = bmapp::ViewStyle::Clay;
  else if (style == "wireframe") vs = bmapp::ViewStyle::Wireframe;
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().setViewStyle(vs);
  return makeBool(env, true);
}

napi_value fnViewportSetOrthographic(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  bool on = argc >= 1 ? getBool(env, argv[0], false) : false;
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().setOrthographic(on);
  return makeBool(env, true);
}

napi_value fnViewportRenderFrame(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto& vp = ensureViewport();
  bool needsMore = vp.draw(nullptr);
  auto pic = vp.readback();

  napi_value obj;
  napi_create_object(env, &obj);
  setProp(env, obj, "width", makeInt32(env, pic.width));
  setProp(env, obj, "height", makeInt32(env, pic.height));
  setProp(env, obj, "needsMore", makeBool(env, needsMore));

  void* data = nullptr;
  napi_value buf;
  napi_create_buffer_copy(env, pic.rgba.size(), pic.rgba.data(), &data, &buf);
  setProp(env, obj, "rgba", buf);
  return obj;
}

napi_value fnViewportNeedsDraw(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  return makeBool(env, ensureViewport().needsDraw());
}

napi_value fnViewportOrbit(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double dx = argc >= 1 ? getDouble(env, argv[0]) : 0.0;
  double dy = argc >= 2 ? getDouble(env, argv[1]) : 0.0;
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().orbit(dx, dy);
  return makeBool(env, true);
}

napi_value fnViewportPan(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double dx = argc >= 1 ? getDouble(env, argv[0]) : 0.0;
  double dy = argc >= 2 ? getDouble(env, argv[1]) : 0.0;
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().pan(dx, dy);
  return makeBool(env, true);
}

napi_value fnViewportZoom(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double f = argc >= 1 ? getDouble(env, argv[0], 1.0) : 1.0;
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().zoom(f);
  return makeBool(env, true);
}

napi_value fnViewportZoomToward(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double f = argc >= 1 ? getDouble(env, argv[0], 1.0) : 1.0;
  double x = argc >= 2 ? getDouble(env, argv[1], 0.0) : 0.0;
  double y = argc >= 3 ? getDouble(env, argv[2], 0.0) : 0.0;
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().zoomToward(f, x, y);
  return makeBool(env, true);
}

napi_value fnViewportFitAll(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().fitAll();
  return makeBool(env, true);
}

napi_value fnViewportFrameSelection(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().frameSelection();
  return makeBool(env, true);
}

napi_value fnViewportCenterOnFloor(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().centerOnFloor();
  return makeBool(env, true);
}

napi_value fnViewportViewPreset(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string preset = argc >= 1 ? getString(env, argv[0]) : "front";
  bmapp::ViewPreset vp = bmapp::ViewPreset::Front;
  if (preset == "back") vp = bmapp::ViewPreset::Back;
  else if (preset == "right") vp = bmapp::ViewPreset::Right;
  else if (preset == "left") vp = bmapp::ViewPreset::Left;
  else if (preset == "top") vp = bmapp::ViewPreset::Top;
  else if (preset == "bottom") vp = bmapp::ViewPreset::Bottom;
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().view(vp);
  return makeBool(env, true);
}

napi_value fnViewportCamera(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto& vp = ensureViewport();
  auto cam = vp.camera();
  napi_value obj;
  napi_create_object(env, &obj);
  setProp(env, obj, "yaw", makeDouble(env, cam.yaw));
  setProp(env, obj, "pitch", makeDouble(env, cam.pitch));
  setProp(env, obj, "distance", makeDouble(env, cam.distance));
  setProp(env, obj, "target", makeVec3(env, cam.target));
  setProp(env, obj, "orthographic", makeBool(env, cam.orthographic));
  setProp(env, obj, "verticalFOV", makeDouble(env, cam.verticalFOV));
  setProp(env, obj, "zoomPercent", makeDouble(env, vp.zoomPercent()));
  return obj;
}

napi_value fnViewportPick(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double x = argc >= 1 ? getDouble(env, argv[0]) : 0.0;
  double y = argc >= 2 ? getDouble(env, argv[1]) : 0.0;
  std::lock_guard<std::mutex> lock(g_mutex);
  uint32_t piece = ensureViewport().pick(x, y);
  if (piece == UINT32_MAX) {
    napi_value nil;
    napi_get_null(env, &nil);
    return nil;
  }
  return makeUint32(env, piece);
}

napi_value fnViewportMarquee(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double x0 = argc >= 1 ? getDouble(env, argv[0]) : 0.0;
  double y0 = argc >= 2 ? getDouble(env, argv[1]) : 0.0;
  double x1 = argc >= 3 ? getDouble(env, argv[2]) : 0.0;
  double y1 = argc >= 4 ? getDouble(env, argv[3]) : 0.0;
  bool touching = argc >= 5 ? getBool(env, argv[4], true) : true;
  std::lock_guard<std::mutex> lock(g_mutex);
  return makeUint32Array(env, ensureViewport().marquee(x0, y0, x1, y1, touching));
}

// ---------------------------------------------------------------------------
// Native Planner & Playback
// ---------------------------------------------------------------------------

napi_value fnViewportRequestPlan(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().requestPlan();
  return makeBool(env, true);
}

napi_value fnViewportRegeneratePlan(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  bool standard = argc >= 1 ? getBool(env, argv[0], false) : false;
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().regeneratePlan(standard);
  return makeBool(env, true);
}

napi_value fnViewportPlay(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  bool on = argc >= 1 ? getBool(env, argv[0], true) : true;
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().play(on);
  return makeBool(env, true);
}

napi_value fnViewportSeek(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double sec = argc >= 1 ? getDouble(env, argv[0], 0.0) : 0.0;
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().seek(sec);
  return makeBool(env, true);
}

napi_value fnViewportShowRest(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().showRest();
  return makeBool(env, true);
}

napi_value fnViewportSetPlaybackRate(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double rate = argc >= 1 ? getDouble(env, argv[0], 1.0) : 1.0;
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().setPlaybackRate(rate);
  return makeBool(env, true);
}

napi_value fnViewportSetPlaybackLoop(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  bool loop = argc >= 1 ? getBool(env, argv[0], false) : false;
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().setPlaybackLoop(loop);
  return makeBool(env, true);
}

napi_value fnViewportSetDirectorPreview(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  bool directed = argc >= 1 ? getBool(env, argv[0], false) : false;
  std::lock_guard<std::mutex> lock(g_mutex);
  ensureViewport().setDirectorPreview(directed);
  return makeBool(env, true);
}

napi_value fnViewportPlaybackState(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto& vp = ensureViewport();
  auto st = vp.playbackState();
  napi_value obj;
  napi_create_object(env, &obj);
  setProp(env, obj, "seconds", makeDouble(env, st.seconds));
  setProp(env, obj, "duration", makeDouble(env, st.duration));
  setProp(env, obj, "playing", makeBool(env, st.playing));
  setProp(env, obj, "waitingToPlay", makeBool(env, st.waitingToPlay));
  setProp(env, obj, "atRest", makeBool(env, st.atRest));
  setProp(env, obj, "stale", makeBool(env, st.stale));
  setProp(env, obj, "planState", makeString(env, planStateName(st.plan)));
  setProp(env, obj, "planStage", makeString(env, planStageName(st.stage)));
  setProp(env, obj, "planError", makeString(env, vp.planError()));
  setProp(env, obj, "version", makeDouble(env, static_cast<double>(st.version)));
  return obj;
}

napi_value fnViewportBuildTimeline(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto tl = ensureViewport().buildTimeline();
  napi_value obj;
  napi_create_object(env, &obj);
  setProp(env, obj, "version", makeDouble(env, static_cast<double>(tl.version)));
  setProp(env, obj, "duration", makeDouble(env, tl.duration));
  setProp(env, obj, "framesPerSecond", makeDouble(env, tl.framesPerSecond));
  setProp(env, obj, "buildStart", makeDouble(env, tl.buildStart));
  setProp(env, obj, "buildEnd", makeDouble(env, tl.buildEnd));
  setProp(env, obj, "planningMilliseconds", makeDouble(env, tl.planningMilliseconds));
  setProp(env, obj, "reusedMoves", makeDouble(env, static_cast<double>(tl.reusedMoves)));
  setProp(env, obj, "standardPreview", makeBool(env, tl.standardPreview));

  napi_value flightsArr;
  napi_create_array_with_length(env, tl.flights.size(), &flightsArr);
  for (size_t i = 0; i < tl.flights.size(); ++i) {
    const auto& f = tl.flights[i];
    napi_value o;
    napi_create_object(env, &o);
    setProp(env, o, "piece", makeUint32(env, f.piece));
    setProp(env, o, "step", makeInt32(env, f.step));
    setProp(env, o, "depth", makeInt32(env, f.depth));
    setProp(env, o, "color", makeInt32(env, f.color));
    setProp(env, o, "start", makeDouble(env, f.start));
    setProp(env, o, "end", makeDouble(env, f.end));
    setProp(env, o, "name", makeString(env, f.name));
    setProp(env, o, "flag", makeString(env, f.flag));
    setProp(env, o, "blocker", makeString(env, f.blocker));
    setProp(env, o, "independent", makeBool(env, f.independent));
    napi_set_element(env, flightsArr, static_cast<uint32_t>(i), o);
  }
  setProp(env, obj, "flights", flightsArr);

  napi_value notesArr;
  napi_create_array_with_length(env, tl.notes.size(), &notesArr);
  for (size_t i = 0; i < tl.notes.size(); ++i) {
    napi_set_element(env, notesArr, static_cast<uint32_t>(i), makeString(env, tl.notes[i]));
  }
  setProp(env, obj, "notes", notesArr);
  return obj;
}

// ---------------------------------------------------------------------------
// Native Assembly Inspection & Motion Audit
// ---------------------------------------------------------------------------

napi_value fnInspectAssembly(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto selection = argc >= 1 ? getPieceList(env, argv[0]) : std::vector<uint32_t>{};
  bool showAll = argc >= 2 ? getBool(env, argv[1], true) : true;
  bool checkGeom = argc >= 3 ? getBool(env, argv[2], true) : true;

  std::lock_guard<std::mutex> lock(g_mutex);
  auto& sess = ensureSession();
  bmapp::AssemblyInspection* insp = bmapp::AssemblyInspection::capture(&sess);
  auto report = insp->inspect(selection, showAll, checkGeom);
  bmappReleaseAssemblyInspection(insp);

  napi_value obj;
  napi_create_object(env, &obj);
  setProp(env, obj, "error", makeString(env, report.error));
  setProp(env, obj, "connectedCount", makeDouble(env, static_cast<double>(report.connected.size())));
  setProp(env, obj, "rigidCount", makeDouble(env, static_cast<double>(report.rigid.size())));
  setProp(env, obj, "touchingCount", makeDouble(env, static_cast<double>(report.touching.size())));
  setProp(env, obj, "withoutConnectorsCount", makeDouble(env, static_cast<double>(report.withoutConnectors.size())));
  setProp(env, obj, "jointCount", makeDouble(env, static_cast<double>(report.joints.size())));

  size_t maxJoints = std::min<size_t>(report.joints.size(), 200);
  napi_value jointsArr;
  napi_create_array_with_length(env, maxJoints, &jointsArr);
  for (size_t i = 0; i < maxJoints; ++i) {
    const auto& j = report.joints[i];
    napi_value o;
    napi_create_object(env, &o);
    setProp(env, o, "a", makeUint32(env, j.a));
    setProp(env, o, "b", makeUint32(env, j.b));
    setProp(env, o, "type", makeString(env, jointTypeName(j.type)));
    setProp(env, o, "mateCount", makeDouble(env, static_cast<double>(j.mateCount)));
    napi_set_element(env, jointsArr, static_cast<uint32_t>(i), o);
  }
  setProp(env, obj, "joints", jointsArr);

  napi_value overlapsArr;
  napi_create_array_with_length(env, report.overlaps.size(), &overlapsArr);
  for (size_t i = 0; i < report.overlaps.size(); ++i) {
    napi_value o;
    napi_create_object(env, &o);
    setProp(env, o, "a", makeUint32(env, report.overlaps[i].a));
    setProp(env, o, "b", makeUint32(env, report.overlaps[i].b));
    setProp(env, o, "duplicate", makeBool(env, report.overlaps[i].duplicate));
    napi_set_element(env, overlapsArr, static_cast<uint32_t>(i), o);
  }
  setProp(env, obj, "overlaps", overlapsArr);
  return obj;
}

napi_value fnAuditMotion(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t piece = argc >= 1 ? static_cast<uint32_t>(getInt32(env, argv[0], -1)) : UINT32_MAX;

  std::lock_guard<std::mutex> lock(g_mutex);
  bmapp::MotionAudit* audit = ensureViewport().auditMotion(piece);
  auto res = audit->check();
  bmappReleaseMotionAudit(audit);

  napi_value obj;
  napi_create_object(env, &obj);
  setProp(env, obj, "testedFrames", makeInt32(env, res.testedFrames));
  setProp(env, obj, "stride", makeInt32(env, res.stride));
  setProp(env, obj, "intervals", makeInt32(env, res.intervals));
  setProp(env, obj, "error", makeString(env, res.error));
  napi_value contactsArr;
  napi_create_array_with_length(env, res.contacts.size(), &contactsArr);
  for (size_t i = 0; i < res.contacts.size(); ++i) {
    const auto& c = res.contacts[i];
    napi_value item;
    napi_create_object(env, &item);
    setProp(env, item, "a", makeUint32(env, c.a));
    setProp(env, item, "b", makeUint32(env, c.b));
    setProp(env, item, "firstFrame", makeInt32(env, c.firstFrame));
    setProp(env, item, "lastFrame", makeInt32(env, c.lastFrame));
    setProp(env, item, "part", makeString(env, c.part));
    setProp(env, item, "blocker", makeString(env, c.blocker));
    napi_set_element(env, contactsArr, static_cast<uint32_t>(i), item);
  }
  setProp(env, obj, "contacts", contactsArr);
  return obj;
}

// ---------------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------------

#define EXPORT_FN(name, fn) \
  { name, nullptr, fn, nullptr, nullptr, nullptr, napi_default, nullptr }

napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor descs[] = {
      EXPORT_FN("engineInfo", fnEngineInfo),
      EXPORT_FN("sessionNewBlank", fnSessionNewBlank),
      EXPORT_FN("sessionOpenFile", fnSessionOpenFile),
      EXPORT_FN("sessionOpenBytes", fnSessionOpenBytes),
      EXPORT_FN("sessionProjectBytes", fnSessionProjectBytes),
      EXPORT_FN("sessionMpdBytes", fnSessionMpdBytes),
      EXPORT_FN("sessionSnapshot", fnSessionSnapshot),
      EXPORT_FN("sessionOutline", fnSessionOutline),
      EXPORT_FN("sessionSteps", fnSessionSteps),
      EXPORT_FN("sessionColors", fnSessionColors),
      EXPORT_FN("sessionSearchParts", fnSessionSearchParts),
      EXPORT_FN("sessionUndo", fnSessionUndo),
      EXPORT_FN("sessionRedo", fnSessionRedo),
      EXPORT_FN("sessionSelect", fnSessionSelect),
      EXPORT_FN("sessionSelectAll", fnSessionSelectAll),
      EXPORT_FN("sessionSelectNone", fnSessionSelectNone),
      EXPORT_FN("sessionHide", fnSessionHide),
      EXPORT_FN("sessionShowAll", fnSessionShowAll),
      EXPORT_FN("sessionRecolor", fnSessionRecolor),
      EXPORT_FN("sessionRemove", fnSessionRemove),
      EXPORT_FN("sessionMove", fnSessionMove),
      EXPORT_FN("sessionFocus", fnSessionFocus),
      EXPORT_FN("viewportResize", fnViewportResize),
      EXPORT_FN("viewportSetBackground", fnViewportSetBackground),
      EXPORT_FN("viewportSetPreferences", fnViewportSetPreferences),
      EXPORT_FN("viewportSetViewStyle", fnViewportSetViewStyle),
      EXPORT_FN("viewportSetOrthographic", fnViewportSetOrthographic),
      EXPORT_FN("viewportRenderFrame", fnViewportRenderFrame),
      EXPORT_FN("viewportNeedsDraw", fnViewportNeedsDraw),
      EXPORT_FN("viewportOrbit", fnViewportOrbit),
      EXPORT_FN("viewportPan", fnViewportPan),
      EXPORT_FN("viewportZoom", fnViewportZoom),
      EXPORT_FN("viewportZoomToward", fnViewportZoomToward),
      EXPORT_FN("viewportFitAll", fnViewportFitAll),
      EXPORT_FN("viewportFrameSelection", fnViewportFrameSelection),
      EXPORT_FN("viewportCenterOnFloor", fnViewportCenterOnFloor),
      EXPORT_FN("viewportViewPreset", fnViewportViewPreset),
      EXPORT_FN("viewportCamera", fnViewportCamera),
      EXPORT_FN("viewportPick", fnViewportPick),
      EXPORT_FN("viewportMarquee", fnViewportMarquee),
      EXPORT_FN("viewportRequestPlan", fnViewportRequestPlan),
      EXPORT_FN("viewportRegeneratePlan", fnViewportRegeneratePlan),
      EXPORT_FN("viewportPlay", fnViewportPlay),
      EXPORT_FN("viewportSeek", fnViewportSeek),
      EXPORT_FN("viewportShowRest", fnViewportShowRest),
      EXPORT_FN("viewportSetPlaybackRate", fnViewportSetPlaybackRate),
      EXPORT_FN("viewportSetPlaybackLoop", fnViewportSetPlaybackLoop),
      EXPORT_FN("viewportSetDirectorPreview", fnViewportSetDirectorPreview),
      EXPORT_FN("viewportPlaybackState", fnViewportPlaybackState),
      EXPORT_FN("viewportBuildTimeline", fnViewportBuildTimeline),
      EXPORT_FN("inspectAssembly", fnInspectAssembly),
      EXPORT_FN("auditMotion", fnAuditMotion),
  };
  napi_define_properties(env, exports, sizeof(descs) / sizeof(descs[0]), descs);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)

}  // namespace
