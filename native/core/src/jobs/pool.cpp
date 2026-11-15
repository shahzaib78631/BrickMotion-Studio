#include "bm/jobs.h"

#include <chrono>
#include <condition_variable>
#include <deque>
#include <exception>
#include <mutex>
#include <thread>
#include <vector>

namespace bm {
namespace {

/// One parallelFor in flight.
struct Batch {
  size_t n = 0;
  const std::function<void(size_t)>* fn = nullptr;
  const CancelToken* token = nullptr;
  std::atomic<size_t> next{0};
  std::atomic<size_t> done{0};
  std::atomic<bool> stop{false};
  std::mutex mutex;  // guards error, running
  std::condition_variable idle;
  std::exception_ptr error;
  int running = 0;  // pool threads currently inside work()

  bool exhausted() const { return stop.load(std::memory_order_relaxed) || next.load(std::memory_order_relaxed) >= n; }

  /// Claims and runs indices until none are left. `each` runs after every call.
  template <typename Each>
  void work(Each&& each) {
    for (;;) {
      if (stop.load(std::memory_order_relaxed) || (token && token->cancelled())) return;
      const size_t i = next.fetch_add(1, std::memory_order_relaxed);
      if (i >= n) return;
      try {
        (*fn)(i);
      } catch (...) {
        std::lock_guard lock(mutex);
        if (!error) error = std::current_exception();
        stop.store(true, std::memory_order_relaxed);
      }
      done.fetch_add(1, std::memory_order_relaxed);
      each();
    }
  }
};

thread_local bool insideJob = false;

struct InsideJob {
  bool was = insideJob;
  InsideJob() { insideJob = true; }
  ~InsideJob() { insideJob = was; }
};

}  // namespace

struct JobPool::State {
  unsigned threads = 1;
  std::mutex mutex;  // guards batches, quit
  std::condition_variable wake;
  std::deque<std::shared_ptr<Batch>> batches;
  bool quit = false;
  std::vector<std::thread> workers;

  void workerLoop() {
    for (;;) {
      std::shared_ptr<Batch> batch;
      {
        std::unique_lock lock(mutex);
        wake.wait(lock, [&] {
          while (!batches.empty() && batches.front()->exhausted()) batches.pop_front();
          return quit || !batches.empty();
        });
        if (batches.empty()) return;  // quit
        batch = batches.front();
        // Counted while the pool lock is held, so the caller cannot miss this worker.
        std::lock_guard count(batch->mutex);
        batch->running++;
      }
      {
        InsideJob scope;
        batch->work([] {});
      }
      {
        std::lock_guard count(batch->mutex);
        batch->running--;
      }
      batch->idle.notify_all();
    }
  }
};

JobPool::JobPool(unsigned threads) : state_(std::make_unique<State>()) {
  if (threads == 0) threads = std::max(1u, std::thread::hardware_concurrency());
  state_->threads = threads;
  for (unsigned i = 1; i < threads; i++) state_->workers.emplace_back([s = state_.get()] { s->workerLoop(); });
}

JobPool::~JobPool() {
  {
    std::lock_guard lock(state_->mutex);
    state_->quit = true;
    state_->batches.clear();
  }
  state_->wake.notify_all();
  for (std::thread& t : state_->workers) t.join();
}

unsigned JobPool::threads() const { return state_->threads; }

void JobPool::parallelFor(size_t n, const std::function<void(size_t)>& fn, const CancelToken* token, const std::function<void(size_t, size_t)>& progress) {
  auto batch = std::make_shared<Batch>();
  batch->n = n;
  batch->fn = &fn;
  batch->token = token;
  auto report = [&] {
    if (progress) progress(batch->done.load(std::memory_order_relaxed), n);
  };

  const bool spread = n > 1 && !insideJob && !state_->workers.empty();
  if (spread) {
    {
      std::lock_guard lock(state_->mutex);
      state_->batches.push_back(batch);
    }
    state_->wake.notify_all();
  }
  {
    InsideJob scope;
    auto last = std::chrono::steady_clock::now();
    batch->work([&] {
      // Progress is throttled so a loop of tiny jobs is not dominated by it.
      const auto now = std::chrono::steady_clock::now();
      if (progress && now - last >= std::chrono::milliseconds(50)) {
        last = now;
        report();
      }
    });
  }
  if (spread) {
    {
      std::lock_guard lock(state_->mutex);
      std::erase(state_->batches, batch);
    }
    std::unique_lock lock(batch->mutex);
    while (batch->running > 0) {
      if (batch->idle.wait_for(lock, std::chrono::milliseconds(50)) == std::cv_status::timeout && progress) {
        lock.unlock();
        report();
        lock.lock();
      }
    }
  }
  report();
  if (batch->error) std::rethrow_exception(batch->error);
}

JobPool& JobPool::shared() {
  static JobPool pool(0);
  return pool;
}

}  // namespace bm
