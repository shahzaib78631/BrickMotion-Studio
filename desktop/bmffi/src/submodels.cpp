// Submodels, groups, scale and import-into behind the C interface.
#include "bmffi.h"

#include <string>

#include "bmapp/model_import.h"
#include "bmapp/session.h"
#include "internal.h"

struct BmModelImport {
  bmapp::ModelImport* m;
  std::string error;
};

namespace {

using bmffi::change;
using bmffi::guard;
using bmffi::guardVoid;
using bmffi::list;
using bmffi::make;
using bmffi::to_mat3;
using bmffi::to_vec3;

std::string str(const char* s) { return s ? s : ""; }

BmString joined(const bmapp::StringList& names) {
  std::string out;
  for (size_t i = 0; i < names.size(); ++i) {
    if (i > 0) out.push_back('\n');
    out += names[i];
  }
  return make(out);
}

}  // namespace

extern "C" {

BmString bm_session_free_submodel_name(const BmSession* s, const char* preferred) {
  if (!s) return BmString{nullptr, 0};
  return guard(BmString{nullptr, 0}, [&] { return make(s->s->freeSubmodelName(str(preferred))); });
}

BmChange bm_session_new_submodel(BmSession* s, const char* name) {
  return change(s, [&] { return s->s->newSubmodel(str(name)); });
}

BmChange bm_session_make_submodel(BmSession* s, const uint32_t* pieces, size_t n, const char* name) {
  return change(s, [&] { return s->s->makeSubmodel(list(pieces, n), str(name)); });
}

BmChange bm_session_extract(BmSession* s, uint32_t piece) {
  return change(s, [&] { return s->s->extract(piece); });
}

BmChange bm_session_move_to_model(BmSession* s, const uint32_t* pieces, size_t n, const char* submodel) {
  return change(s, [&] { return s->s->moveToModel(list(pieces, n), str(submodel)); });
}

BmChange bm_session_rename_submodel(BmSession* s, const char* from, const char* to) {
  return change(s, [&] { return s->s->renameSubmodel(str(from), str(to)); });
}

BmChange bm_session_delete_submodel(BmSession* s, const char* submodel) {
  return change(s, [&] { return s->s->deleteSubmodel(str(submodel)); });
}

BmChange bm_session_make_unique(BmSession* s, uint32_t piece) {
  return change(s, [&] { return s->s->makeUnique(piece); });
}

BmChange bm_session_set_group(BmSession* s, const uint32_t* pieces, size_t n, const char* group) {
  return change(s, [&] { return s->s->setGroup(list(pieces, n), str(group)); });
}

BmString bm_session_group_names(const BmSession* s) {
  if (!s) return BmString{nullptr, 0};
  return guard(BmString{nullptr, 0}, [&] { return joined(s->s->groupNames()); });
}

BmString bm_session_groups_of(const BmSession* s, const uint32_t* pieces, size_t n) {
  if (!s) return BmString{nullptr, 0};
  return guard(BmString{nullptr, 0}, [&] { return joined(s->s->groupsOf(list(pieces, n))); });
}

void bm_session_select_group(BmSession* s, const char* group) {
  if (!s) return;
  guardVoid([&] { s->s->selectGroup(str(group)); });
}

BmChange bm_session_scale(BmSession* s, const uint32_t* pieces, size_t n, BmVec3 factor, BmMat3 axes, BmVec3 pivot,
                          bool continuing) {
  return change(s, [&] {
    return s->s->scale(list(pieces, n), to_vec3(factor), to_mat3(axes), to_vec3(pivot), continuing);
  });
}

BmModelImport* bm_model_import_read(const char* path) {
  return guard(static_cast<BmModelImport*>(nullptr), [&] {
    bmapp::ModelImport* m = bmapp::ModelImport::read(str(path));
    auto* out = new BmModelImport{m, m ? m->error() : std::string("The file could not be read.")};
    return out;
  });
}

const char* bm_model_import_error(const BmModelImport* m) { return m ? m->error.c_str() : ""; }

BmChange bm_session_import_model(BmSession* s, const BmModelImport* m, const char* into, uint64_t generation) {
  return change(s, [&] {
    if (!m || !m->m) return bmapp::Changed{.refused = m ? m->error : std::string("Nothing to import.")};
    return s->s->importModel(m->m, str(into), generation);
  });
}

void bm_model_import_free(BmModelImport* m) {
  if (!m) return;
  if (m->m) bmappReleaseModelImport(m->m);
  delete m;
}

}  // extern "C"
