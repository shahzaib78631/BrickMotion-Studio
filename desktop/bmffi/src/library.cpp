// Parts library catalog queries and worker-owned square part previews behind the C interface.
#include "bmffi.h"

#include <string>
#include <vector>

#include "bmapp/part_catalog.h"
#include "bmapp/part_preview.h"
#include "bmapp/session.h"
#include "bmapp/viewport.h"
#include "internal.h"

struct BmParts {
  std::vector<bmapp::PartMatch> parts;
};

struct BmPartPreview {
  bmapp::PartPreview* p;
};

struct BmPicture {
  bmapp::Picture pic;
};

namespace {
using bmffi::handle;
}  // namespace

extern "C" {

BmParts* bm_library_parts(const char* query, const char* category, size_t limit) {
  return handle<BmParts>([&] {
    std::string ldraw = bmapp::Session::ldrawDirectory();
    if (ldraw.empty()) return new BmParts{};
    return new BmParts{bmapp::libraryParts(ldraw, query ? query : "", category ? category : "", limit)};
  });
}

BmParts* bm_common_parts(void) {
  return handle<BmParts>([&] {
    std::string ldraw = bmapp::Session::ldrawDirectory();
    if (ldraw.empty()) return new BmParts{};
    return new BmParts{bmapp::commonParts(ldraw)};
  });
}

size_t bm_parts_len(const BmParts* p) { return p ? p->parts.size() : 0; }

BmPartMatch bm_parts_at(const BmParts* p, size_t i) {
  if (!p || i >= p->parts.size()) return BmPartMatch{"", "", ""};
  const bmapp::PartMatch& m = p->parts[i];
  return BmPartMatch{m.name.c_str(), m.description.c_str(), m.category.c_str()};
}

void bm_parts_free(BmParts* p) { delete p; }

BmStrings* bm_part_categories(void) {
  return handle<BmStrings>([&] {
    std::string ldraw = bmapp::Session::ldrawDirectory();
    if (ldraw.empty()) return new BmStrings{};
    return new BmStrings{bmapp::partCategories(ldraw)};
  });
}

size_t bm_strings_len(const BmStrings* s) { return s ? s->items.size() : 0; }

const char* bm_strings_at(const BmStrings* s, size_t i) {
  if (!s || i >= s->items.size()) return "";
  return s->items[i].c_str();
}

void bm_strings_free(BmStrings* s) { delete s; }

BmPartPreview* bm_part_preview_new(void) {
  return handle<BmPartPreview>([&]() -> BmPartPreview* {
    std::string ldraw = bmapp::Session::ldrawDirectory();
    if (ldraw.empty() || !bmapp::Viewport::metalDevice()) return nullptr;
    bmapp::PartPreview* p = bmapp::PartPreview::create(ldraw);
    return p ? new BmPartPreview{p} : nullptr;
  });
}

void bm_part_preview_free(BmPartPreview* p) {
  if (!p) return;
  bmappReleasePartPreview(p->p);
  delete p;
}

BmPicture* bm_part_preview_render(BmPartPreview* p, const char* part, int32_t color, bool dark) {
  if (!p || !part || part[0] == '\0') return nullptr;
  return handle<BmPicture>([&] { return new BmPicture{p->p->render(part, color, dark)}; });
}

void bm_picture_info(const BmPicture* p, int* w, int* h) {
  if (w) *w = p ? p->pic.width : 0;
  if (h) *h = p ? p->pic.height : 0;
}

const uint8_t* bm_picture_rgba(const BmPicture* p) {
  if (!p || p->pic.rgba.empty()) return nullptr;
  return p->pic.rgba.data();
}

void bm_picture_free(BmPicture* p) { delete p; }

}  // extern "C"
