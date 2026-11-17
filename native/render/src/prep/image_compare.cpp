#include <algorithm>
#include <cstdlib>
#include "bmr/image.h"
#include "bmr/tolerances.h"

namespace bmr {

Difference compare(const Image& a, const Image& b) {
  Difference out;
  if (a.empty() && b.empty()) return out;
  if (a.empty() || b.empty() || a.width != b.width || a.height != b.height) {
    out.sameSize = false;
    return out;
  }
  double total = 0;
  for (int by = 0; by < a.height; by += kBlock)
    for (int bx = 0; bx < a.width; bx += kBlock) {
      double sum = 0;
      const int y1 = std::min(a.height, by + kBlock), x1 = std::min(a.width, bx + kBlock);
      for (int y = by; y < y1; y++) {
        const uint8_t *pa = a.at(bx, y), *pb = b.at(bx, y);
        for (int i = 0; i < (x1 - bx) * 4; i++) sum += std::abs(static_cast<int>(pa[i]) - static_cast<int>(pb[i]));
      }
      total += sum;
      out.worstBlock = std::max(out.worstBlock, sum / (static_cast<double>(y1 - by) * (x1 - bx) * 4));
    }
  out.meanAbs = total / (static_cast<double>(a.width) * a.height * 4);
  return out;
}

}  // namespace bmr
