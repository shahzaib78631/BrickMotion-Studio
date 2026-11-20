#pragma once

#include <atomic>
#include <memory>
#include <string>
#include "bmapp/bridging.h"

namespace bmapp { class ModelImport; }
void bmappRetainModelImport(bmapp::ModelImport*);
void bmappReleaseModelImport(bmapp::ModelImport*);

namespace bmapp {

/// Parses the source file once, independently of the destination document. After read returns,
/// the source is immutable and can be passed from a worker to the document's owning thread.
class ModelImport {
 public:
  static ModelImport* read(const std::string& file) SWIFT_RETURNS_RETAINED;
  ~ModelImport();
  std::string error() const;

 private:
  friend class Session;
  friend void ::bmappRetainModelImport(bmapp::ModelImport*);
  friend void ::bmappReleaseModelImport(bmapp::ModelImport*);
  struct Impl;
  explicit ModelImport(const std::string& file);
  std::atomic<int> refs_{1};
  std::unique_ptr<const Impl> impl_;
} SWIFT_SHARED_REFERENCE(bmappRetainModelImport, bmappReleaseModelImport);

}  // namespace bmapp
