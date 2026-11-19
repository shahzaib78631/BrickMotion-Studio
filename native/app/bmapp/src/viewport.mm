#include "bmapp/viewport.h"

#include "bmr/device.h"
#include "session_impl.h"

namespace bmapp {

struct Viewport::Impl {
  Session* session = nullptr;
  bool owned = false;  ///< made by create(): holds a reference to the session
  bool ok = false;
};

Viewport* Viewport::create(Session* session) {
  auto* v = new Viewport(*session);
  ::bmappRetainSession(session);
  v->impl_->owned = true;
  return v;
}


Viewport::Viewport(Session& session) : impl_(std::make_unique<Impl>()) {
  impl_->session = &session;
  impl_->ok = session.impl().model && bmr::gpuAvailable();
}
Viewport::~Viewport() {
  if (impl_->owned) ::bmappReleaseSession(impl_->session);
}

bool Viewport::ok() const { return impl_->ok; }
uintptr_t Viewport::sessionAddress() const { return reinterpret_cast<uintptr_t>(impl_->session); }

}  // namespace bmapp

void bmappRetainViewport(bmapp::Viewport* v) { v->refs_.fetch_add(1, std::memory_order_relaxed); }
void bmappReleaseViewport(bmapp::Viewport* v) {
  if (v->refs_.fetch_sub(1, std::memory_order_acq_rel) == 1) delete v;
}
