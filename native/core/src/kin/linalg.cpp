#include "bm/kin/linalg.h"

#include <algorithm>
#include <cmath>
#include <numeric>

namespace bm::kin {
namespace {

/// A = Q R P^T in place: on return the upper triangle of `a` holds R, `perm[k]` is the
/// original column now at k, and `rank` is the number of pivots kept. If `rhs` is given it is
/// replaced by Q^T rhs.
void pivotedQr(Matrix& a, double tol, std::vector<size_t>& perm, size_t& rank, std::vector<double>* rhs) {
  const size_t m = a.rows, n = a.cols;
  perm.resize(n);
  std::iota(perm.begin(), perm.end(), size_t{0});
  rank = 0;
  double longest = 0;
  for (size_t c = 0; c < n; c++) {
    double s = 0;
    for (size_t r = 0; r < m; r++) s += a.at(r, c) * a.at(r, c);
    longest = std::max(longest, std::sqrt(s));
  }
  if (longest == 0 || !std::isfinite(longest)) return;
  std::vector<double> w(m);
  for (size_t k = 0; k < std::min(m, n); k++) {
    // The longest remaining column goes next.
    size_t best = k;
    double bestNorm = -1;
    for (size_t c = k; c < n; c++) {
      double s = 0;
      for (size_t r = k; r < m; r++) s += a.at(r, c) * a.at(r, c);
      if (s > bestNorm) bestNorm = s, best = c;
    }
    bestNorm = std::sqrt(std::max(0.0, bestNorm));
    if (bestNorm <= tol * longest) break;
    if (best != k) {
      for (size_t r = 0; r < m; r++) std::swap(a.at(r, k), a.at(r, best));
      std::swap(perm[k], perm[best]);
    }
    // Householder: reflect column k onto the k-th axis.
    const double alpha = a.at(k, k) > 0 ? -bestNorm : bestNorm;
    for (size_t r = k; r < m; r++) w[r] = a.at(r, k);
    w[k] -= alpha;
    double ww = 0;
    for (size_t r = k; r < m; r++) ww += w[r] * w[r];
    if (ww > 0) {
      for (size_t c = k; c < n; c++) {
        double d = 0;
        for (size_t r = k; r < m; r++) d += w[r] * a.at(r, c);
        d *= 2 / ww;
        if (d != 0)
          for (size_t r = k; r < m; r++) a.at(r, c) -= d * w[r];
      }
      if (rhs) {
        double d = 0;
        for (size_t r = k; r < m; r++) d += w[r] * (*rhs)[r];
        d *= 2 / ww;
        for (size_t r = k; r < m; r++) (*rhs)[r] -= d * w[r];
      }
    }
    a.at(k, k) = alpha;
    for (size_t r = k + 1; r < m; r++) a.at(r, k) = 0;
    rank = k + 1;
  }
}

}  // namespace

Matrix nullSpace(const Matrix& m, double tol, size_t* rankOut) {
  const size_t n = m.cols;
  Matrix a = m;
  std::vector<size_t> perm;
  size_t rank = 0;
  pivotedQr(a, tol, perm, rank, nullptr);
  if (rankOut) *rankOut = rank;
  const size_t k = n - rank;
  Matrix out(n, k);
  if (k == 0) return out;
  // In the pivoted order the null space is [-R11^-1 R12; I].
  for (size_t j = 0; j < k; j++) {
    std::vector<double> x(rank);
    for (size_t i = rank; i-- > 0;) {
      double s = -a.at(i, rank + j);
      for (size_t c = i + 1; c < rank; c++) s -= a.at(i, c) * x[c];
      x[i] = s / a.at(i, i);
    }
    for (size_t i = 0; i < rank; i++) out.at(perm[i], j) = x[i];
    out.at(perm[rank + j], j) = 1;
  }
  // Orthonormal columns (Gram-Schmidt, twice for accuracy).
  for (size_t j = 0; j < k; j++) {
    for (int pass = 0; pass < 2; pass++)
      for (size_t i = 0; i < j; i++) {
        double d = 0;
        for (size_t r = 0; r < n; r++) d += out.at(r, i) * out.at(r, j);
        for (size_t r = 0; r < n; r++) out.at(r, j) -= d * out.at(r, i);
      }
    double s = 0;
    for (size_t r = 0; r < n; r++) s += out.at(r, j) * out.at(r, j);
    s = std::sqrt(s);
    for (size_t r = 0; r < n; r++) out.at(r, j) /= s;
  }
  return out;
}

std::vector<double> solveLeastNorm(const Matrix& m, const std::vector<double>& b, double tol) {
  // Least norm: x = A^T y with (A A^T) y = b in the least-squares sense. Factorise A^T
  // instead: A^T = Q R P^T, so A = P R^T Q^T and x = Q R^-T (P^T b) over the kept pivots.
  const size_t rows = m.rows, n = m.cols;
  std::vector<double> x(n, 0.0);
  if (rows == 0 || n == 0 || b.size() != rows) return x;
  Matrix t(n, rows);
  for (size_t r = 0; r < rows; r++)
    for (size_t c = 0; c < n; c++) t.at(c, r) = m.at(r, c);
  // First learn which equations are independent (the pivot order), then factorise those
  // again with an identity alongside, which leaves Q^T there.
  Matrix a = t;
  std::vector<size_t> perm;
  size_t rank = 0;
  pivotedQr(a, tol, perm, rank, nullptr);
  if (rank == 0) return x;
  Matrix ordered(n, rank + n);
  for (size_t r = 0; r < n; r++) {
    for (size_t c = 0; c < rank; c++) ordered.at(r, c) = t.at(r, perm[c]);
    ordered.at(r, rank + r) = 1;
  }
  // Householder on the first `rank` columns, applied to all columns: the right block becomes Q^T.
  std::vector<double> w(n);
  for (size_t k = 0; k < rank; k++) {
    double norm = 0;
    for (size_t r = k; r < n; r++) norm += ordered.at(r, k) * ordered.at(r, k);
    norm = std::sqrt(norm);
    const double alpha = ordered.at(k, k) > 0 ? -norm : norm;
    for (size_t r = k; r < n; r++) w[r] = ordered.at(r, k);
    w[k] -= alpha;
    double ww = 0;
    for (size_t r = k; r < n; r++) ww += w[r] * w[r];
    if (ww == 0) continue;
    for (size_t c = k; c < rank + n; c++) {
      double d = 0;
      for (size_t r = k; r < n; r++) d += w[r] * ordered.at(r, c);
      d *= 2 / ww;
      if (d != 0)
        for (size_t r = k; r < n; r++) ordered.at(r, c) -= d * w[r];
    }
  }
  // R^T z = P^T b (forward substitution over the kept pivots), then x = Q z.
  std::vector<double> z(rank);
  for (size_t i = 0; i < rank; i++) {
    double s = b[perm[i]];
    for (size_t c = 0; c < i; c++) s -= ordered.at(c, i) * z[c];
    z[i] = s / ordered.at(i, i);
  }
  for (size_t r = 0; r < n; r++) {
    double s = 0;
    for (size_t i = 0; i < rank; i++) s += ordered.at(i, rank + r) * z[i];  // Q(r, i) = Q^T(i, r)
    x[r] = s;
  }
  return x;
}

std::vector<size_t> reduceRows(Matrix& m, double tol) {
  std::vector<size_t> pivots;
  size_t done = 0;
  while (done < m.rows) {
    size_t br = done, bc = 0;
    double best = 0;
    for (size_t r = done; r < m.rows; r++)
      for (size_t c = 0; c < m.cols; c++)
        if (std::abs(m.at(r, c)) > best) best = std::abs(m.at(r, c)), br = r, bc = c;
    if (best <= tol) break;
    if (br != done)
      for (size_t c = 0; c < m.cols; c++) std::swap(m.at(br, c), m.at(done, c));
    const double p = m.at(done, bc);
    for (size_t c = 0; c < m.cols; c++) m.at(done, c) /= p;
    for (size_t r = 0; r < m.rows; r++) {
      if (r == done) continue;
      const double f = m.at(r, bc);
      if (f == 0) continue;
      for (size_t c = 0; c < m.cols; c++) m.at(r, c) -= f * m.at(done, c);
      m.at(r, bc) = 0;
    }
    pivots.push_back(bc);
    done++;
  }
  m.rows = done;
  m.v.resize(done * m.cols);
  for (double& x : m.v)
    if (std::abs(x) <= tol) x = 0;
  return pivots;
}

}  // namespace bm::kin
