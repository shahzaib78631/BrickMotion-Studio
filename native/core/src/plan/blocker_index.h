#pragma once
// Reverse dependencies for failed extraction attempts. A piece is retried when an
// obstacle it named disappears, without scanning every other piece on every move.
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace bm::plan {

class BlockerIndex {
 public:
  explicit BlockerIndex(size_t pieceCount) : waits_(pieceCount), revision_(pieceCount, 0) {}

  // Called after a piece's extraction was actually recomputed. Stale subscriptions
  // are invalidated by generation, so updates never touch a concurrently read row.
  void updated(uint32_t piece, const std::vector<uint32_t>& stoppedBy, bool succeeded) {
    const uint32_t version = ++revision_[piece];
    if (succeeded) return;
    for (uint32_t blocker : stoppedBy) {
      if (blocker >= waits_.size()) continue;
      auto& row = waits_[blocker];
      row.push_back({piece, version});
      // Repeated retries can leave stale generations behind. Compact only at
      // powers of two, keeping maintenance amortized rather than per-insert.
      if (row.size() >= 256 && (row.size() & (row.size() - 1)) == 0)
        row.erase(std::remove_if(row.begin(), row.end(), [&](const Entry& e) { return revision_[e.piece] != e.revision; }), row.end());
    }
  }

  template <class F>
  void blockerRemoved(uint32_t blocker, F&& affected) const {
    if (blocker >= waits_.size()) return;
    for (const Entry& e : waits_[blocker])
      if (revision_[e.piece] == e.revision) affected(e.piece);
  }

 private:
  struct Entry { uint32_t piece, revision; };
  std::vector<std::vector<Entry>> waits_;
  std::vector<uint32_t> revision_;
};

}  // namespace bm::plan
