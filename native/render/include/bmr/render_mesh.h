#pragma once
// A part as the GPU draws it: corners with normals, at three levels of detail.
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>
#include "bm/ldraw/mesh.h"
#include "bm/ldraw/part_cache.h"
#include "bm/math.h"
#include "bm/model.h"

namespace bmr {

struct Vertex {
  float px, py, pz;  ///< part space, LDU
  float nx, ny, nz;  ///< unit, outward
  uint32_t color;    ///< 0: the piece's own colour; otherwise 0xFFRRGGBB, fixed, sRGB
};

struct RenderMesh {
  std::vector<Vertex> vertices;
  std::vector<uint32_t> indices;  ///< triangles, counter-clockwise seen from outside
  std::vector<float> edges;       ///< xyz pairs: the part's outline lines
  bm::Box bounds;                 ///< of the triangles; empty if there are none
  float lowError = 0;             ///< LDU: how far this coarse mesh may be from the full one (bm::ldraw::Mesh::lowError)
  /// The first `topIndices` indices are all an eye above `bottom` (+y down, part space) can
  /// see; the rest are the part's underside (bm::ldraw::Mesh::underside). All of them when
  /// there is none.
  uint32_t topIndices = 0;
  float bottom = 0;
  bool hasUnderside() const { return topIndices < indices.size(); }
  bool empty() const { return indices.empty(); }
};

/// A corner's normal is the mean of the normals of the triangles that share it, have the same
/// colour, each weighted by its angle at the corner,
/// and are within kCreaseDegrees of each other; a sharper turn splits the corner. Triangles with no area or with bad indices are dropped. `colors` resolves fixed
/// triangle colours: codes 16 and 24 (the piece's own and its edge colour) stay 0; a code
/// not in the table is kUnknownColor. Never throws.
RenderMesh buildRenderMesh(const bm::ldraw::Mesh& mesh, const std::unordered_map<int, bm::ldraw::Color>& colors);

/// Add narrow shading fillets on convex edges, retaining the original surface and underside ranges.
void roundRenderEdges(RenderMesh& mesh, double width);

/// Softens the base of standard LDraw studs embedded in a flat upper deck, without
/// moving the surface or weakening any other LDraw outline. In particular, the
/// explicit base ring in stud.dat is suppressed, while the top rim remains.
/// No effect on unsupported/open cylinders, non-stud rings, or mesh bounds.
void softenStudRoots(RenderMesh& mesh, double width);

/// A box with flat normals: the furthest level of detail, and the stand-in for a missing
/// part. An empty box gives an empty mesh.
RenderMesh boxMesh(const bm::Box& box);

/// Shadow: the Low mesh without its studs (FlattenOptions::noStuds), which the key light's
/// shadow map is drawn from; never drawn to be seen.
enum class Detail : uint8_t { Full = 0, Low = 1, Box = 2, Shadow = 3 };

/// The render meshes of the parts of one model, built on first use. Thread-safe.
class MeshLibrary {
 public:
  /// `low` is a cache with FlattenOptions::lowResPrimitives set. All three must outlive this.
  MeshLibrary(const bm::Model& model, bm::ldraw::PartCache& full, bm::ldraw::PartCache& low);
  ~MeshLibrary();
  MeshLibrary(const MeshLibrary&) = delete;
  MeshLibrary& operator=(const MeshLibrary&) = delete;
  /// Never null. Low is the Full mesh itself when the low-resolution one has no fewer
  /// triangles (or is one of the model's own inline parts); Box is the box of the Full mesh;
  /// Shadow is the Low mesh, or one without studs when that has fewer triangles.
  /// A part with no geometry gives an empty mesh at every level.
  std::shared_ptr<const RenderMesh> get(const std::string& part, Detail detail);
  /// Reads `model` from now on (it must outlive this); meshes already made are kept, except
  /// those of the model's own inline parts, which an edit may have changed.
  void rebind(const bm::Model& model);

 private:
  struct State;
  std::unique_ptr<State> state_;
};

}  // namespace bmr
