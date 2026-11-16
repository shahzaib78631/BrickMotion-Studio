#pragma once
// The little dense linear algebra the kinematics needs.
#include <cstddef>
#include <vector>

namespace bm::kin {

/// A dense matrix, row-major.
struct Matrix {
  size_t rows = 0, cols = 0;
  std::vector<double> v;
  Matrix() = default;
  Matrix(size_t r, size_t c) : rows(r), cols(c), v(r * c, 0.0) {}
  double& at(size_t r, size_t c) { return v[r * cols + c]; }
  double at(size_t r, size_t c) const { return v[r * cols + c]; }
};

/// An orthonormal basis of the null space of `m`, as columns (m.cols rows). By Householder QR
/// with column pivoting: a column whose remaining length is under `tol` times the longest
/// column of `m` adds nothing to the rank. A matrix with no rows, or all zero, has the whole
/// space as its null space. `rank`, if given, receives the rank found.
Matrix nullSpace(const Matrix& m, double tol, size_t* rank = nullptr);

/// The shortest x that satisfies the independent equations of m x = b (found with the same
/// pivoting; an equation that depends on the ones already taken is left out, so repeated
/// equations do no harm). Directions `m` does not determine are left at zero.
std::vector<double> solveLeastNorm(const Matrix& m, const std::vector<double>& b, double tol);

/// Brings the rows of `m` to reduced row echelon form with complete pivoting, so that each
/// row has an entry no other row shares. Entries under `tol` are treated as zero. Returns
/// the pivot column of each row (rows that reduce to zero are removed).
std::vector<size_t> reduceRows(Matrix& m, double tol);

}  // namespace bm::kin
