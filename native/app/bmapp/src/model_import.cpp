#include "model_import_impl.h"

#include <filesystem>

namespace bmapp {

ModelImport::Impl::Impl(const std::string& file) {
  try {
    const std::filesystem::path path(file);
    source = bm::doc::fromFile(path);
    name = path.stem().string();
  } catch (const std::exception& e) {
    reason = e.what();
  }
}

ModelImport::ModelImport(const std::string& file) : impl_(std::make_unique<const Impl>(file)) {}
ModelImport::~ModelImport() = default;
ModelImport* ModelImport::read(const std::string& file) { return new ModelImport(file); }
std::string ModelImport::error() const { return impl_->reason; }

}  // namespace bmapp

void bmappRetainModelImport(bmapp::ModelImport* p) { p->refs_.fetch_add(1, std::memory_order_relaxed); }
void bmappReleaseModelImport(bmapp::ModelImport* p) {
  if (p->refs_.fetch_sub(1, std::memory_order_acq_rel) == 1) delete p;
}
