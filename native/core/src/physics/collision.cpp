#include "bm/physics/collision.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <numeric>
#include <unordered_set>
#include "bm/physics/constants.h"

namespace bm::physics {
namespace {

constexpr double kContactMargin = 5e-5;  ///< 0.05 mm narrowphase contact touch margin

inline bool boxesOverlap(const Box& a, const Box& b) {
  return a.min.x <= b.max.x && a.max.x >= b.min.x &&
         a.min.y <= b.max.y && a.max.y >= b.min.y &&
         a.min.z <= b.max.z && a.max.z >= b.min.z;
}

inline bool boxContains(const Box& outer, const Box& inner) {
  return outer.min.x <= inner.min.x && outer.max.x >= inner.max.x &&
         outer.min.y <= inner.min.y && outer.max.y >= inner.max.y &&
         outer.min.z <= inner.min.z && outer.max.z >= inner.max.z;
}

inline double boxSurfaceArea(const Box& b) {
  const Vec3 d = b.max - b.min;
  return 2.0 * (d.x * d.y + d.y * d.z + d.z * d.x);
}

inline Box boxUnion(const Box& a, const Box& b) {
  return {{std::min(a.min.x, b.min.x), std::min(a.min.y, b.min.y), std::min(a.min.z, b.min.z)},
          {std::max(a.max.x, b.max.x), std::max(a.max.y, b.max.y), std::max(a.max.z, b.max.z)}};
}

// ---- 3D Incremental Convex Hull (Quickhull with coplanar face merging) ----

struct TriFace {
  uint32_t v[3] = {};
  Vec3 normal{};
  double offset = 0.0;
  bool alive = true;
};

bool makeTriFace(const std::vector<Vec3>& pts, uint32_t a, uint32_t b, uint32_t c, Vec3 interior, TriFace& out) {
  const Vec3 ab = pts[b] - pts[a];
  const Vec3 ac = pts[c] - pts[a];
  Vec3 n = cross(ab, ac);
  const double len = length(n);
  if (len <= 1e-14) return false;
  n = n * (1.0 / len);
  if (dot(n, interior - pts[a]) > 0.0) {
    std::swap(b, c);
    n = -n;
  }
  out.v[0] = a;
  out.v[1] = b;
  out.v[2] = c;
  out.normal = n;
  out.offset = dot(n, pts[a]);
  out.alive = true;
  return true;
}

/// Merge coplanar triangular faces into convex polygon HullFaces with ordered CCW vertices.
std::vector<HullFace> mergeCoplanarFaces(const std::vector<Vec3>& verts, const std::vector<TriFace>& tris) {
  std::vector<TriFace> live;
  live.reserve(tris.size());
  for (const auto& t : tris)
    if (t.alive) live.push_back(t);

  std::vector<uint8_t> used(live.size(), 0);
  std::vector<HullFace> result;

  for (size_t i = 0; i < live.size(); i++) {
    if (used[i]) continue;
    used[i] = 1;
    const Vec3 refN = live[i].normal;
    const double refD = live[i].offset;

    std::vector<uint32_t> groupVerts;
    std::unordered_set<uint32_t> seen;
    auto addTri = [&](const TriFace& t) {
      for (uint32_t vi : t.v)
        if (seen.insert(vi).second) groupVerts.push_back(vi);
    };
    addTri(live[i]);

    for (size_t j = i + 1; j < live.size(); j++) {
      if (used[j]) continue;
      if (dot(live[j].normal, refN) > 0.9998 && std::abs(live[j].offset - refD) < 1e-5) {
        used[j] = 1;
        addTri(live[j]);
      }
    }

    // Order group vertices CCW around refN in the face's 2D plane, keeping only convex boundary vertices.
    Vec3 center{};
    for (uint32_t vi : groupVerts) center = center + verts[vi];
    center = center * (1.0 / static_cast<double>(groupVerts.size()));

    Vec3 u, v;
    orthonormalBasis(refN, u, v);
    struct P2 {
      double x, y;
      uint32_t id;
    };
    std::vector<P2> p2;
    p2.reserve(groupVerts.size());
    for (uint32_t vi : groupVerts) {
      const Vec3 d = verts[vi] - center;
      p2.push_back({dot(d, u), dot(d, v), vi});
    }
    // 2D Andrew monotone chain convex hull on the face plane so interior vertices on coplanar triangles vanish.
    std::sort(p2.begin(), p2.end(), [](const P2& a, const P2& b) {
      return a.x != b.x ? a.x < b.x : a.y < b.y;
    });
    auto cross2 = [](const P2& o, const P2& a, const P2& b) {
      return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    };
    std::vector<P2> hull2;
    if (p2.size() <= 3) {
      hull2 = p2;
    } else {
      hull2.resize(2 * p2.size());
      size_t k = 0;
      for (const auto& pt : p2) {
        while (k >= 2 && cross2(hull2[k - 2], hull2[k - 1], pt) <= 1e-12) k--;
        hull2[k++] = pt;
      }
      for (size_t idx = p2.size() - 1, lower = k + 1; idx-- > 0;) {
        while (k >= lower && cross2(hull2[k - 2], hull2[k - 1], p2[idx]) <= 1e-12) k--;
        hull2[k++] = p2[idx];
      }
      hull2.resize(k > 0 ? k - 1 : 0);
    }
    if (hull2.size() < 3) continue;

    // Verify CCW winding with respect to refN.
    const Vec3 e1 = verts[hull2[1].id] - verts[hull2[0].id];
    const Vec3 e2 = verts[hull2[2].id] - verts[hull2[0].id];
    if (dot(cross(e1, e2), refN) < 0.0) {
      std::reverse(hull2.begin(), hull2.end());
    }

    HullFace hf;
    hf.normal = refN;
    hf.offset = refD;
    hf.vertices.reserve(hull2.size());
    for (const auto& pt : hull2) hf.vertices.push_back(pt.id);
    result.push_back(std::move(hf));
  }
  return result;
}

// ---- Sutherland-Hodgman polygon clipping in 3D ----

std::vector<Vec3> clipPolygonAgainstPlane(const std::vector<Vec3>& poly, Vec3 planeNormal, double planeOffset) {
  if (poly.empty()) return {};
  std::vector<Vec3> out;
  out.reserve(poly.size() + 1);
  const size_t n = poly.size();
  for (size_t i = 0; i < n; i++) {
    const Vec3 a = poly[i];
    const Vec3 b = poly[(i + 1) % n];
    const double da = dot(planeNormal, a) - planeOffset;
    const double db = dot(planeNormal, b) - planeOffset;
    const bool inA = da <= 1e-7;
    const bool inB = db <= 1e-7;
    if (inA && inB) {
      out.push_back(b);
    } else if (inA && !inB) {
      const double t = da / (da - db);
      out.push_back(a + (b - a) * std::clamp(t, 0.0, 1.0));
    } else if (!inA && inB) {
      const double t = da / (da - db);
      out.push_back(a + (b - a) * std::clamp(t, 0.0, 1.0));
      out.push_back(b);
    }
  }
  return out;
}

/// Reduce a candidate contact point list to at most 4 well-spread points (deepest + max area quad).
struct CandidatePoint {
  Vec3 pointOnB;     ///< point on incident surface (world space)
  double depth = 0;  ///< penetration depth (>0)
  uint64_t featureId = 0;
};

void reduceManifoldPoints(const std::vector<CandidatePoint>& candidates, Vec3 normal,
                          const Pose& poseA, const Pose& poseB, ContactManifold& out) {
  if (candidates.empty()) return;

  auto pushPoint = [&](const CandidatePoint& cp) {
    if (out.pointCount >= ContactManifold::kMaxPoints) return;
    // Deduplicate very close points (< 0.1 mm).
    for (uint32_t i = 0; i < out.pointCount; i++) {
      if (length(out.points[i].worldPoint - cp.pointOnB) < 1e-4) return;
    }
    ContactPoint& dst = out.points[out.pointCount++];
    // Midpoint between penetrated surface on A and B.
    const Vec3 pointOnA = cp.pointOnB + normal * cp.depth;
    dst.worldPoint = (pointOnA + cp.pointOnB) * 0.5;
    dst.localA = poseA.toLocal(pointOnA);
    dst.localB = poseB.toLocal(cp.pointOnB);
    dst.penetration = std::max(0.0, cp.depth);
    dst.featureId = cp.featureId;
  };

  if (candidates.size() <= ContactManifold::kMaxPoints) {
    // For a 4-corner polygon face (e.g. flat brick-on-brick), interleave opposite diagonal corners
    // (0, 2, 1, 3) so sequential PGS pairs opposite levers and eliminates systematic edge-tilt bias!
    if (candidates.size() == 4) {
      pushPoint(candidates[0]);
      pushPoint(candidates[2]);
      pushPoint(candidates[1]);
      pushPoint(candidates[3]);
    } else {
      for (const auto& c : candidates) pushPoint(c);
    }
    return;
  }

  // 1. Deepest point.
  size_t i0 = 0;
  for (size_t i = 1; i < candidates.size(); i++)
    if (candidates[i].depth > candidates[i0].depth) i0 = i;

  // 2. Furthest from i0.
  size_t i1 = i0;
  double maxD2 = -1.0;
  for (size_t i = 0; i < candidates.size(); i++) {
    const Vec3 d = candidates[i].pointOnB - candidates[i0].pointOnB;
    const double d2 = dot(d, d);
    if (d2 > maxD2) { maxD2 = d2; i1 = i; }
  }

  // 3. Largest signed triangle area with (i0, i1).
  size_t i2 = i0;
  double maxArea = -1.0;
  for (size_t i = 0; i < candidates.size(); i++) {
    const double area = std::abs(dot(cross(candidates[i1].pointOnB - candidates[i0].pointOnB,
                                           candidates[i].pointOnB - candidates[i0].pointOnB), normal));
    if (area > maxArea) { maxArea = area; i2 = i; }
  }

  // 4. Largest area on the opposite side of the triangle to maximize quad span.
  size_t i3 = i0;
  double maxArea2 = -1.0;
  const Vec3 e01 = candidates[i1].pointOnB - candidates[i0].pointOnB;
  const Vec3 e12 = candidates[i2].pointOnB - candidates[i1].pointOnB;
  const Vec3 e20 = candidates[i0].pointOnB - candidates[i2].pointOnB;
  for (size_t i = 0; i < candidates.size(); i++) {
    if (i == i0 || i == i1 || i == i2) continue;
    const double a1 = std::abs(dot(cross(e01, candidates[i].pointOnB - candidates[i0].pointOnB), normal));
    const double a2 = std::abs(dot(cross(e12, candidates[i].pointOnB - candidates[i1].pointOnB), normal));
    const double a3 = std::abs(dot(cross(e20, candidates[i].pointOnB - candidates[i2].pointOnB), normal));
    const double score = std::max({a1, a2, a3});
    if (score > maxArea2) { maxArea2 = score; i3 = i; }
  }

  pushPoint(candidates[i0]);
  if (i1 != i0) pushPoint(candidates[i1]);
  if (i2 != i0 && i2 != i1) pushPoint(candidates[i2]);
  if (i3 != i0 && i3 != i1 && i3 != i2) pushPoint(candidates[i3]);
}

/// Build a clipped face-to-face contact manifold between two convex hulls given separating normal (A -> B).
bool buildHullManifold(const ConvexHull& hullA, const Pose& poseA,
                       const ConvexHull& hullB, const Pose& poseB,
                       Vec3 normalAB, double epaDepth, ContactManifold& out) {
  if (hullA.faces.empty() || hullB.faces.empty()) return false;

  // Find most aligned face on A (normal closest to +normalAB) and on B (normal closest to -normalAB).
  const Vec3 localDirA = poseA.dirToLocal(normalAB);
  const Vec3 localDirB = poseB.dirToLocal(-normalAB);

  size_t bestFaceA = 0;
  double bestDotA = -2.0;
  for (size_t i = 0; i < hullA.faces.size(); i++) {
    const double d = dot(hullA.faces[i].normal, localDirA);
    if (d > bestDotA) { bestDotA = d; bestFaceA = i; }
  }

  size_t bestFaceB = 0;
  double bestDotB = -2.0;
  for (size_t i = 0; i < hullB.faces.size(); i++) {
    const double d = dot(hullB.faces[i].normal, localDirB);
    if (d > bestDotB) { bestDotB = d; bestFaceB = i; }
  }

  // Choose reference face as the one better aligned with the separating normal (for flatter contact patches).
  const bool aIsRef = bestDotA >= bestDotB;
  const ConvexHull& refHull = aIsRef ? hullA : hullB;
  const Pose& refPose = aIsRef ? poseA : poseB;
  const ConvexHull& incHull = aIsRef ? hullB : hullA;
  const Pose& incPose = aIsRef ? poseB : poseA;
  const size_t refFaceIdx = aIsRef ? bestFaceA : bestFaceB;
  const size_t incFaceIdx = aIsRef ? bestFaceB : bestFaceA;
  const HullFace& refFace = refHull.faces[refFaceIdx];
  const HullFace& incFace = incHull.faces[incFaceIdx];

  const Vec3 refNormalW = refPose.dirToWorld(refFace.normal);
  std::vector<Vec3> refVertsW;
  refVertsW.reserve(refFace.vertices.size());
  for (uint32_t vi : refFace.vertices) refVertsW.push_back(refPose.toWorld(refHull.vertices[vi]));
  const double refOffsetW = dot(refNormalW, refVertsW[0]);

  std::vector<Vec3> clipPoly;
  clipPoly.reserve(incFace.vertices.size());
  for (uint32_t vi : incFace.vertices) clipPoly.push_back(incPose.toWorld(incHull.vertices[vi]));

  // Clip incident face against the side planes of the reference face.
  const size_t rn = refVertsW.size();
  for (size_t i = 0; i < rn && !clipPoly.empty(); i++) {
    const Vec3 a = refVertsW[i];
    const Vec3 b = refVertsW[(i + 1) % rn];
    const Vec3 edge = b - a;
    Vec3 sideNormal = cross(edge, refNormalW);
    const double sl = length(sideNormal);
    if (sl <= 1e-12) continue;
    sideNormal = sideNormal * (1.0 / sl);
    // Ensure sideNormal points outward from reference face.
    const Vec3 refCenter = refPose.toWorld(refHull.centroid);
    if (dot(sideNormal, a - refCenter) < 0.0) sideNormal = -sideNormal;
    clipPoly = clipPolygonAgainstPlane(clipPoly, sideNormal, dot(sideNormal, a));
  }

  std::vector<CandidatePoint> candidates;
  candidates.reserve(clipPoly.size());
  for (size_t i = 0; i < clipPoly.size(); i++) {
    const Vec3 p = clipPoly[i];
    const double dist = dot(refNormalW, p) - refOffsetW;
    if (dist <= kContactMargin) {
      const double pen = std::max(0.0, -dist);
      CandidatePoint cp;
      // Convert to point on B (when aIsRef, p is already on incident B; when bIsRef, p is on A so shift to B).
      cp.pointOnB = aIsRef ? p : (p - refNormalW * dist);
      cp.depth = pen;
      cp.featureId = (uint64_t(refFaceIdx) << 32) ^ (uint64_t(incFaceIdx) << 16) ^ uint64_t(i);
      candidates.push_back(cp);
    }
  }

  if (candidates.empty()) {
    // Edge-edge or point-face contact fallback using support points along normalAB.
    const Vec3 supA = poseA.toWorld(hullA.support(poseA.dirToLocal(normalAB)));
    const Vec3 supB = poseB.toWorld(hullB.support(poseB.dirToLocal(-normalAB)));
    ContactPoint& cp = out.points[0];
    cp.worldPoint = (supA + supB) * 0.5;
    cp.localA = poseA.toLocal(supA);
    cp.localB = poseB.toLocal(supB);
    cp.penetration = std::max(0.0, epaDepth);
    cp.featureId = (uint64_t(bestFaceA) << 32) | uint64_t(bestFaceB);
    out.pointCount = 1;
    out.normal = normalAB;
    return true;
  }

  // Use the reference face normal if well-aligned with EPA normal (eliminates faceted jitter on boxes!).
  const Vec3 finalNormal = (aIsRef ? refNormalW : -refNormalW);
  out.normal = dot(finalNormal, normalAB) > 0.85 ? finalNormal : normalAB;
  reduceManifoldPoints(candidates, out.normal, poseA, poseB, out);
  return out.pointCount > 0;
}

// ---- GJK + EPA on Minkowski Difference A - B ----

struct SupportVertex {
  Vec3 p;   ///< a - b (Minkowski point)
  Vec3 a;   ///< point on A (world)
  Vec3 b;   ///< point on B (world)
};

SupportVertex minkowskiSupport(const ConvexShape& a, const Pose& poseA,
                               const ConvexShape& b, const Pose& poseB, Vec3 dirW) {
  const Vec3 pa = poseA.toWorld(a.support(poseA.dirToLocal(dirW)));
  const Vec3 pb = poseB.toWorld(b.support(poseB.dirToLocal(-dirW)));
  return {pa - pb, pa, pb};
}

struct Simplex {
  SupportVertex v[4];
  int size = 0;
  void push(const SupportVertex& s) {
    for (int i = std::min(size, 3); i > 0; i--) v[i] = v[i - 1];
    v[0] = s;
    if (size < 4) size++;
  }
};

bool sameDir(Vec3 a, Vec3 b) { return dot(a, b) > 0.0; }

bool handleSimplex(Simplex& s, Vec3& dir) {
  if (s.size == 2) {
    const Vec3 a = s.v[0].p, b = s.v[1].p;
    const Vec3 ab = b - a, ao = -a;
    if (sameDir(ab, ao)) {
      dir = cross(cross(ab, ao), ab);
      if (dot(dir, dir) < 1e-24) {
        Vec3 t1, t2;
        orthonormalBasis(normalized(ab), t1, t2);
        dir = t1;
      }
    } else {
      s.size = 1;
      dir = ao;
    }
    return false;
  }
  if (s.size == 3) {
    const Vec3 a = s.v[0].p, b = s.v[1].p, c = s.v[2].p;
    const Vec3 ab = b - a, ac = c - a, ao = -a;
    const Vec3 abc = cross(ab, ac);
    if (sameDir(cross(abc, ac), ao)) {
      if (sameDir(ac, ao)) {
        s.v[1] = s.v[2];
        s.size = 2;
        dir = cross(cross(ac, ao), ac);
      } else {
        s.size = 2;
        return handleSimplex(s, dir);
      }
    } else if (sameDir(cross(ab, abc), ao)) {
      s.size = 2;
      return handleSimplex(s, dir);
    } else {
      if (sameDir(abc, ao)) {
        dir = abc;
      } else {
        std::swap(s.v[1], s.v[2]);
        dir = -abc;
      }
    }
    return false;
  }
  // Tetrahedron (size == 4): origin tested against the 3 new faces (abc, acd, adb).
  const Vec3 a = s.v[0].p, b = s.v[1].p, c = s.v[2].p, d = s.v[3].p;
  const Vec3 ab = b - a, ac = c - a, ad = d - a, ao = -a;
  const Vec3 abc = cross(ab, ac);
  const Vec3 acd = cross(ac, ad);
  const Vec3 adb = cross(ad, ab);

  if (sameDir(abc, ao)) {
    s.size = 3;
    return handleSimplex(s, dir);
  }
  if (sameDir(acd, ao)) {
    s.v[1] = s.v[2];
    s.v[2] = s.v[3];
    s.size = 3;
    return handleSimplex(s, dir);
  }
  if (sameDir(adb, ao)) {
    s.v[2] = s.v[1];
    s.v[1] = s.v[3];
    s.size = 3;
    return handleSimplex(s, dir);
  }
  return true;  // Origin is strictly inside the tetrahedron!
}

bool runGjk(const ConvexShape& a, const Pose& poseA,
            const ConvexShape& b, const Pose& poseB, Simplex& simplex) {
  Vec3 dir = poseB.pos - poseA.pos;
  if (dot(dir, dir) < 1e-18) dir = {1.0, 0.0, 0.0};

  SupportVertex s0 = minkowskiSupport(a, poseA, b, poseB, dir);
  simplex.size = 0;
  simplex.push(s0);
  dir = -s0.p;
  if (dot(dir, dir) < 1e-18) dir = {0.0, 1.0, 0.0};

  for (int iter = 0; iter < 48; iter++) {
    const double dlen = length(dir);
    if (dlen < 1e-14) return true;
    const SupportVertex sup = minkowskiSupport(a, poseA, b, poseB, dir * (1.0 / dlen));
    if (dot(sup.p, dir) < -kContactMargin * dlen) {
      return false;  // Separating plane found.
    }
    // Check if support vertex already exists in simplex (touching / stalled).
    for (int i = 0; i < simplex.size; i++) {
      if (length(sup.p - simplex.v[i].p) < 1e-11) return false;
    }
    simplex.push(sup);
    if (handleSimplex(simplex, dir)) return true;
  }
  return false;
}

struct EpaResult {
  bool valid = false;
  Vec3 normal{};  ///< unit normal from A to B
  double depth = 0.0;
  Vec3 pointA{};
  Vec3 pointB{};
};

EpaResult runEpa(const ConvexShape& a, const Pose& poseA,
                 const ConvexShape& b, const Pose& poseB, const Simplex& initial) {
  EpaResult out;
  std::vector<SupportVertex> verts;
  verts.reserve(64);
  for (int i = 0; i < initial.size; i++) verts.push_back(initial.v[i]);

  // Ensure we start with a non-degenerate 4-vertex tetrahedron enclosing the origin.
  static constexpr Vec3 kAxes[6] = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
  for (int k = 0; verts.size() < 4 && k < 6; k++) {
    const SupportVertex s = minkowskiSupport(a, poseA, b, poseB, kAxes[k]);
    bool dup = false;
    for (const auto& v : verts)
      if (length(v.p - s.p) < 1e-9) dup = true;
    if (!dup) verts.push_back(s);
  }
  if (verts.size() < 4) return out;

  struct Face {
    uint32_t i[3];
    Vec3 normal;
    double dist;
    bool alive = true;
  };
  auto makeFace = [&](uint32_t i0, uint32_t i1, uint32_t i2, Face& f) -> bool {
    const Vec3 p0 = verts[i0].p, p1 = verts[i1].p, p2 = verts[i2].p;
    Vec3 n = cross(p1 - p0, p2 - p0);
    const double len = length(n);
    if (len < 1e-14) return false;
    n = n * (1.0 / len);
    double d = dot(n, p0);
    if (d < 0.0) {
      n = -n;
      d = -d;
      std::swap(i1, i2);
    }
    f = {{i0, i1, i2}, n, d, true};
    return true;
  };

  std::vector<Face> faces;
  faces.reserve(128);
  const uint32_t initTris[4][3] = {{0, 1, 2}, {0, 3, 1}, {0, 2, 3}, {1, 3, 2}};
  for (const auto& t : initTris) {
    Face f;
    if (makeFace(t[0], t[1], t[2], f)) faces.push_back(f);
  }
  if (faces.size() < 4) return out;

  size_t closestIdx = 0;
  for (int iter = 0; iter < 48; iter++) {
    double minDist = std::numeric_limits<double>::infinity();
    closestIdx = faces.size();
    for (size_t i = 0; i < faces.size(); i++) {
      if (faces[i].alive && faces[i].dist < minDist) {
        minDist = faces[i].dist;
        closestIdx = i;
      }
    }
    if (closestIdx >= faces.size()) break;

    const Face best = faces[closestIdx];
    const SupportVertex sup = minkowskiSupport(a, poseA, b, poseB, best.normal);
    const double supDist = dot(sup.p, best.normal);

    bool dupVert = false;
    for (const auto& v : verts) {
      if (length(v.p - sup.p) < 1e-7) {
        dupVert = true;
        break;
      }
    }

    // By Euler's polyhedron formula, <= 60 vertices have at most 2*60 - 4 = 116 live faces.
    // Guard against degenerate numerical splits ever growing faces unboundedly!
    if (supDist - best.dist < 1e-6 || dupVert || verts.size() >= 60 || faces.size() >= 256) {
      // Converged! Compute barycentric coordinates of projected origin on best triangle.
      const Vec3 p0 = verts[best.i[0]].p, p1 = verts[best.i[1]].p, p2 = verts[best.i[2]].p;
      const Vec3 proj = best.normal * best.dist;
      const Vec3 v0 = p1 - p0, v1 = p2 - p0, v2 = proj - p0;
      const double d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1);
      const double d20 = dot(v2, v0), d21 = dot(v2, v1);
      const double denom = d00 * d11 - d01 * d01;
      double u = 1.0 / 3.0, v = 1.0 / 3.0, w = 1.0 / 3.0;
      if (std::abs(denom) > 1e-18) {
        v = std::clamp((d11 * d20 - d01 * d21) / denom, 0.0, 1.0);
        w = std::clamp((d00 * d21 - d01 * d20) / denom, 0.0, 1.0);
        if (v + w > 1.0) {
          const double inv = 1.0 / (v + w);
          v *= inv;
          w *= inv;
        }
        u = 1.0 - v - w;
      }
      out.valid = true;
      // Minkowski difference is A - B, so pushing origin out along +best.normal pushes A along -normal, B along +normal.
      out.normal = best.normal;
      out.depth = best.dist;
      out.pointA = verts[best.i[0]].a * u + verts[best.i[1]].a * v + verts[best.i[2]].a * w;
      out.pointB = verts[best.i[0]].b * u + verts[best.i[1]].b * v + verts[best.i[2]].b * w;
      return out;
    }

    // Expand polytope: remove faces visible from `sup.p`, collect horizon edges.
    std::vector<std::pair<uint32_t, uint32_t>> edges;
    edges.reserve(32);
    auto addEdge = [&](uint32_t ea, uint32_t eb) {
      for (auto it = edges.begin(); it != edges.end(); ++it) {
        if (it->first == eb && it->second == ea) {
          edges.erase(it);
          return;
        }
      }
      if (edges.size() < 128) edges.emplace_back(ea, eb);
    };

    for (auto& f : faces) {
      if (!f.alive) continue;
      if (dot(f.normal, sup.p - verts[f.i[0]].p) > 1e-9) {
        f.alive = false;
        addEdge(f.i[0], f.i[1]);
        addEdge(f.i[1], f.i[2]);
        addEdge(f.i[2], f.i[0]);
      }
    }
    if (edges.empty() || edges.size() >= 120) {
      // Degenerate horizon: return the best face found so far.
      out.valid = true;
      out.normal = best.normal;
      out.depth = best.dist;
      out.pointA = (verts[best.i[0]].a + verts[best.i[1]].a + verts[best.i[2]].a) * (1.0 / 3.0);
      out.pointB = (verts[best.i[0]].b + verts[best.i[1]].b + verts[best.i[2]].b) * (1.0 / 3.0);
      return out;
    }
    const uint32_t newIdx = static_cast<uint32_t>(verts.size());
    verts.push_back(sup);
    for (const auto& [ea, eb] : edges) {
      Face nf;
      if (makeFace(ea, eb, newIdx, nf)) faces.push_back(nf);
    }
  }
  return out;
}

// ---- Exact Analytical Sphere-Sphere & Box-Box SAT ----

bool collideSphereSphere(const ConvexShape& a, const Pose& poseA,
                         const ConvexShape& b, const Pose& poseB, ContactManifold& out) {
  const Vec3 d = poseB.pos - poseA.pos;
  const double dist2 = dot(d, d);
  const double rSum = a.radius + b.radius;
  if (dist2 > (rSum + kContactMargin) * (rSum + kContactMargin)) return false;
  const double dist = std::sqrt(dist2);
  out.normal = dist > 1e-12 ? d * (1.0 / dist) : Vec3{0.0, 1.0, 0.0};
  const double pen = std::max(0.0, rSum - dist);
  const Vec3 pA = poseA.pos + out.normal * a.radius;
  const Vec3 pB = poseB.pos - out.normal * b.radius;
  out.pointCount = 1;
  out.points[0].worldPoint = (pA + pB) * 0.5;
  out.points[0].localA = poseA.toLocal(pA);
  out.points[0].localB = poseB.toLocal(pB);
  out.points[0].penetration = pen;
  out.points[0].featureId = 1;
  return true;
}

bool collideBoxBox(const ConvexShape& a, const Pose& poseA,
                   const ConvexShape& b, const Pose& poseB, ContactManifold& out) {
  const Mat3 ra = poseA.rot.toMat3();
  const Mat3 rb = poseB.rot.toMat3();
  const Vec3 ax[3] = {{ra.m[0], ra.m[3], ra.m[6]}, {ra.m[1], ra.m[4], ra.m[7]}, {ra.m[2], ra.m[5], ra.m[8]}};
  const Vec3 bx[3] = {{rb.m[0], rb.m[3], rb.m[6]}, {rb.m[1], rb.m[4], rb.m[7]}, {rb.m[2], rb.m[5], rb.m[8]}};
  const double ea[3] = {a.halfExtents.x, a.halfExtents.y, a.halfExtents.z};
  const double eb[3] = {b.halfExtents.x, b.halfExtents.y, b.halfExtents.z};
  const Vec3 d = poseB.pos - poseA.pos;

  double rMat[3][3], absR[3][3];
  for (int i = 0; i < 3; i++) {
    for (int j = 0; j < 3; j++) {
      rMat[i][j] = dot(ax[i], bx[j]);
      absR[i][j] = std::abs(rMat[i][j]) + 1e-9;
    }
  }
  const double tA[3] = {dot(d, ax[0]), dot(d, ax[1]), dot(d, ax[2])};

  double minPen = std::numeric_limits<double>::infinity();
  Vec3 bestAxis{};
  int bestType = -1;  // 0..2: face A, 3..5: face B, 6..14: edge-edge

  auto testAxis = [&](Vec3 axis, double pen, int type, double bias) -> bool {
    if (pen < -kContactMargin) return false;
    if (pen * bias < minPen) {
      minPen = pen;
      bestAxis = dot(axis, d) >= 0.0 ? axis : -axis;
      bestType = type;
    }
    return true;
  };

  // 3 face axes of A.
  for (int i = 0; i < 3; i++) {
    const double projB = eb[0] * absR[i][0] + eb[1] * absR[i][1] + eb[2] * absR[i][2];
    const double pen = ea[i] + projB - std::abs(tA[i]);
    if (!testAxis(ax[i], pen, i, 1.0)) return false;
  }
  // 3 face axes of B.
  for (int j = 0; j < 3; j++) {
    const double projA = ea[0] * absR[0][j] + ea[1] * absR[1][j] + ea[2] * absR[2][j];
    const double dist = std::abs(dot(d, bx[j]));
    const double pen = projA + eb[j] - dist;
    if (!testAxis(bx[j], pen, 3 + j, 1.0)) return false;
  }
  // 9 edge-edge cross axes (mild 1.02 bias favors face-face axes for stable flat stacking).
  for (int i = 0; i < 3; i++) {
    for (int j = 0; j < 3; j++) {
      Vec3 axis = cross(ax[i], bx[j]);
      const double len = length(axis);
      if (len < 1e-6) continue;
      axis = axis * (1.0 / len);
      const double projA = ea[0] * std::abs(dot(axis, ax[0])) + ea[1] * std::abs(dot(axis, ax[1])) + ea[2] * std::abs(dot(axis, ax[2]));
      const double projB = eb[0] * std::abs(dot(axis, bx[0])) + eb[1] * std::abs(dot(axis, bx[1])) + eb[2] * std::abs(dot(axis, bx[2]));
      const double pen = projA + projB - std::abs(dot(d, axis));
      if (!testAxis(axis, pen, 6 + i * 3 + j, 1.02)) return false;
    }
  }
  if (bestType < 0) return false;

  // Use the box hulls for exact Sutherland-Hodgman 4-point face clipping!
  if (a.hull && b.hull) {
    return buildHullManifold(*a.hull, poseA, *b.hull, poseB, bestAxis, std::max(0.0, minPen), out);
  }
  out.normal = bestAxis;
  const Vec3 supA = poseA.toWorld(a.support(poseA.dirToLocal(bestAxis)));
  const Vec3 supB = poseB.toWorld(b.support(poseB.dirToLocal(-bestAxis)));
  out.pointCount = 1;
  out.points[0].worldPoint = (supA + supB) * 0.5;
  out.points[0].localA = poseA.toLocal(supA);
  out.points[0].localB = poseB.toLocal(supB);
  out.points[0].penetration = std::max(0.0, minPen);
  out.points[0].featureId = static_cast<uint64_t>(bestType);
  return true;
}

}  // namespace

// ---- ConvexHull ----

Vec3 ConvexHull::support(Vec3 dir) const {
  if (vertices.empty()) return {};
  size_t best = 0;
  double bestDot = dot(vertices[0], dir);
  for (size_t i = 1; i < vertices.size(); i++) {
    const double d = dot(vertices[i], dir);
    if (d > bestDot) {
      bestDot = d;
      best = i;
    }
  }
  return vertices[best];
}

ConvexHull ConvexHull::fromBox(Vec3 h) {
  const double hx = std::max(std::abs(h.x), 1e-4);
  const double hy = std::max(std::abs(h.y), 1e-4);
  const double hz = std::max(std::abs(h.z), 1e-4);
  ConvexHull hull;
  hull.vertices = {
      {-hx, -hy, -hz}, {hx, -hy, -hz}, {hx, hy, -hz}, {-hx, hy, -hz},
      {-hx, -hy, hz},  {hx, -hy, hz},  {hx, hy, hz},  {-hx, hy, hz},
  };
  hull.faces = {
      {{0, 3, 2, 1}, {0, 0, -1}, hz},
      {{4, 5, 6, 7}, {0, 0, 1}, hz},
      {{0, 1, 5, 4}, {0, -1, 0}, hy},
      {{2, 3, 7, 6}, {0, 1, 0}, hy},
      {{0, 4, 7, 3}, {-1, 0, 0}, hx},
      {{1, 2, 6, 5}, {1, 0, 0}, hx},
  };
  hull.localBounds = {{-hx, -hy, -hz}, {hx, hy, hz}};
  hull.centroid = {};
  return hull;
}

ConvexHull ConvexHull::fromCylinder(double radius, double halfHeight, int segments) {
  const double r = std::max(std::abs(radius), 1e-4);
  const double hh = std::max(std::abs(halfHeight), 1e-4);
  const int n = std::clamp(segments, 8, 32);
  std::vector<Vec3> pts;
  pts.reserve(static_cast<size_t>(2 * n));
  for (int i = 0; i < n; i++) {
    const double a = (kTwoPi * i) / n;
    const double cx = r * std::cos(a);
    const double cz = r * std::sin(a);
    pts.push_back({cx, -hh, cz});
    pts.push_back({cx, hh, cz});
  }
  return fromPoints(pts);
}

ConvexHull ConvexHull::fromPoints(const std::vector<Vec3>& rawPoints) {
  if (rawPoints.empty()) return fromBox({0.004, 0.0048, 0.004});

  Box box;
  for (const Vec3& p : rawPoints) box.grow(p);
  const Vec3 extents = box.max - box.min;
  const Vec3 mid = (box.min + box.max) * 0.5;
  const double scale = std::max({extents.x, extents.y, extents.z, 1e-4});

  // Deduplicate close vertices (within 0.01% of scale).
  const double dedupEps = std::max(1e-6, scale * 1e-4);
  std::vector<Vec3> pts;
  pts.reserve(rawPoints.size());
  for (const Vec3& p : rawPoints) {
    bool dup = false;
    for (const Vec3& q : pts) {
      if (std::abs(p.x - q.x) < dedupEps && std::abs(p.y - q.y) < dedupEps && std::abs(p.z - q.z) < dedupEps) {
        dup = true;
        break;
      }
    }
    if (!dup) pts.push_back(p);
    if (pts.size() >= 512) break;  // Cap input cloud for ultra-dense meshes before hull extraction
  }

  // Fallback for nearly planar/collinear parts (e.g. stickers, thin fins).
  auto boxFallback = [&]() {
    ConvexHull h = fromBox({std::max(extents.x * 0.5, 2e-4),
                            std::max(extents.y * 0.5, 2e-4),
                            std::max(extents.z * 0.5, 2e-4)});
    for (Vec3& v : h.vertices) v = v + mid;
    for (HullFace& f : h.faces) f.offset = dot(f.normal, h.vertices[f.vertices[0]]);
    h.localBounds = {mid - Vec3{std::max(extents.x * 0.5, 2e-4), std::max(extents.y * 0.5, 2e-4), std::max(extents.z * 0.5, 2e-4)},
                     mid + Vec3{std::max(extents.x * 0.5, 2e-4), std::max(extents.y * 0.5, 2e-4), std::max(extents.z * 0.5, 2e-4)}};
    h.centroid = mid;
    return h;
  };

  if (pts.size() < 4 || std::min({extents.x, extents.y, extents.z}) < 1e-5) {
    return boxFallback();
  }

  // Find initial non-degenerate tetrahedron from extreme points.
  size_t i0 = 0, i1 = 0;
  for (size_t i = 1; i < pts.size(); i++) {
    if (pts[i].x < pts[i0].x) i0 = i;
    if (pts[i].x > pts[i1].x) i1 = i;
  }
  if (i0 == i1) {
    for (size_t i = 1; i < pts.size(); i++)
      if (length(pts[i] - pts[i0]) > length(pts[i1] - pts[i0])) i1 = i;
  }
  const Vec3 lineDir = normalized(pts[i1] - pts[i0]);
  size_t i2 = i0;
  double maxLineDist = 0.0;
  for (size_t i = 0; i < pts.size(); i++) {
    const Vec3 v = pts[i] - pts[i0];
    const double d = length(v - lineDir * dot(v, lineDir));
    if (d > maxLineDist) { maxLineDist = d; i2 = i; }
  }
  if (maxLineDist < scale * 1e-4) return boxFallback();

  const Vec3 triN = normalized(cross(pts[i1] - pts[i0], pts[i2] - pts[i0]));
  size_t i3 = i0;
  double maxPlaneDist = 0.0;
  for (size_t i = 0; i < pts.size(); i++) {
    const double d = std::abs(dot(triN, pts[i] - pts[i0]));
    if (d > maxPlaneDist) { maxPlaneDist = d; i3 = i; }
  }
  if (maxPlaneDist < scale * 1e-4) return boxFallback();

  const Vec3 interior = (pts[i0] + pts[i1] + pts[i2] + pts[i3]) * 0.25;
  std::vector<TriFace> tris;
  tris.reserve(128);
  const uint32_t seed[4][3] = {
      {uint32_t(i0), uint32_t(i1), uint32_t(i2)},
      {uint32_t(i0), uint32_t(i1), uint32_t(i3)},
      {uint32_t(i0), uint32_t(i2), uint32_t(i3)},
      {uint32_t(i1), uint32_t(i2), uint32_t(i3)},
  };
  for (const auto& s : seed) {
    TriFace tf;
    if (makeTriFace(pts, s[0], s[1], s[2], interior, tf)) tris.push_back(tf);
  }
  if (tris.size() < 4) return boxFallback();

  // Quickhull farthest-point expansion (capped at 64 hull vertices for fast contact clipping).
  std::vector<uint8_t> onHull(pts.size(), 0);
  onHull[i0] = onHull[i1] = onHull[i2] = onHull[i3] = 1;
  const double eps = scale * 1e-4;
  size_t hullVertCount = 4;

  for (int iter = 0; iter < 60 && hullVertCount < 64 && tris.size() < 512; iter++) {
    size_t bestPt = pts.size();
    double bestDist = eps;
    for (size_t pi = 0; pi < pts.size(); pi++) {
      if (onHull[pi]) continue;
      double maxFaceDist = -std::numeric_limits<double>::infinity();
      for (const auto& f : tris) {
        if (!f.alive) continue;
        const double d = dot(f.normal, pts[pi]) - f.offset;
        if (d > maxFaceDist) maxFaceDist = d;
      }
      if (maxFaceDist > bestDist) {
        bestDist = maxFaceDist;
        bestPt = pi;
      }
    }
    if (bestPt >= pts.size()) break;

    // Collect horizon edges of faces visible from pts[bestPt].
    std::vector<std::pair<uint32_t, uint32_t>> horizon;
    auto toggleEdge = [&](uint32_t a, uint32_t b) {
      for (auto it = horizon.begin(); it != horizon.end(); ++it) {
        if (it->first == b && it->second == a) {
          horizon.erase(it);
          return;
        }
      }
      horizon.emplace_back(a, b);
    };

    for (auto& f : tris) {
      if (!f.alive) continue;
      if (dot(f.normal, pts[bestPt]) - f.offset > eps * 0.25) {
        f.alive = false;
        toggleEdge(f.v[0], f.v[1]);
        toggleEdge(f.v[1], f.v[2]);
        toggleEdge(f.v[2], f.v[0]);
      }
    }
    if (horizon.empty()) break;

    onHull[bestPt] = 1;
    hullVertCount++;
    for (const auto& [ea, eb] : horizon) {
      TriFace nf;
      if (makeTriFace(pts, ea, eb, static_cast<uint32_t>(bestPt), interior, nf)) {
        tris.push_back(nf);
      }
    }
  }

  // Compact vertices to only those referenced by surviving faces.
  std::unordered_map<uint32_t, uint32_t> remap;
  ConvexHull hull;
  for (auto& f : tris) {
    if (!f.alive) continue;
    for (uint32_t& vi : f.v) {
      auto [it, inserted] = remap.emplace(vi, static_cast<uint32_t>(hull.vertices.size()));
      if (inserted) {
        hull.vertices.push_back(pts[vi]);
        hull.localBounds.grow(pts[vi]);
      }
      vi = it->second;
    }
  }
  if (hull.vertices.size() < 4) return boxFallback();

  hull.faces = mergeCoplanarFaces(hull.vertices, tris);
  if (hull.faces.size() < 4) return boxFallback();

  Vec3 c{};
  for (const Vec3& v : hull.vertices) c = c + v;
  hull.centroid = c * (1.0 / static_cast<double>(hull.vertices.size()));
  return hull;
}

ConvexHull ConvexHull::fromLdrawMesh(const ldraw::Mesh& mesh) {
  if (mesh.positions.empty()) return fromBox({0.004, 0.0048, 0.004});
  const size_t n = mesh.positions.size() / 3;
  // Subsample uniformly if mesh has > 1024 vertices while preserving all bounding extremes.
  std::vector<Vec3> pts;
  const size_t stride = std::max<size_t>(1, n / 512);
  pts.reserve(std::min<size_t>(n, 600));
  for (size_t i = 0; i < n; i += stride) {
    pts.push_back(Vec3{mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]} * kMetersPerLdu);
  }
  // Always ensure extreme vertices along 26 cardinal/diagonal directions are included.
  static constexpr Vec3 kDirs[13] = {
      {1, 0, 0}, {0, 1, 0}, {0, 0, 1},
      {1, 1, 0}, {1, -1, 0}, {1, 0, 1}, {1, 0, -1}, {0, 1, 1}, {0, 1, -1},
      {1, 1, 1}, {1, 1, -1}, {1, -1, 1}, {-1, 1, 1},
  };
  for (const Vec3& d : kDirs) {
    size_t bestMin = 0, bestMax = 0;
    double vMin = std::numeric_limits<double>::infinity();
    double vMax = -std::numeric_limits<double>::infinity();
    for (size_t i = 0; i < n; i++) {
      const double proj = mesh.positions[3 * i] * d.x + mesh.positions[3 * i + 1] * d.y + mesh.positions[3 * i + 2] * d.z;
      if (proj < vMin) { vMin = proj; bestMin = i; }
      if (proj > vMax) { vMax = proj; bestMax = i; }
    }
    pts.push_back(Vec3{mesh.positions[3 * bestMin], mesh.positions[3 * bestMin + 1], mesh.positions[3 * bestMin + 2]} * kMetersPerLdu);
    pts.push_back(Vec3{mesh.positions[3 * bestMax], mesh.positions[3 * bestMax + 1], mesh.positions[3 * bestMax + 2]} * kMetersPerLdu);
  }
  return fromPoints(pts);
}

// ---- ConvexShape & CompoundShape ----

ConvexShape ConvexShape::makeBox(Vec3 halfExtents) {
  ConvexShape s;
  s.kind = ShapeKind::Box;
  s.halfExtents = {std::max(std::abs(halfExtents.x), 1e-4),
                   std::max(std::abs(halfExtents.y), 1e-4),
                   std::max(std::abs(halfExtents.z), 1e-4)};
  s.hull = std::make_shared<ConvexHull>(ConvexHull::fromBox(s.halfExtents));
  return s;
}

ConvexShape ConvexShape::makeSphere(double radius) {
  ConvexShape s;
  s.kind = ShapeKind::Sphere;
  s.radius = std::max(std::abs(radius), 1e-4);
  return s;
}

ConvexShape ConvexShape::makeCapsule(double radius, double halfHeight) {
  ConvexShape s;
  s.kind = ShapeKind::Capsule;
  s.radius = std::max(std::abs(radius), 1e-4);
  s.halfHeight = std::max(std::abs(halfHeight), 0.0);
  return s;
}

ConvexShape ConvexShape::makeCylinder(double radius, double halfHeight, int segments) {
  ConvexShape s;
  s.kind = ShapeKind::Cylinder;
  s.radius = std::max(std::abs(radius), 1e-4);
  s.halfHeight = std::max(std::abs(halfHeight), 1e-4);
  s.hull = std::make_shared<ConvexHull>(ConvexHull::fromCylinder(s.radius, s.halfHeight, segments));
  return s;
}

ConvexShape ConvexShape::makeHull(std::shared_ptr<const ConvexHull> hull) {
  ConvexShape s;
  s.kind = ShapeKind::ConvexHull;
  s.hull = std::move(hull);
  if (s.hull && !s.hull->localBounds.empty()) {
    s.halfExtents = (s.hull->localBounds.max - s.hull->localBounds.min) * 0.5;
  }
  return s;
}

Vec3 ConvexShape::support(Vec3 dir) const {
  switch (kind) {
    case ShapeKind::Box:
      return {dir.x >= 0.0 ? halfExtents.x : -halfExtents.x,
              dir.y >= 0.0 ? halfExtents.y : -halfExtents.y,
              dir.z >= 0.0 ? halfExtents.z : -halfExtents.z};
    case ShapeKind::Sphere: {
      const double l = length(dir);
      return l > 1e-12 ? dir * (radius / l) : Vec3{radius, 0.0, 0.0};
    }
    case ShapeKind::Capsule: {
      const double l = length(dir);
      const Vec3 sphere = l > 1e-12 ? dir * (radius / l) : Vec3{radius, 0.0, 0.0};
      return {sphere.x, sphere.y + (dir.y >= 0.0 ? halfHeight : -halfHeight), sphere.z};
    }
    case ShapeKind::Cylinder: {
      const double xz = std::hypot(dir.x, dir.z);
      const double sx = xz > 1e-12 ? dir.x * (radius / xz) : radius;
      const double sz = xz > 1e-12 ? dir.z * (radius / xz) : 0.0;
      return {sx, dir.y >= 0.0 ? halfHeight : -halfHeight, sz};
    }
    case ShapeKind::ConvexHull:
      return hull ? hull->support(dir) : Vec3{};
  }
  return {};
}

Box ConvexShape::localBounds() const {
  switch (kind) {
    case ShapeKind::Box:
      return {-halfExtents, halfExtents};
    case ShapeKind::Sphere:
      return {{-radius, -radius, -radius}, {radius, radius, radius}};
    case ShapeKind::Capsule:
      return {{-radius, -(halfHeight + radius), -radius}, {radius, halfHeight + radius, radius}};
    case ShapeKind::Cylinder:
      return {{-radius, -halfHeight, -radius}, {radius, halfHeight, radius}};
    case ShapeKind::ConvexHull:
      return hull ? hull->localBounds : Box{};
  }
  return {};
}

Box ConvexShape::worldBounds(const Pose& pose) const {
  if (kind == ShapeKind::Sphere) {
    return {pose.pos - Vec3{radius, radius, radius}, pose.pos + Vec3{radius, radius, radius}};
  }
  const Xform xf{pose.rot.toMat3(), pose.pos};
  return localBounds().transformed(xf);
}

double ConvexShape::minExtent() const {
  switch (kind) {
    case ShapeKind::Box:
      return std::min({halfExtents.x, halfExtents.y, halfExtents.z});
    case ShapeKind::Sphere:
    case ShapeKind::Capsule:
      return radius;
    case ShapeKind::Cylinder:
      return std::min(radius, halfHeight);
    case ShapeKind::ConvexHull: {
      if (!hull || hull->localBounds.empty()) return 1e-3;
      const Vec3 e = (hull->localBounds.max - hull->localBounds.min) * 0.5;
      return std::max(1e-4, std::min({e.x, e.y, e.z}));
    }
  }
  return 1e-3;
}

void CompoundShape::recomputeBounds() {
  localBounds = Box{};
  partLocalBoxes.clear();
  partLocalBoxes.reserve(parts.size());
  localBvh.clear();
  for (uint32_t i = 0; i < parts.size(); i++) {
    const Box lb = parts[i].shape.worldBounds(parts[i].localPose);
    partLocalBoxes.push_back(lb);
    localBounds.merge(lb);
  }
  if (parts.size() > 8) {
    for (uint32_t i = 0; i < parts.size(); i++) {
      localBvh.insert(i, partLocalBoxes[i]);
    }
  }
}

Box CompoundShape::worldBounds(const Pose& pose) const {
  if (localBounds.empty()) return {};
  if (parts.size() <= 4) {
    Box b;
    for (const auto& sub : parts) b.merge(sub.shape.worldBounds(pose * sub.localPose));
    return b;
  }
  // O(1) exact transformed bounding box for large compound assemblies!
  const Xform xf{pose.rot.toMat3(), pose.pos};
  return localBounds.transformed(xf);
}

void CompoundShape::queryLocal(const Box& localQueryBox, std::vector<uint32_t>& outIndices) const {
  outIndices.clear();
  if (parts.size() > 8) {
    localBvh.query(localQueryBox, outIndices);
    return;
  }
  for (uint32_t i = 0; i < parts.size(); i++) {
    const Box& b = i < partLocalBoxes.size() ? partLocalBoxes[i] : localBounds;
    if (boxesOverlap(b, localQueryBox)) outIndices.push_back(i);
  }
}

double CompoundShape::minExtent() const {
  double m = std::numeric_limits<double>::infinity();
  for (const auto& sub : parts) m = std::min(m, sub.shape.minExtent());
  return std::isfinite(m) ? m : 1e-3;
}

// ---- Narrowphase Entry Points ----

bool collideConvex(const ConvexShape& a, const Pose& poseA,
                   const ConvexShape& b, const Pose& poseB,
                   ContactManifold& out) {
  out.pointCount = 0;

  // Fast analytical paths.
  if (a.kind == ShapeKind::Sphere && b.kind == ShapeKind::Sphere) {
    return collideSphereSphere(a, poseA, b, poseB, out);
  }
  if (a.kind == ShapeKind::Box && b.kind == ShapeKind::Box) {
    return collideBoxBox(a, poseA, b, poseB, out);
  }

  // General GJK + EPA.
  Simplex simplex;
  if (!runGjk(a, poseA, b, poseB, simplex)) return false;

  const EpaResult epa = runEpa(a, poseA, b, poseB, simplex);
  if (!epa.valid) return false;

  // If both shapes carry polyhedral hulls, build a stable multi-point clipped face manifold!
  if (a.hull && b.hull && !a.hull->faces.empty() && !b.hull->faces.empty()) {
    if (buildHullManifold(*a.hull, poseA, *b.hull, poseB, epa.normal, epa.depth, out)) {
      return true;
    }
  }

  // Single-point EPA manifold (curved primitives like Sphere/Capsule).
  out.normal = epa.normal;
  out.pointCount = 1;
  out.points[0].worldPoint = (epa.pointA + epa.pointB) * 0.5;
  out.points[0].localA = poseA.toLocal(epa.pointA);
  out.points[0].localB = poseB.toLocal(epa.pointB);
  out.points[0].penetration = std::max(0.0, epa.depth);
  out.points[0].featureId = 0xCAFE;
  return true;
}

bool collideConvexPlane(const ConvexShape& a, const Pose& poseA,
                        Vec3 planeUpNormal, double planePosOnUp,
                        ContactManifold& out) {
  out.pointCount = 0;
  // Normal points from A toward B (floor), so normal = -planeUpNormal.
  const Vec3 normalAB = -planeUpNormal;
  out.normal = normalAB;
  const Pose floorPose = Pose::identity();

  // Sphere / Capsule analytical plane contact.
  if (a.kind == ShapeKind::Sphere) {
    const double signedHeight = dot(poseA.pos, planeUpNormal) - planePosOnUp;
    const double pen = a.radius - signedHeight;
    if (pen < -kContactMargin) return false;
    const Vec3 pA = poseA.pos + normalAB * a.radius;
    const Vec3 pB = pA + planeUpNormal * std::max(0.0, pen);
    out.pointCount = 1;
    out.points[0].worldPoint = pB;
    out.points[0].localA = poseA.toLocal(pA);
    out.points[0].localB = pB;
    out.points[0].penetration = std::max(0.0, pen);
    out.points[0].featureId = 1;
    return true;
  }

  if (a.kind == ShapeKind::Capsule) {
    const Vec3 axisW = poseA.dirToWorld({0.0, 1.0, 0.0});
    const Vec3 ends[2] = {poseA.pos - axisW * a.halfHeight, poseA.pos + axisW * a.halfHeight};
    for (int i = 0; i < 2; i++) {
      const double pen = a.radius - (dot(ends[i], planeUpNormal) - planePosOnUp);
      if (pen >= -kContactMargin) {
        const Vec3 pA = ends[i] + normalAB * a.radius;
        const Vec3 pB = pA + planeUpNormal * std::max(0.0, pen);
        ContactPoint& cp = out.points[out.pointCount++];
        cp.worldPoint = pB;
        cp.localA = poseA.toLocal(pA);
        cp.localB = pB;
        cp.penetration = std::max(0.0, pen);
        cp.featureId = static_cast<uint64_t>(i + 1);
      }
    }
    return out.pointCount > 0;
  }

  // Polyhedral shapes (Box, Cylinder, ConvexHull): test all vertices directly against the floor plane!
  if (a.hull && !a.hull->vertices.empty()) {
    std::vector<CandidatePoint> candidates;
    candidates.reserve(a.hull->vertices.size());
    for (size_t i = 0; i < a.hull->vertices.size(); i++) {
      const Vec3 vW = poseA.toWorld(a.hull->vertices[i]);
      const double signedHeight = dot(vW, planeUpNormal) - planePosOnUp;
      if (signedHeight <= kContactMargin) {
        const double pen = std::max(0.0, -signedHeight);
        CandidatePoint cp;
        // pointOnB is the projection onto the floor surface; pointOnA = pointOnB + normalAB * pen = vW.
        cp.pointOnB = vW + planeUpNormal * pen;
        cp.depth = pen;
        cp.featureId = static_cast<uint64_t>(i + 1);
        candidates.push_back(cp);
      }
    }
    if (candidates.empty()) return false;
    reduceManifoldPoints(candidates, normalAB, poseA, floorPose, out);
    return out.pointCount > 0;
  }

  // Generic support fallback.
  const Vec3 deepest = poseA.toWorld(a.support(poseA.dirToLocal(normalAB)));
  const double signedHeight = dot(deepest, planeUpNormal) - planePosOnUp;
  if (signedHeight > kContactMargin) return false;
  const double pen = std::max(0.0, -signedHeight);
  const Vec3 onFloor = deepest + planeUpNormal * pen;
  out.pointCount = 1;
  out.points[0].worldPoint = onFloor;
  out.points[0].localA = poseA.toLocal(deepest);
  out.points[0].localB = onFloor;
  out.points[0].penetration = pen;
  out.points[0].featureId = 1;
  return true;
}

std::optional<ShapeRayHit> raycastConvex(const ConvexShape& shape, const Pose& pose,
                                         Vec3 origin, Vec3 unitDir, double maxT) {
  const Vec3 ro = pose.toLocal(origin);
  const Vec3 rd = pose.dirToLocal(unitDir);

  if (shape.kind == ShapeKind::Sphere) {
    const double b = dot(ro, rd);
    const double c = dot(ro, ro) - shape.radius * shape.radius;
    const double disc = b * b - c;
    if (disc < 0.0) return std::nullopt;
    const double t = -b - std::sqrt(disc);
    if (t < 0.0 || t > maxT) return std::nullopt;
    const Vec3 pL = ro + rd * t;
    return ShapeRayHit{t, pose.toWorld(pL), pose.dirToWorld(normalized(pL))};
  }

  // Polyhedral slab intersection against all faces of the convex hull (exact for Box, Cylinder, ConvexHull).
  if (shape.hull && !shape.hull->faces.empty()) {
    double tMin = 0.0;
    double tMax = maxT;
    Vec3 hitNormalL{};
    bool hit = false;
    for (const auto& f : shape.hull->faces) {
      const double num = f.offset - dot(f.normal, ro);
      const double den = dot(f.normal, rd);
      if (std::abs(den) < 1e-12) {
        if (num < 0.0) return std::nullopt;  // Ray parallel and outside slab.
      } else {
        const double t = num / den;
        if (den < 0.0) {
          if (t > tMin) {
            tMin = t;
            hitNormalL = f.normal;
            hit = true;
          }
        } else {
          if (t < tMax) tMax = t;
        }
        if (tMin > tMax) return std::nullopt;
      }
    }
    if (!hit && tMin == 0.0) {
      hitNormalL = -rd;  // Ray originated inside shape.
    }
    const Vec3 pL = ro + rd * tMin;
    return ShapeRayHit{tMin, pose.toWorld(pL), pose.dirToWorld(normalized(hitNormalL))};
  }

  // Capsule fallback: AABB slab.
  const Box b = shape.localBounds();
  double tMin = 0.0, tMax = maxT;
  Vec3 nL{};
  const double o[3] = {ro.x, ro.y, ro.z};
  const double d[3] = {rd.x, rd.y, rd.z};
  const double mn[3] = {b.min.x, b.min.y, b.min.z};
  const double mx[3] = {b.max.x, b.max.y, b.max.z};
  for (int i = 0; i < 3; i++) {
    if (std::abs(d[i]) < 1e-12) {
      if (o[i] < mn[i] || o[i] > mx[i]) return std::nullopt;
    } else {
      double t1 = (mn[i] - o[i]) / d[i];
      double t2 = (mx[i] - o[i]) / d[i];
      double sgn = -1.0;
      if (t1 > t2) { std::swap(t1, t2); sgn = 1.0; }
      if (t1 > tMin) {
        tMin = t1;
        nL = {i == 0 ? sgn : 0.0, i == 1 ? sgn : 0.0, i == 2 ? sgn : 0.0};
      }
      tMax = std::min(tMax, t2);
      if (tMin > tMax) return std::nullopt;
    }
  }
  const Vec3 pL = ro + rd * tMin;
  return ShapeRayHit{tMin, pose.toWorld(pL), pose.dirToWorld(length(nL) > 0.0 ? nL : -rd)};
}

// ---- DynamicBvh ----

int32_t DynamicBvh::allocateNode() {
  if (freeList_ != kNullNode) {
    const int32_t id = freeList_;
    freeList_ = nodes_[id].parent;
    nodes_[id] = Node{};
    return id;
  }
  const int32_t id = static_cast<int32_t>(nodes_.size());
  nodes_.emplace_back();
  return id;
}

void DynamicBvh::freeNode(int32_t id) {
  nodes_[id].parent = freeList_;
  nodes_[id].height = -1;
  freeList_ = id;
}

int32_t DynamicBvh::insert(uint32_t uid, const Box& box) {
  const int32_t id = allocateNode();
  const Vec3 pad{kFattenMargin, kFattenMargin, kFattenMargin};
  nodes_[id].box = {box.min - pad, box.max + pad};
  nodes_[id].userId = uid;
  nodes_[id].height = 0;
  insertLeaf(id);
  return id;
}

void DynamicBvh::remove(int32_t proxyId) {
  if (proxyId == kNullNode) return;
  removeLeaf(proxyId);
  freeNode(proxyId);
}

bool DynamicBvh::update(int32_t proxyId, const Box& box, Vec3 displacement) {
  if (proxyId == kNullNode) return false;
  if (boxContains(nodes_[proxyId].box, box)) return false;
  removeLeaf(proxyId);
  const Vec3 pad{kFattenMargin, kFattenMargin, kFattenMargin};
  Box fat{box.min - pad, box.max + pad};
  const Vec3 pred = displacement * 2.0;
  if (pred.x < 0.0) fat.min.x += pred.x; else fat.max.x += pred.x;
  if (pred.y < 0.0) fat.min.y += pred.y; else fat.max.y += pred.y;
  if (pred.z < 0.0) fat.min.z += pred.z; else fat.max.z += pred.z;
  nodes_[proxyId].box = fat;
  insertLeaf(proxyId);
  return true;
}

const Box& DynamicBvh::fatBox(int32_t proxyId) const { return nodes_[proxyId].box; }
uint32_t DynamicBvh::userId(int32_t proxyId) const { return nodes_[proxyId].userId; }

void DynamicBvh::clear() {
  nodes_.clear();
  root_ = kNullNode;
  freeList_ = kNullNode;
}

void DynamicBvh::insertLeaf(int32_t leaf) {
  if (root_ == kNullNode) {
    root_ = leaf;
    nodes_[root_].parent = kNullNode;
    return;
  }
  const Box leafBox = nodes_[leaf].box;
  int32_t index = root_;
  while (!nodes_[index].isLeaf()) {
    const int32_t c1 = nodes_[index].left;
    const int32_t c2 = nodes_[index].right;
    const double area = boxSurfaceArea(nodes_[index].box);
    const Box combined = boxUnion(nodes_[index].box, leafBox);
    const double combinedArea = boxSurfaceArea(combined);
    const double cost = 2.0 * combinedArea;
    const double inheritanceCost = 2.0 * (combinedArea - area);

    auto childCost = [&](int32_t c) {
      const Box u = boxUnion(leafBox, nodes_[c].box);
      return nodes_[c].isLeaf() ? (boxSurfaceArea(u) + inheritanceCost)
                                : ((boxSurfaceArea(u) - boxSurfaceArea(nodes_[c].box)) + inheritanceCost);
    };
    const double cost1 = childCost(c1);
    const double cost2 = childCost(c2);
    if (cost < cost1 && cost < cost2) break;
    index = cost1 < cost2 ? c1 : c2;
  }

  const int32_t sibling = index;
  const int32_t oldParent = nodes_[sibling].parent;
  const int32_t newParent = allocateNode();
  nodes_[newParent].parent = oldParent;
  nodes_[newParent].box = boxUnion(leafBox, nodes_[sibling].box);
  nodes_[newParent].height = nodes_[sibling].height + 1;
  nodes_[newParent].left = sibling;
  nodes_[newParent].right = leaf;
  nodes_[sibling].parent = newParent;
  nodes_[leaf].parent = newParent;

  if (oldParent != kNullNode) {
    if (nodes_[oldParent].left == sibling) nodes_[oldParent].left = newParent;
    else nodes_[oldParent].right = newParent;
  } else {
    root_ = newParent;
  }

  int32_t cur = nodes_[leaf].parent;
  while (cur != kNullNode) {
    cur = balance(cur);
    const int32_t l = nodes_[cur].left;
    const int32_t r = nodes_[cur].right;
    nodes_[cur].height = 1 + std::max(nodes_[l].height, nodes_[r].height);
    nodes_[cur].box = boxUnion(nodes_[l].box, nodes_[r].box);
    cur = nodes_[cur].parent;
  }
}

void DynamicBvh::removeLeaf(int32_t leaf) {
  if (leaf == root_) {
    root_ = kNullNode;
    return;
  }
  const int32_t parent = nodes_[leaf].parent;
  const int32_t grandParent = nodes_[parent].parent;
  const int32_t sibling = (nodes_[parent].left == leaf) ? nodes_[parent].right : nodes_[parent].left;

  if (grandParent != kNullNode) {
    if (nodes_[grandParent].left == parent) nodes_[grandParent].left = sibling;
    else nodes_[grandParent].right = sibling;
    nodes_[sibling].parent = grandParent;
    freeNode(parent);
    int32_t cur = grandParent;
    while (cur != kNullNode) {
      cur = balance(cur);
      const int32_t l = nodes_[cur].left;
      const int32_t r = nodes_[cur].right;
      nodes_[cur].height = 1 + std::max(nodes_[l].height, nodes_[r].height);
      nodes_[cur].box = boxUnion(nodes_[l].box, nodes_[r].box);
      cur = nodes_[cur].parent;
    }
  } else {
    root_ = sibling;
    nodes_[sibling].parent = kNullNode;
    freeNode(parent);
  }
}

int32_t DynamicBvh::balance(int32_t iA) {
  Node& A = nodes_[iA];
  if (A.isLeaf() || A.height < 2) return iA;
  const int32_t iB = A.left, iC = A.right;
  const int32_t diff = nodes_[iC].height - nodes_[iB].height;

  if (diff > 1) {
    const int32_t iF = nodes_[iC].left, iG = nodes_[iC].right;
    nodes_[iC].left = iA;
    nodes_[iC].parent = A.parent;
    A.parent = iC;
    if (nodes_[iC].parent != kNullNode) {
      if (nodes_[nodes_[iC].parent].left == iA) nodes_[nodes_[iC].parent].left = iC;
      else nodes_[nodes_[iC].parent].right = iC;
    } else {
      root_ = iC;
    }
    if (nodes_[iF].height > nodes_[iG].height) {
      nodes_[iC].right = iF;
      A.right = iG;
      nodes_[iG].parent = iA;
      A.box = boxUnion(nodes_[iB].box, nodes_[iG].box);
      nodes_[iC].box = boxUnion(A.box, nodes_[iF].box);
      A.height = 1 + std::max(nodes_[iB].height, nodes_[iG].height);
      nodes_[iC].height = 1 + std::max(A.height, nodes_[iF].height);
    } else {
      nodes_[iC].right = iG;
      A.right = iF;
      nodes_[iF].parent = iA;
      A.box = boxUnion(nodes_[iB].box, nodes_[iF].box);
      nodes_[iC].box = boxUnion(A.box, nodes_[iG].box);
      A.height = 1 + std::max(nodes_[iB].height, nodes_[iF].height);
      nodes_[iC].height = 1 + std::max(A.height, nodes_[iG].height);
    }
    return iC;
  }
  if (diff < -1) {
    const int32_t iD = nodes_[iB].left, iE = nodes_[iB].right;
    nodes_[iB].left = iA;
    nodes_[iB].parent = A.parent;
    A.parent = iB;
    if (nodes_[iB].parent != kNullNode) {
      if (nodes_[nodes_[iB].parent].left == iA) nodes_[nodes_[iB].parent].left = iB;
      else nodes_[nodes_[iB].parent].right = iB;
    } else {
      root_ = iB;
    }
    if (nodes_[iD].height > nodes_[iE].height) {
      nodes_[iB].right = iD;
      A.left = iE;
      nodes_[iE].parent = iA;
      A.box = boxUnion(nodes_[iC].box, nodes_[iE].box);
      nodes_[iB].box = boxUnion(A.box, nodes_[iD].box);
      A.height = 1 + std::max(nodes_[iC].height, nodes_[iE].height);
      nodes_[iB].height = 1 + std::max(A.height, nodes_[iD].height);
    } else {
      nodes_[iB].right = iE;
      A.left = iD;
      nodes_[iD].parent = iA;
      A.box = boxUnion(nodes_[iC].box, nodes_[iD].box);
      nodes_[iB].box = boxUnion(A.box, nodes_[iE].box);
      A.height = 1 + std::max(nodes_[iC].height, nodes_[iD].height);
      nodes_[iB].height = 1 + std::max(A.height, nodes_[iE].height);
    }
    return iB;
  }
  return iA;
}

void DynamicBvh::query(const Box& queryBox, std::vector<uint32_t>& outUserIds) const {
  if (root_ == kNullNode) return;
  std::vector<int32_t> stack;
  stack.reserve(64);
  stack.push_back(root_);
  while (!stack.empty()) {
    const int32_t id = stack.back();
    stack.pop_back();
    if (!boxesOverlap(nodes_[id].box, queryBox)) continue;
    if (nodes_[id].isLeaf()) {
      outUserIds.push_back(nodes_[id].userId);
    } else {
      stack.push_back(nodes_[id].left);
      stack.push_back(nodes_[id].right);
    }
  }
}

void DynamicBvh::overlappingPairs(std::vector<std::pair<uint32_t, uint32_t>>& outPairs) const {
  outPairs.clear();
  if (root_ == kNullNode) return;
  std::vector<uint32_t> hits;
  hits.reserve(32);
  for (size_t i = 0; i < nodes_.size(); i++) {
    const Node& n = nodes_[i];
    if (n.height != 0) continue;  // Only live leaves.
    hits.clear();
    query(n.box, hits);
    for (uint32_t other : hits) {
      if (n.userId < other) outPairs.emplace_back(n.userId, other);
    }
  }
  std::sort(outPairs.begin(), outPairs.end());
  outPairs.erase(std::unique(outPairs.begin(), outPairs.end()), outPairs.end());
}

void DynamicBvh::raycast(Vec3 origin, Vec3 dir, double maxT, std::vector<RayHitCandidate>& out) const {
  out.clear();
  if (root_ == kNullNode) return;
  auto slab = [&](const Box& b, double& tEnter) -> bool {
    double tMin = 0.0, tMax = maxT;
    const double o[3] = {origin.x, origin.y, origin.z};
    const double d[3] = {dir.x, dir.y, dir.z};
    const double mn[3] = {b.min.x, b.min.y, b.min.z};
    const double mx[3] = {b.max.x, b.max.y, b.max.z};
    for (int i = 0; i < 3; i++) {
      if (std::abs(d[i]) < 1e-12) {
        if (o[i] < mn[i] || o[i] > mx[i]) return false;
      } else {
        double t1 = (mn[i] - o[i]) / d[i];
        double t2 = (mx[i] - o[i]) / d[i];
        if (t1 > t2) std::swap(t1, t2);
        tMin = std::max(tMin, t1);
        tMax = std::min(tMax, t2);
        if (tMin > tMax) return false;
      }
    }
    tEnter = tMin;
    return true;
  };
  std::vector<int32_t> stack;
  stack.reserve(64);
  stack.push_back(root_);
  while (!stack.empty()) {
    const int32_t id = stack.back();
    stack.pop_back();
    double tEnter = 0.0;
    if (!slab(nodes_[id].box, tEnter)) continue;
    if (nodes_[id].isLeaf()) {
      out.push_back({nodes_[id].userId, tEnter});
    } else {
      stack.push_back(nodes_[id].left);
      stack.push_back(nodes_[id].right);
    }
  }
  std::sort(out.begin(), out.end(), [](const RayHitCandidate& a, const RayHitCandidate& b) {
    return a.tEnter < b.tEnter;
  });
}

// ---- ContactCache & HullCache ----

void ContactCache::restore(std::vector<ContactManifold>& activeManifolds) {
  for (auto& m : activeManifolds) {
    const Key key{m.bodyA, m.bodyB, m.subA, m.subB};
    auto it = cache_.find(key);
    if (it == cache_.end()) continue;
    const Entry& prev = it->second;
    for (uint32_t i = 0; i < m.pointCount; i++) {
      ContactPoint& cp = m.points[i];
      int matched = -1;
      for (uint32_t j = 0; j < prev.count; j++) {
        if (prev.points[j].featureId == cp.featureId &&
            length(prev.points[j].localA - cp.localA) < 0.004) {
          matched = static_cast<int>(j);
          break;
        }
      }
      if (matched < 0) {
        double bestD2 = 0.002 * 0.002;
        for (uint32_t j = 0; j < prev.count; j++) {
          const Vec3 da = prev.points[j].localA - cp.localA;
          const double d2 = dot(da, da);
          if (d2 < bestD2) {
            bestD2 = d2;
            matched = static_cast<int>(j);
          }
        }
      }
      if (matched >= 0) {
        cp.normalImpulse = prev.points[matched].normalImpulse;
        cp.tangentImpulse1 = prev.points[matched].tangentImpulse1;
        cp.tangentImpulse2 = prev.points[matched].tangentImpulse2;
        cp.twistImpulse = prev.points[matched].twistImpulse;
      }
    }
  }
}

void ContactCache::save(const std::vector<ContactManifold>& activeManifolds) {
  for (auto& [k, entry] : cache_) entry.age++;
  for (const auto& m : activeManifolds) {
    const Key key{m.bodyA, m.bodyB, m.subA, m.subB};
    Entry& e = cache_[key];
    e.count = m.pointCount;
    e.age = 0;
    for (uint32_t i = 0; i < m.pointCount; i++) {
      e.points[i] = {m.points[i].localA, m.points[i].localB, m.points[i].featureId,
                     m.points[i].normalImpulse, m.points[i].tangentImpulse1,
                     m.points[i].tangentImpulse2, m.points[i].twistImpulse};
    }
  }
  for (auto it = cache_.begin(); it != cache_.end();) {
    if (it->second.age > 3) it = cache_.erase(it);
    else ++it;
  }
}

void ContactCache::clear() { cache_.clear(); }

std::vector<ContactCache::SerializedEntry> ContactCache::serialize() const {
  std::vector<SerializedEntry> out;
  out.reserve(cache_.size());
  for (const auto& [k, e] : cache_) {
    SerializedEntry se;
    se.bodyA = k.bodyA; se.bodyB = k.bodyB; se.subA = k.subA; se.subB = k.subB;
    se.count = e.count; se.age = e.age;
    for (uint32_t i = 0; i < e.count; i++) {
      se.points[i] = {e.points[i].localA, e.points[i].localB, e.points[i].featureId,
                      e.points[i].normalImpulse, e.points[i].tangentImpulse1,
                      e.points[i].tangentImpulse2, e.points[i].twistImpulse};
    }
    out.push_back(se);
  }
  return out;
}

void ContactCache::deserialize(const std::vector<SerializedEntry>& entries) {
  cache_.clear();
  for (const auto& se : entries) {
    Entry e;
    e.count = se.count; e.age = se.age;
    for (uint32_t i = 0; i < se.count; i++) {
      e.points[i] = {se.points[i].localA, se.points[i].localB, se.points[i].featureId,
                     se.points[i].normalImpulse, se.points[i].tangentImpulse1,
                     se.points[i].tangentImpulse2, se.points[i].twistImpulse};
    }
    cache_.emplace(Key{se.bodyA, se.bodyB, se.subA, se.subB}, e);
  }
}

std::shared_ptr<const ConvexHull> HullCache::get(const std::shared_ptr<const ldraw::Mesh>& mesh) {
  if (!mesh) return std::make_shared<ConvexHull>(ConvexHull::fromBox({0.004, 0.0048, 0.004}));
  auto it = map_.find(mesh.get());
  if (it != map_.end()) return it->second;
  auto hull = std::make_shared<ConvexHull>(ConvexHull::fromLdrawMesh(*mesh));
  map_.emplace(mesh.get(), hull);
  return hull;
}

void HullCache::clear() { map_.clear(); }

}  // namespace bm::physics
