# Transparent plastic

`glassOptics.ts` defines the optics used by the live viewport, interactive Studio
path renderer, and still export. Clear and Soft transmit fully; roughness controls
surface blur. Surface reflectance is neutral; the palette colour drives volume
absorption. Milky retains a diffuse component.

The reference absorption distance (0.3 studs) and IOR (1.52) are provisional
settings inherited from the existing model, not optical measurements of LEGO
plastic. A photograph with unknown lighting, exposure, plastic formulation and
camera processing cannot establish these values. Matching that photograph requires
the exact model, colour and a controlled lighting reference.

## Geometry and units

The model uses 20 LDraw units per world stud. The live material receives a local
wall estimate in LDU. Three's transmission shader applies mesh scale; attenuation
distance is in world studs. Do not divide thickness by root scale again.

`glassThickness.ts` casts inward from triangle centroids to the first outward
boundary. This distinguishes cavities from solid bounding boxes. It interpolates
area-weighted estimates at shared vertices. The estimate is cached per geometry,
with position/index version invalidation. Open or incomplete surfaces use the
explicit 1.2 LDU fallback; statistics are stored in geometry userData. This is an
approximation of local wall thickness, not the complete refracted ray path.

Both path renderers follow mesh intersections and use ray distances through the
material. The live screen-space transmission buffer cannot reproduce arbitrary
stacks, internal reflections, or geometry absent from that buffer. Select path
tracing for those cases. Sharing material parameters does not make different
transport algorithms produce identical images.

## WebGL still tracer compatibility

The installed three-gpu-pathtracer 0.0.27 calculates normal-incidence reflectance
with `pow((1-eta)/(1+eta), 2)`. At exit interfaces eta > 1, making the base negative;
GLSL pow has undefined results there. On the tested Apple/ANGLE GPU this produced
NaNs and terminated transmitted rays, leaving nearly black glass.

`pathTracerNumerics.ts` squares by multiplication and clamps roundoff before
Fresnel square roots/powers. The patch is applied to the shader owned by each
still tracer; dependencies on disk are untouched. Its source regression test is
intentionally tied to the installed shader to flag changes during upgrades.

## Reproduce

Run the Vite dev server, open `/glass-bench.html`, and render the comparison.
The three groups are a single tile, adjacent tiles, and stacked plates. All modes
share a camera, environment and geometry. Legacy reproduces the old constant wall
and whitened surface tint. Live uses geometry wall estimates. Path uses the same
optics with the WebGL still tracer.

GPU absorption verification:

```
node scripts/verify-ao.cjs http://localhost:5173/glass-bench.html .cache/glass/absorption.png 200 'glassBench.verifyAbsorption()'
```

The fixture measures average linear HDR radiance through one, two and three
0.2-stud slabs against independently calculated Beer–Lambert transmission. An IOR
of 1.01 isolates absorption with negligible Fresnel loss; nonzero roughness avoids
a delta-lobe singularity. It checks finite output and a three-byte tolerance at
1024 samples. This validates transport/units for the fixture, not colour accuracy
against a photograph.

Verified on Apple M1 Pro / Chrome ANGLE Metal: all three slab tests passed at
1024 samples, each within 1/255 of the independent expected RGB. The real-part
comparison (3068b and 3020) compiled without shader errors and measured all sampled
triangles without the open-surface fallback. WebGL path comparison uses 128 samples
and remains visibly noisy. The interactive WebGPU renderer's shared material values
are covered by unit tests; this fixture does not validate its GPU transport.
