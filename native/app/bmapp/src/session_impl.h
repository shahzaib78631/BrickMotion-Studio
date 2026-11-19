#pragma once
// What a Session holds. Engine types live here, never in a header Swift reads.
#include <filesystem>
#include <memory>
#include <string>
#include "bm/ldraw/library.h"
#include "bm/ldraw/part_cache.h"
#include "bm/model.h"
#include "bmapp/session.h"

namespace bmapp {

struct Session::Impl {
  std::filesystem::path file;
  std::string ldraw;
  bool imported = true;
  std::unique_ptr<bm::ldraw::Library> library;
  std::unique_ptr<bm::ldraw::PartCache> full, low;  ///< low: lowResPrimitives, for the renderer's far detail
  std::unique_ptr<bm::Model> model;
};

}  // namespace bmapp
