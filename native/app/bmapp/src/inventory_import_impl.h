#pragma once
#include <memory>
#include "bm/model.h"
#include "bmapp/inventory_import.h"
#include "session_impl.h"

namespace bmapp {

struct InventoryPart {
  std::string name;
  int color;
  bm::Vec3 position;
};

struct InventoryImport::Impl {
  std::shared_ptr<Session::Impl> backing;
  bm::Model model;
  uint64_t generation, version;
  std::vector<std::string> focus;
  int step;
  std::vector<InventoryPart> parts;
  InventoryReport report;
  bool prepared = false;

  Impl(std::shared_ptr<Session::Impl> snapshot, int target)
      : backing(std::move(snapshot)), model(*backing->model), generation(backing->generation),
        version(backing->version), focus(backing->focus), step(target) {}
};

}  // namespace bmapp
