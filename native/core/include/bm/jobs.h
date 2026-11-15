#pragma once
// A thread pool for data-parallel loops. Planning work fans out through this.
#include <atomic>
#include <cstddef>
#include <functional>
#include <memory>

namespace bm {

/// Asks a running parallelFor to stop. Safe to call from any thread.
class CancelToken {
 public:
  void cancel() { cancelled_.store(true, std::memory_order_relaxed); }
  bool cancelled() const { return cancelled_.load(std::memory_order_relaxed); }

 private:
  std::atomic<bool> cancelled_{false};
};

class JobPool {
 public:
  /// `threads` counts the calling thread too: a pool of 1 starts no threads and runs every
  /// loop on the caller, in index order. 0 means one per hardware thread.
  explicit JobPool(unsigned threads = 0);
  ~JobPool();
  JobPool(const JobPool&) = delete;
  JobPool& operator=(const JobPool&) = delete;

  unsigned threads() const;

  /// Calls fn(i) once for each i in [0, n), on the pool's threads and the caller, and
  /// returns when all calls have finished.
  ///
  /// - If a call throws, no further indices are handed out and the first exception is
  ///   rethrown here once the calls already running have finished.
  /// - Once `token` is cancelled no further indices are handed out; the return is normal.
  /// - `progress(done, n)` is called on the calling thread, from time to time and once at
  ///   the end.
  /// - Called from inside a job, the loop runs on that thread alone, so nesting cannot
  ///   deadlock.
  void parallelFor(size_t n, const std::function<void(size_t)>& fn, const CancelToken* token = nullptr,
                   const std::function<void(size_t, size_t)>& progress = {});

  /// The process-wide pool, one thread per hardware thread.
  static JobPool& shared();

 private:
  struct State;
  std::unique_ptr<State> state_;
};

}  // namespace bm
