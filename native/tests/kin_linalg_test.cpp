#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <cmath>
#include "bm/kin/linalg.h"

using namespace bm::kin;
using Catch::Matchers::WithinAbs;

namespace {
Matrix make(size_t rows, size_t cols, std::initializer_list<double> values) {
  Matrix m(rows, cols);
  m.v.assign(values.begin(), values.end());
  return m;
}
double residual(const Matrix& m, const Matrix& basis, size_t column) {
  double worst = 0;
  for (size_t r = 0; r < m.rows; r++) {
    double s = 0;
    for (size_t c = 0; c < m.cols; c++) s += m.at(r, c) * basis.at(c, column);
    worst = std::max(worst, std::abs(s));
  }
  return worst;
}
}  // namespace

TEST_CASE("the null space of a rank-deficient matrix", "[kin][linalg]") {
  // Row 3 = row 1 + row 2: rank 2, one null direction, (1, -2, 1).
  const Matrix m = make(3, 3, {1, 2, 3, 4, 5, 6, 5, 7, 9});
  size_t rank = 0;
  const Matrix null = nullSpace(m, 1e-9, &rank);
  REQUIRE(rank == 2);
  REQUIRE((null.rows == 3 && null.cols == 1));
  REQUIRE(residual(m, null, 0) < 1e-12);
  REQUIRE_THAT(null.at(1, 0) / null.at(0, 0), WithinAbs(-2, 1e-9));
  REQUIRE_THAT(null.at(0, 0) * null.at(0, 0) + null.at(1, 0) * null.at(1, 0) + null.at(2, 0) * null.at(2, 0), WithinAbs(1, 1e-12));
}

TEST_CASE("null spaces at the edges: full rank, all zero, no rows, wide", "[kin][linalg]") {
  REQUIRE(nullSpace(make(3, 3, {2, 0, 0, 0, 3, 0, 0, 0, 4}), 1e-9).cols == 0);
  const Matrix zero = nullSpace(Matrix(2, 3), 1e-9);
  REQUIRE(zero.cols == 3);
  for (size_t c = 0; c < 3; c++) REQUIRE_THAT(zero.at(c, c), WithinAbs(1, 1e-12));
  REQUIRE(nullSpace(Matrix(0, 4), 1e-9).cols == 4);
  REQUIRE(nullSpace(Matrix(0, 0), 1e-9).cols == 0);
  // One equation in three unknowns: a plane, with orthonormal columns.
  const Matrix m = make(1, 3, {1, 1, 1});
  const Matrix plane = nullSpace(m, 1e-9);
  REQUIRE(plane.cols == 2);
  REQUIRE(residual(m, plane, 0) < 1e-12);
  REQUIRE(residual(m, plane, 1) < 1e-12);
  double d = 0;
  for (size_t r = 0; r < 3; r++) d += plane.at(r, 0) * plane.at(r, 1);
  REQUIRE_THAT(d, WithinAbs(0, 1e-12));
  // A row that is nearly a copy counts as a copy at a loose tolerance and not at a tight one.
  const Matrix near = make(2, 2, {1, 0, 1, 1e-6});
  REQUIRE(nullSpace(near, 1e-3).cols == 1);
  REQUIRE(nullSpace(near, 1e-9).cols == 0);
}

TEST_CASE("the shortest solution of an under-determined system", "[kin][linalg]") {
  // x + y + z = 3: the shortest solution is (1, 1, 1).
  const std::vector<double> x = solveLeastNorm(make(1, 3, {1, 1, 1}), {3}, 1e-9);
  for (double v : x) REQUIRE_THAT(v, WithinAbs(1, 1e-12));
  // A repeated equation is no trouble.
  const std::vector<double> y = solveLeastNorm(make(3, 2, {1, 0, 1, 0, 0, 2}), {2, 2, 4}, 1e-9);
  REQUIRE_THAT(y[0], WithinAbs(2, 1e-12));
  REQUIRE_THAT(y[1], WithinAbs(2, 1e-12));
  REQUIRE(solveLeastNorm(Matrix(0, 3), {}, 1e-9) == std::vector<double>{0, 0, 0});
  REQUIRE(solveLeastNorm(Matrix(2, 2), {1, 1}, 1e-9) == std::vector<double>{0, 0});
}

TEST_CASE("row reduction gives each row an entry of its own", "[kin][linalg]") {
  Matrix m = make(2, 4, {1, 1, 0, 0, 1, -1, 0, 0});  // two mixed motions of two separate things
  const std::vector<size_t> pivots = reduceRows(m, 1e-12);
  REQUIRE(pivots.size() == 2);
  for (size_t r = 0; r < 2; r++) {
    REQUIRE_THAT(m.at(r, pivots[r]), WithinAbs(1, 1e-12));
    REQUIRE_THAT(m.at(1 - r, pivots[r]), WithinAbs(0, 1e-12));
  }
  Matrix dependent = make(2, 2, {1, 2, 2, 4});
  REQUIRE(reduceRows(dependent, 1e-12).size() == 1);
  REQUIRE(dependent.rows == 1);
}
