#pragma once

#include <optional>
#include "bm/doc/source.h"
#include "bmapp/model_import.h"

namespace bmapp {

struct ModelImport::Impl {
  explicit Impl(const std::string& file);
  std::optional<bm::doc::Source> source;
  std::string name, reason;
};

}  // namespace bmapp
