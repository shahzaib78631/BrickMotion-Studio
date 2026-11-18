# CORTAO reference implementation in WebGL2

Pinned upstream: [theagentd/CORTAO](https://github.com/theagentd/CORTAO), commit
`9e8771f0ed72cae0f8b5dde30986a469ea5e07db` (v1.0.1).
Copyright 2026 Daniel Isheden, MIT. The original license is retained in every
shader and in `LICENSE`. `upstream.json` records independently checked SHA-256
hashes for all four original shader bodies and the official lookup-table bytes.

## Selected upstream configuration

This implements the supplied **occlusion-only** variant, with 16 depth samples,
16 rays, the official 24×24×16 R16_UINT lookup table, 32-bit arithmetic, and the
unmodified default spatial filter (small, asymmetric). The prepass, main pass,
and filter execute the upstream functions. There is no GTAO denoiser, additional
AO blur, side attenuation, grazing fade, power curve, or second wide-radius AO
layer in the CORTAO path.

Upstream does **not** ship temporal filtering. Its documented constant-seed mode
is used (`randomSeed = 0`), so residual spatial grain is expected. The optional
bent-normal variant is not selected; this is the upstream occlusion-only path.

## Platform adapters

The checked-in `.glsl` shader bodies are byte-identical to the pinned `.h` files.
`shaders.ts` concatenates them with the engine input/output callbacks. GLSL ES
3.00 needs explicit signed/unsigned conversions and vector constructors in a few
places where desktop GLSL allows implicit conversions/scalar swizzles. `fma`
uses the same multiply-add expression allowed by the upstream HLSL path;
`bitCount` uses an equivalent integer population count.

WebGL2 has no compute dispatch or imageStore. Each destination fragment calls the
upstream kernel and retains only its own output store:

- Prepass fragments reconstruct the selected input pixel for each mip, then
  execute `cortao_prepass`. Packed R32UI mip values are never averaged.
- Main fragments execute `cortao_mainPass`. Out-of-screen reads return the
  upstream border value, and mip/lookup reads use nearest filtering.
- Filter fragments execute the upstream 2×2 invocation and retain their matching
  output. Four texelFetch reads reproduce textureGather's TL/TR/BR/BL order.

These dispatch changes affect execution cost. Upstream compute performance
claims do not automatically apply to this WebGL backend.

## Lighting integration

CORTAO runs before the beauty pass. Its filtered visibility is sampled in the
PBR materials in linear HDR, attenuating indirect diffuse and using Three.js's
specular-occlusion function for indirect specular. Direct lighting, emission and
the tone-mapped final framebuffer are not multiplied by AO. The primary camera's
screen texture is disabled for auxiliary/reflection camera draws. Floors with
lit PBR materials use the same hook. GTAO retains its existing finishing path.

## Verification

`tests/render/cortao.test.ts` checks upstream source integrity, camera
reconstruction, settings persistence, lookup structure and indirect-lighting
integration. `tests/helpers/cortaoOracle.ts` independently evaluates scalar CPU
versions of the upstream equations; it does not import generated shader code.

Run the dev server, then:

```sh
node scripts/verify-ao.cjs http://localhost:5173/cortao-verify.html /tmp/cortao-verify.png 200 'aoBench.compare()'
```

The GPU verification uses 49×35 (odd-sized) buffers for flat, stepped, tilted,
tilted-with-step and sky fixtures in perspective and orthographic projections.
It checks:

- Packed depth/normal values against CPU packing (normal bits exact; depth within
  one packed-depth quantization bin, allowing cross-backend FP32 rounding).
- Every mip against independent forward-scatter selection, bit for bit.
- Every raw AO pixel against the CPU ray-mask calculation using the same packed
  inputs and official lookup table.
- Every filtered AO pixel against an independent CPU spatial filter.
- No occlusion on an empty scene/flat plane, and nonzero occlusion on steps.

Raw and filtered AO comparisons allow at most one 8-bit output level to account
for normalized-target rounding. This is numerical coverage of those fixtures,
not a claim of universal bitwise identity across GPU backends or of agreement
with a full-scene path tracer.

`/ao-bench.html` additionally loads local `.io`, `.ldr` or `.mpd` models and
compares static, orbit and moving-part frames. `scripts/verify-ao.cjs` saves
images, numerical results and hardware GPU timings without changing projects.
The earlier prototype's measurements do not describe this reference pipeline.

### Recorded validation on Apple M1 Pro / Chrome ANGLE Metal

All ten fixtures (17,150 pixels) passed. Raw and filtered AO matched the scalar
CPU outputs with **zero byte difference**. All generated mips matched the
independent forward scatter bit for bit. Packed normals matched exactly;
perspective depth packing differed by at most one packed-depth quantization bin
from scalar FP32 packing, without changing the tested AO outputs.

The GPU lighting test also passed: black visibility removes ambient light while
direct illumination and emission remain byte-identical. Rendering through a
second camera leaves that camera's ambient lighting unchanged.
