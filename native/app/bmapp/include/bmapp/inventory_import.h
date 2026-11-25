#pragma once

#include <atomic>
#include <memory>
#include <string>
#include <vector>
#include "bmapp/bridging.h"

namespace bmapp { class InventoryImport; class Session; }
void bmappRetainInventoryImport(bmapp::InventoryImport*);
void bmappReleaseInventoryImport(bmapp::InventoryImport*);

namespace bmapp {

struct InventoryReport {
  std::string error;
  std::vector<std::string> missing;
  size_t pieces = 0, spares = 0, invalidRows = 0;
};

/// Captures the destination on the document thread. A worker reads the inventory and
/// lays out the pieces using that captured geometry. Commit on the document thread.
class InventoryImport {
 public:
  static InventoryImport* capture(const Session* session, int step) SWIFT_RETURNS_RETAINED;
  ~InventoryImport();
  InventoryReport prepare(const std::string& file);

 private:
  friend class Session;
  friend void ::bmappRetainInventoryImport(bmapp::InventoryImport*);
  friend void ::bmappReleaseInventoryImport(bmapp::InventoryImport*);
  struct Impl;
  explicit InventoryImport(std::unique_ptr<Impl> impl);
  std::atomic<int> refs_{1};
  std::unique_ptr<Impl> impl_;
} SWIFT_SHARED_REFERENCE(bmappRetainInventoryImport, bmappReleaseInventoryImport);

}  // namespace bmapp
