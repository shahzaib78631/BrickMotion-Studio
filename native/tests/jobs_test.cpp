#include <catch2/catch_test_macros.hpp>
#include <atomic>
#include <numeric>
#include <stdexcept>
#include <vector>
#include "bm/jobs.h"

using namespace bm;

TEST_CASE("parallelFor visits every index exactly once", "[jobs]") {
  JobPool pool(4);
  REQUIRE(pool.threads() == 4);
  const size_t n = 1'000'000;
  std::vector<uint32_t> slots(n, 0);
  pool.parallelFor(n, [&](size_t i) { slots[i] += static_cast<uint32_t>(i + 1); });
  const uint64_t sum = std::accumulate(slots.begin(), slots.end(), uint64_t{0});
  REQUIRE(sum == uint64_t{n} * (n + 1) / 2);
}

TEST_CASE("an exception is rethrown after the running calls finish", "[jobs]") {
  JobPool pool(4);
  std::atomic<int> ran{0};
  REQUIRE_THROWS_AS(pool.parallelFor(1000, [&](size_t i) {
    ran++;
    if (i == 7) throw std::runtime_error("seven");
  }), std::runtime_error);
  REQUIRE(ran.load() >= 1);
  // The pool is still usable.
  std::atomic<int> again{0};
  pool.parallelFor(100, [&](size_t) { again++; });
  REQUIRE(again.load() == 100);
}

TEST_CASE("cancelling stops handing out work", "[jobs]") {
  JobPool pool(4);
  CancelToken token;
  std::atomic<int> ran{0};
  pool.parallelFor(10'000, [&](size_t i) {
    ran++;
    if (i == 10) token.cancel();
  }, &token);
  REQUIRE(token.cancelled());
  REQUIRE(ran.load() < 10'000);
  std::atomic<int> none{0};
  pool.parallelFor(100, [&](size_t) { none++; }, &token);  // already cancelled
  REQUIRE(none.load() == 0);
}

TEST_CASE("a nested parallelFor completes", "[jobs]") {
  JobPool pool(4);
  std::atomic<int> total{0};
  pool.parallelFor(8, [&](size_t) { pool.parallelFor(100, [&](size_t) { total++; }); });
  REQUIRE(total.load() == 800);
}

TEST_CASE("a one-thread pool runs in index order", "[jobs]") {
  JobPool pool(1);
  std::vector<size_t> order;
  pool.parallelFor(50, [&](size_t i) { order.push_back(i); });
  std::vector<size_t> expected(50);
  std::iota(expected.begin(), expected.end(), size_t{0});
  REQUIRE(order == expected);
}

TEST_CASE("progress reaches the total, on the calling thread", "[jobs]") {
  JobPool pool(4);
  const auto caller = std::this_thread::get_id();
  size_t last = 0;
  bool sameThread = true, monotonic = true;
  pool.parallelFor(500, [](size_t) {}, nullptr, [&](size_t done, size_t total) {
    sameThread = sameThread && std::this_thread::get_id() == caller;
    monotonic = monotonic && done >= last && total == 500;
    last = done;
  });
  REQUIRE(sameThread);
  REQUIRE(monotonic);
  REQUIRE(last == 500);
}

TEST_CASE("zero items and the shared pool", "[jobs]") {
  JobPool::shared().parallelFor(0, [](size_t) { FAIL("no work to do"); });
  REQUIRE(JobPool::shared().threads() >= 1);
  REQUIRE(&JobPool::shared() == &JobPool::shared());
}
