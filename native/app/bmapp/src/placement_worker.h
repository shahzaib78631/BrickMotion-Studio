#pragma once

#include "bmapp/viewport.h"
#include "bmr/camera.h"
#include "placement_solver.h"

namespace bmapp {

/// One editor window's placement worker. Results are claimed on the caller's thread.
class PlacementWorker {
 public:
  struct ModelRevision {
    /// The library and part caches are shared with the document and are thread-safe.
    std::shared_ptr<const Session::Impl> backing;
    bm::Model model;
    uint64_t generation, version;
  };

  struct Move {
    std::vector<MovingPiece> pieces;
    PieceList indices;
  };

  struct Request {
    uint64_t number;
    std::shared_ptr<const ModelRevision> scene;
    PlacementInput input;
    bmr::Camera camera;
    Vec2 point, view;
    double floor;
    bm::Box sceneBounds;
    PieceList hidden;
    std::optional<ConnectorSite> retained;
    std::shared_ptr<const Move> move;
  };

  struct Result {
    PlacementPreview preview;
    std::optional<ConnectorSite> site;
  };

  PlacementWorker();
  ~PlacementWorker();
  void submit(Request request);
  std::optional<Result> take();
  void clearPending();

 private:
  struct State;
  std::shared_ptr<State> state_;
};

}  // namespace bmapp
