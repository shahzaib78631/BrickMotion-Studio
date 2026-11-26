// Motion fields, flight bake, motion check, joints and insertion direction behind the C interface.
#include "bmffi.h"

#include <string>
#include <vector>

#include "bmapp/assembly_inspection.h"
#include "bmapp/flight_bake.h"
#include "bmapp/motion_audit.h"
#include "bmapp/motion_fields.h"
#include "bmapp/session.h"
#include "bmapp/viewport.h"
#include "internal.h"

struct BmFlightBake {
  bmapp::FlightBake* bake;
};
struct BmMotionAudit {
  bmapp::MotionAudit* audit;
};
struct BmMotionReport {
  bmapp::MotionAuditResult result;
};
struct BmJoints {
  bmapp::AssemblyReport report;
};
struct BmJointEdit {
  bmapp::JointEdit edit;
};

namespace {
using bmffi::change;
using bmffi::from_mat3;
using bmffi::from_vec3;
using bmffi::guard;
using bmffi::handle;
using bmffi::list;
using bmffi::make;
using bmffi::to_mat3;
using bmffi::to_vec3;

bmapp::MotionScope scopeOf(int32_t s) {
  return s == BM_MOTION_STEP ? bmapp::MotionScope::Step : s == BM_MOTION_PARTS ? bmapp::MotionScope::Parts : bmapp::MotionScope::Project;
}
bmapp::MotionFields toFields(const BmMotionFields& f) {
  bmapp::MotionFields out;
  out.time = f.time, out.landing = f.landing, out.hover = f.hover, out.ease = f.ease;
  return out;
}
BmMotionFields fromFields(const bmapp::MotionFields& f) { return BmMotionFields{f.time, f.landing, f.hover, f.ease}; }
const BmMotionFields kUnset{-1, -1, -1, -1};
}  // namespace

extern "C" {

BmMotionFields bm_session_motion_fields(const BmSession* s, int32_t scope, size_t step, const uint32_t* pieces, size_t n) {
  if (!s) return kUnset;
  return guard<BmMotionFields>(kUnset, [&] { return fromFields(s->s->motionFields(scopeOf(scope), step, list(pieces, n))); });
}

BmChange bm_session_set_motion_fields(BmSession* s, int32_t scope, size_t step, const uint32_t* pieces, size_t n,
                                      BmMotionFields fields) {
  return change(s, [&] { return s->s->setMotionFields(scopeOf(scope), step, list(pieces, n), toFields(fields)); });
}

BmMotionFields bm_effective_motion(const BmSession* s, int32_t scope, size_t step, BmMotionFields fields) {
  return guard<BmMotionFields>(BmMotionFields{1, 0.25, 0, 0}, [&] {
    return fromFields(bmapp::effectiveMotion(s ? s->s : nullptr, scopeOf(scope), step, toFields(fields)));
  });
}

void bm_flight_phases(BmMotionFields effective, double* travel, double* hover, double* landing) {
  const bmapp::FlightPhases p = bmapp::flightPhases(toFields(effective));
  if (travel) *travel = p.travel;
  if (hover) *hover = p.hover;
  if (landing) *landing = p.landing;
}

BmFlightBake* bm_viewport_capture_flight_bake(BmViewport* v, const uint32_t* pieces, size_t n, bool detach) {
  if (!v) return nullptr;
  return handle<BmFlightBake>([&]() -> BmFlightBake* {
    bmapp::FlightBake* bake = v->v->captureFlightBake(list(pieces, n), detach);
    if (!bake) return nullptr;
    return new BmFlightBake{bake};
  });
}

bool bm_flight_bake_replaces_keys(const BmFlightBake* b) {
  return b && guard<bool>(false, [&] { return b->bake->replacesKeys(); });
}

BmFlightBakeResult bm_flight_bake_prepare(BmFlightBake* b) {
  if (!b) return BmFlightBakeResult{0, 0, make("no bake")};
  try {
    const bmapp::FlightBakeResult r = b->bake->prepare();
    return BmFlightBakeResult{r.flights, r.keys, make(r.error)};
  } catch (...) {
    return BmFlightBakeResult{0, 0, make("the engine failed while baking")};
  }
}

BmChange bm_session_apply_flight_bake(BmSession* s, BmFlightBake* b) {
  return change(s, [&] { return b ? s->s->applyFlightBake(b->bake) : bmapp::Changed{}; });
}

void bm_flight_bake_free(BmFlightBake* b) {
  if (!b) return;
  bmappReleaseFlightBake(b->bake);
  delete b;
}

BmMotionAudit* bm_viewport_audit_motion(BmViewport* v, uint32_t piece) {
  if (!v) return nullptr;
  return handle<BmMotionAudit>([&]() -> BmMotionAudit* {
    bmapp::MotionAudit* audit = v->v->auditMotion(piece);
    if (!audit) return nullptr;
    return new BmMotionAudit{audit};
  });
}

BmMotionReport* bm_motion_audit_check(BmMotionAudit* a) {
  if (!a) return nullptr;
  return handle<BmMotionReport>([&] { return new BmMotionReport{a->audit->check()}; });
}

void bm_motion_audit_free(BmMotionAudit* a) {
  if (!a) return;
  bmappReleaseMotionAudit(a->audit);
  delete a;
}

void bm_motion_report_counts(const BmMotionReport* r, int32_t* tested_frames, int32_t* stride, int32_t* intervals) {
  if (tested_frames) *tested_frames = r ? r->result.testedFrames : 0;
  if (stride) *stride = r ? r->result.stride : 1;
  if (intervals) *intervals = r ? r->result.intervals : 0;
}
const char* bm_motion_report_error(const BmMotionReport* r) { return r ? r->result.error.c_str() : ""; }
size_t bm_motion_report_contacts_len(const BmMotionReport* r) { return r ? r->result.contacts.size() : 0; }
BmMotionContact bm_motion_report_contact_at(const BmMotionReport* r, size_t i) {
  if (!r || i >= r->result.contacts.size()) return BmMotionContact{BM_NO_PIECE, BM_NO_PIECE, -1, -1, "", ""};
  const bmapp::MotionContact& c = r->result.contacts[i];
  return BmMotionContact{c.a, c.b, c.firstFrame, c.lastFrame, c.part.c_str(), c.blocker.c_str()};
}
void bm_motion_report_free(BmMotionReport* r) { delete r; }

BmInspection* bm_inspection_capture(const BmSession* s) {
  if (!s) return nullptr;
  return handle<BmInspection>([&]() -> BmInspection* {
    bmapp::AssemblyInspection* i = bmapp::AssemblyInspection::capture(s->s);
    if (!i) return nullptr;
    return new BmInspection{i};
  });
}

BmJoints* bm_inspection_joints(BmInspection* i, const uint32_t* selection, size_t n, bool show_all, bool check_geometry) {
  if (!i) return nullptr;
  return handle<BmJoints>([&] { return new BmJoints{i->inspection->inspect(list(selection, n), show_all, check_geometry)}; });
}
size_t bm_joints_len(const BmJoints* j) { return j ? j->report.joints.size() : 0; }
BmJointRow bm_joints_at(const BmJoints* j, size_t i) {
  if (!j || i >= j->report.joints.size()) return BmJointRow{0, 0, BM_JOINT_FIXED, {0, 0, 0}, {0, 0, 0}, {0, 0, 0}, 0, 0, 0};
  const bmapp::JointRow& r = j->report.joints[i];
  return BmJointRow{r.a, r.b, static_cast<int32_t>(r.type), from_vec3(r.point), from_vec3(r.axis), from_vec3(r.release),
                    r.angle, r.clearance, r.mateCount};
}
const char* bm_joints_error(const BmJoints* j) { return j ? j->report.error.c_str() : ""; }
void bm_joints_free(BmJoints* j) { delete j; }

size_t bm_inspection_body(BmInspection* i, uint32_t piece, uint32_t* out, size_t cap) {
  if (!i) return 0;
  return guard<size_t>(0, [&] {
    const bmapp::PieceList body = i->inspection->body(piece);
    for (size_t k = 0; out && k < body.size() && k < cap; ++k) out[k] = body[k];
    return body.size();
  });
}

BmJointEdit* bm_inspection_change_joint(BmInspection* i, uint32_t fixed, uint32_t moving, double degrees, bool collision) {
  if (!i) return nullptr;
  return handle<BmJointEdit>([&] { return new BmJointEdit{i->inspection->changeJoint(fixed, moving, degrees, collision)}; });
}
BmJointEdit* bm_inspection_change_joint_ex(BmInspection* i, uint32_t fixed, uint32_t moving, double degrees,
                                           double slide_ldu, BmVec3 axis_override, bool collision) {
  if (!i) return nullptr;
  return handle<BmJointEdit>([&] {
    return new BmJointEdit{
      i->inspection->changeJointEx(fixed, moving, degrees, slide_ldu, to_vec3(axis_override), collision),
    };
  });
}
size_t bm_joint_edit_pieces(const BmJointEdit* e, uint32_t* out, size_t cap) {
  if (!e) return 0;
  const auto& p = e->edit.pieces;
  for (size_t k = 0; out && k < p.size() && k < cap; ++k) out[k] = p[k];
  return p.size();
}
uint32_t bm_joint_edit_pivot(const BmJointEdit* e) { return e ? e->edit.pivot : BM_NO_PIECE; }
void bm_joint_edit_pose(const BmJointEdit* e, BmMat3* rotation, BmVec3* position) {
  if (!e) return;
  if (rotation) *rotation = from_mat3(e->edit.pose.rotation);
  if (position) *position = from_vec3(e->edit.pose.position);
}
const char* bm_joint_edit_error(const BmJointEdit* e) { return e ? e->edit.error.c_str() : "no joint edit"; }
void bm_joint_edit_free(BmJointEdit* e) { delete e; }

void bm_inspection_free(BmInspection* i) {
  if (!i) return;
  bmappReleaseAssemblyInspection(i->inspection);
  delete i;
}

BmChange bm_session_place_moved(BmSession* s, const uint32_t* pieces, size_t n, uint32_t anchor, BmMat3 rotation,
                                BmVec3 position, uint64_t generation, uint64_t version) {
  return change(s, [&] {
    bmapp::PartPose pose;
    pose.rotation = to_mat3(rotation);
    pose.position = to_vec3(position);
    return s->s->placeMoved(list(pieces, n), anchor, pose, generation, version);
  });
}

BmVec3 bm_session_insertion_direction(const BmSession* s, uint32_t piece) {
  if (!s) return BmVec3{0, 0, 0};
  return guard<BmVec3>(BmVec3{0, 0, 0}, [&] { return from_vec3(s->s->insertionDirection(piece)); });
}

BmChange bm_session_set_insertion_direction(BmSession* s, const uint32_t* pieces, size_t n, BmVec3 direction) {
  return change(s, [&] { return s->s->setInsertionDirection(list(pieces, n), to_vec3(direction)); });
}

}  // extern "C"
