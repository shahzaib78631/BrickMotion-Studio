#pragma once

#include <atomic>
#include <memory>
#include <string>
#include "bmapp/bridging.h"

namespace bmapp { class FlightBake; class Session; class Viewport; }
void bmappRetainFlightBake(bmapp::FlightBake*);
void bmappReleaseFlightBake(bmapp::FlightBake*);

namespace bmapp {

struct FlightBakeResult {
  int flights = 0, keys = 0;
  std::string error;
};

/// An independent capture of the flights and source animation needed for one undoable bake.
class FlightBake {
 public:
  struct Impl;
  ~FlightBake();

  bool replacesKeys() const;
  FlightBakeResult prepare();

 private:
  friend class Session;
  friend class Viewport;
  friend void ::bmappRetainFlightBake(FlightBake*);
  friend void ::bmappReleaseFlightBake(FlightBake*);
  explicit FlightBake(std::unique_ptr<Impl>);
  std::atomic<int> refs_{1};
  std::unique_ptr<Impl> impl_;
} SWIFT_SHARED_REFERENCE(bmappRetainFlightBake, bmappReleaseFlightBake);

}  // namespace bmapp
