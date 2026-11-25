#import "metal/impl.h"
#include "bmr/tolerances.h"

namespace bmr {

void Renderer::setPlacementPreview(const std::vector<PlacementGhost>& ghosts, bool refused) {
  auto& preview = impl_->preview;
  preview.resize(ghosts.size());
  for (size_t i = 0; i < ghosts.size(); i++) {
    const PlacementGhost& ghost = ghosts[i];
    auto& part = preview[i];
    if (part.group.part != ghost.part || part.group.color != ghost.color || part.refused != refused) {
      part.group.part = ghost.part;
      part.group.color = ghost.color;
      part.group.material = materialFor(colorFor(impl_->model->library(), refused ? 0x2ff453a : ghost.color));
      part.group.material.alpha = refused ? 0.30f : 0.56f;
      part.refused = refused;
    }
    part.pose = ghost.pose;
  }
}

void Renderer::clearPlacementPreview() { impl_->preview.clear(); }

void Renderer::Impl::drawPreview(id<MTLRenderCommandEncoder> enc, const PlacementPreview& placing, FrameStats& stats) {
  const GpuMesh& gpu = mesh(placing.group, Detail::Full);
  if (!gpu.indexCount) return;
  const bm::Xform& pose = placing.pose;
  const bool mirrored = bm::determinant(pose.r) < 0;
  const bm::Vec3 t = pose.t - scene.origin;
  const double* r = pose.r.m;
  const Instance instance{
    {static_cast<float>(r[0]), static_cast<float>(r[1]), static_cast<float>(r[2]), static_cast<float>(t.x),
     static_cast<float>(r[3]), static_cast<float>(r[4]), static_cast<float>(r[5]), static_cast<float>(t.y),
     static_cast<float>(r[6]), static_cast<float>(r[7]), static_cast<float>(r[8]), static_cast<float>(t.z)},
    UINT32_MAX, mirrored ? kMirrored : 0
  };
  const Material& m = placing.group.material;
  DrawUniforms draw{};
  draw.base = simd_make_float4(m.base[0], m.base[1], m.base[2], m.alpha);
  draw.surface = simd_make_float4(m.roughness, m.metalness, m.clearcoat, placing.refused ? 1 : 0);
  draw.flip = simd_make_float4(mirrored ? -1 : 1, 1, 0, 0);
  const uint32_t first = 0;
  [enc setRenderPipelineState:pipelines.transparent];
  [enc setDepthStencilState:placing.refused ? pipelines.depthNone : pipelines.depthRead];
  [enc setCullMode:MTLCullModeBack];
  [enc setFrontFacingWinding:mirrored ? MTLWindingClockwise : MTLWindingCounterClockwise];
  [enc setVertexBuffer:gpu.vertices offset:0 atIndex:0];
  [enc setVertexBytes:&instance length:sizeof instance atIndex:3];
  [enc setVertexBytes:&first length:sizeof first atIndex:4];
  [enc setVertexBytes:&draw length:sizeof draw atIndex:2];
  [enc setFragmentBytes:&draw length:sizeof draw atIndex:2];
  [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:gpu.indexCount indexType:MTLIndexTypeUInt32
                 indexBuffer:gpu.indices indexBufferOffset:0];
  ++stats.drawCalls;
  ++stats.instances;
  stats.triangles += gpu.indexCount / 3;
  ++stats.byDetail[static_cast<int>(Detail::Full)];

  if (!gpu.edgeVertices) return;
  const auto& bounds = meshes->get(placing.group.part, Detail::Full)->bounds;
  const bm::Vec3 center = (bounds.min + bounds.max) * 0.5;
  draw.sphere = simd_make_float4(static_cast<float>(center.x), static_cast<float>(center.y),
                                static_cast<float>(center.z), static_cast<float>(bm::length(bounds.max - bounds.min) * 0.5));
  draw.edge = placing.refused ? simd_make_float4(m.base[0], m.base[1], m.base[2], 0.94f) :
                               simd_make_float4(m.edge[0], m.edge[1], m.edge[2], 0.65f);
  const float near = kEdgeNearer;
  [enc setRenderPipelineState:pipelines.edges];
  [enc setCullMode:MTLCullModeNone];
  [enc setVertexBuffer:gpu.edges offset:0 atIndex:0];
  [enc setVertexBytes:&draw length:sizeof draw atIndex:2];
  [enc setFragmentBytes:&draw length:sizeof draw atIndex:2];
  [enc setVertexBytes:&near length:sizeof near atIndex:5];
  [enc drawPrimitives:MTLPrimitiveTypeLine vertexStart:0 vertexCount:gpu.edgeVertices];
  ++stats.drawCalls;
}

}  // namespace bmr
