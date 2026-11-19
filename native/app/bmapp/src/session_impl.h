#pragma once
// What a Session holds. Engine types live here, never in a header Swift reads.
#include <filesystem>
#include <memory>
#include <string>
#include <unordered_map>
#include "bm/doc/source.h"
#include "bm/ldraw/library.h"
#include "bm/ldraw/part_cache.h"
#include "bm/model.h"
#include "bmapp/session.h"
#include "commands.h"

namespace bmapp {

struct Session::Impl {
  std::filesystem::path file;
  std::string ldraw;
  bool imported = true;
  std::unique_ptr<bm::ldraw::Library> library;
  std::unique_ptr<bm::ldraw::PartCache> full, low;  ///< low: lowResPrimitives, for the renderer's far detail

  /// The document as its file holds it; every edit changes this.
  bm::doc::Source source;
  /// The flat model the planner and renderer read. One object for the session's life (the
  /// renderer keeps a reference): a structural edit assigns a new flattening into it.
  std::unique_ptr<bm::Model> model;
  std::vector<bm::doc::PieceRef> refs;                     ///< which items made each piece
  std::unordered_map<bm::doc::ItemId, bm::Xform> local;    ///< each placed item's placement in its def
  std::unordered_map<bm::doc::ItemId, bm::Box> body;       ///< and its box, for the grid rule
  std::unordered_map<bm::doc::ItemId, std::vector<uint32_t>> piecesOf;  ///< the pieces under each item
  std::unordered_map<std::string, uint32_t> useCount;      ///< pieces under each use, by its chain
  History history;
  uint64_t version = 0;
};

}  // namespace bmapp
