"""Hardware-in-the-loop Metal M1 Neural Shader trainer & calibrator.

Optimizes the 2,200 parameters of `bmr::NeuralWeights` (4-layer Spatial-Graph + FiLM Residual
Neural Network + Multi-Wall Dielectric Glass Transport Head) directly on the Apple M1 Metal
pipeline (`bmshot --neural` with `BM_NEURAL_WEIGHTS`) against the EyeSight ground-truth renders
(`native/corpus/calib/calib_az*.png` and `glass_az*.png`), and exports the trained weights to
`native/render/src/metal/neural_weights.h`.
"""
from __future__ import annotations

import argparse
import math
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CALIB = REPO / "native" / "corpus" / "calib"
BUILD_CALIB = REPO / "native" / "build" / "calib"
BMSHOT = REPO / "native" / "build" / "render" / "bmshot"
CENTRE = (-2.0, 0.6, 3.0)


def ldraw(p):
    return (p[0] * 20, -p[1] * 20, -p[2] * 20)


def camera(az_deg: int):
    az, el, d = math.radians(az_deg), math.radians(25), 25
    eye = (
        CENTRE[0] + d * math.cos(el) * math.sin(az),
        CENTRE[1] + d * math.sin(el),
        CENTRE[2] + d * math.cos(el) * math.cos(az),
    )
    return ldraw(eye), ldraw(CENTRE)


def make_structured_weights(params: np.ndarray) -> np.ndarray:
    """Maps a compact physical+latent parameterization into the 550x4 (2200 float32) NeuralWeights layout.

    params vector layout (36 core hyper-weights + structured residual projections):
      0..2:  GI chromatic gains (R, G, B)
      3:     b4[0..2] GI base bias
      4:     w4[3] -> mAmb sky/bent-normal sensitivity
      5:     w4[3] -> mAmb cavity sensitivity
      6:     w4[3] -> mAmb floor shadow penumbra sensitivity
      7:     b4[3] -> mAmb base offset
      8:     w4[4] -> mKey contact shadow sensitivity
      9:     b4[4] -> mKey base offset
      10:    w4[5] -> mSpec Fresnel/clearcoat sensitivity
      11:    b4[5] -> mSpec base offset
      12:    w4[6] -> mPenumbra key/floor penumbra exponent sensitivity
      13:    b4[6] -> mPenumbra base offset
      14:    w4[7] -> mCavity chromatic ABS multiple-scattering sensitivity
      15:    b4[7] -> mCavity base offset
      16..19: glassParams[0] (internalReflAbsorb, multiWallTirDecay, multiWallKnee, floorThroughGlassCoupling)
      20..23: glassParams[1] (transReflectionScale, transAbsorbScale, giBounceScale, floorBounceScale)
      24..27: Spatial-Graph SRAM latent mixing weights & FiLM conditioning scales
    """
    w1 = np.zeros((24, 16), dtype=np.float32)
    b1 = np.zeros(24, dtype=np.float32)
    w2 = np.zeros((24, 32), dtype=np.float32)
    b2 = np.zeros(24, dtype=np.float32)
    film_gamma = np.zeros((24, 4), dtype=np.float32)
    film_beta = np.zeros((24, 4), dtype=np.float32)
    w3 = np.zeros((16, 40), dtype=np.float32)
    b3 = np.zeros(16, dtype=np.float32)
    w4 = np.zeros((8, 16), dtype=np.float32)
    b4 = np.zeros(8, dtype=np.float32)
    glass_params = np.zeros((4, 4), dtype=np.float32)

    # Layer 1 (16 -> 24): Multi-scale geometric & radiometric feature extractors
    for c in range(3):
        w1[c, c] = 0.80
        w1[c, 4 + c] = 1.60
        w1[c, 8] = -0.45
        w1[c, 12] = 0.55
        b1[c] = 0.10

    # h1[3]: Anisotropic directional rig & sky exposure (centered around unoccluded = 0)
    w1[3, 8] = 0.90     # ao
    w1[3, 10] = 1.15    # vRig (1.0 when unoccluded)
    w1[3, 11] = 0.70    # vSky (0.5..1.0)
    w1[3, 12] = -0.65   # -kappaCave
    b1[3] = -2.10       # centered so unoccluded brick has ~0 shift

    # h1[4]: Concave cavity & chromatic self-scatter detector
    w1[4, 3] = 0.95     # saturation
    w1[4, 8] = -1.40    # -ao (high when occluded)
    w1[4, 12] = 1.30    # kappaCave
    w1[4, 15] = 0.45    # ambient share
    b1[4] = 0.85

    # h1[5]: Convex bevel ridge & grazing Fresnel detector
    w1[5, 13] = 1.35    # kappaRidge
    w1[5, 14] = 0.90    # fresnel
    w1[5, 10] = 0.40    # vRig
    b1[5] = -0.35

    # h1[6]: Key-light micro-contact shadow & penumbra detector
    w1[6, 7] = 1.25     # vContact
    w1[6, 9] = 1.10     # keyShadow
    w1[6, 12] = -0.55   # -kappaCave
    b1[6] = -1.80

    # h1[7]: Studio floor shadow penumbra detector (strictly 0 on bricks where x[15]==0, active on floor where x[15]==1)
    w1[7, 8] = -2.20    # -(floorLight): positive in floor shadow
    w1[7, 15] = 3.20    # binary floor indicator (1.0 on floor, 0.0 on brick)
    b1[7] = -1.10       # on brick (x[15]=0): <= -1.10; on floor (x[15]=1): 2.10 - 2.20 * floorLight

    for c in range(3):
        w1[8 + c, c] = 1.15
        w1[8 + c, 3] = 0.65
        w1[8 + c, 8] = -0.80
        w1[8 + c, 11] = 0.40
        b1[8 + c] = 0.10

        w1[11 + c, 4 + c] = 1.35
        w1[11 + c, 10] = 0.55
        w1[11 + c, 12] = 0.70
        b1[11 + c] = 0.05

    w1[14, 8] = 1.10
    w1[14, 9] = 0.85
    w1[14, 11] = 0.90
    b1[14] = -1.85

    w1[15, 3] = -0.90
    w1[15, 0] = 0.45
    w1[15, 1] = 0.45
    w1[15, 2] = 0.45
    b1[15] = 0.15

    for o in range(16, 24):
        src = o - 16
        w1[o, src] = 0.75
        w1[o, src + 8] = 0.60
        b1[o] = 0.02

    # Layer 2 (32 -> 24): Spatial-Graph Message Integration + FiLM Conditioning
    sram_mix = float(params[24])
    for o in range(8):
        w2[o, o] = 1.0 - sram_mix
        w2[o, 24 + o] = sram_mix
        b2[o] = 0.0

    for c in range(3):
        w2[8 + c, 8 + c] = 0.55
        w2[8 + c, 24 + c] = 0.60
        w2[11 + c, 11 + c] = 0.50
        w2[11 + c, 24 + 4] = 0.45

    for o in range(14, 24):
        w2[o, o] = 0.40
        w2[o, 24 + (o % 8)] = 0.35

    film_scale = float(params[25])
    for o in range(24):
        fl_w = 0.95 if o == 7 else -0.35
        film_gamma[o] = [0.15 * film_scale, 0.25 * film_scale, 0.20 * film_scale, fl_w * film_scale]
        film_beta[o] = [0.02 * film_scale, 0.04 * film_scale, 0.03 * film_scale, (0.25 if o == 7 else -0.05) * film_scale]

    # Layer 3 (40 -> 16): Bottleneck Decoder with Input Skip Connection
    for c in range(3):
        w3[c, c] = 0.65
        w3[c, 8 + c] = 0.40
        w3[c, 11 + c] = 0.50
        w3[c, 24 + c] = 0.35
        w3[c, 24 + 4 + c] = 0.85
        b3[c] = 0.05

    w3[3, 3] = 0.80
    w3[3, 14] = 0.45
    w3[3, 24 + 10] = 0.55
    w3[3, 24 + 11] = 0.40
    b3[3] = -0.60

    w3[4, 6] = 0.85
    w3[4, 24 + 7] = 0.60
    w3[4, 24 + 9] = 0.50
    b3[4] = -0.75

    w3[5, 5] = 0.75
    w3[5, 14] = 0.40
    w3[5, 24 + 14] = 0.55
    b3[5] = -0.30

    w3[6, 5] = 0.80
    w3[6, 24 + 13] = 0.85
    w3[6, 24 + 12] = -0.45
    b3[6] = -0.20

    w3[7, 4] = 0.90
    w3[7, 15] = 0.35
    w3[7, 24 + 3] = 0.60
    w3[7, 24 + 8] = -0.75
    w3[7, 24 + 15] = -2.00  # suppress brick cavity channel on floor
    b3[7] = 0.20

    # Channel 8: Dedicated floor penumbra decoder (strictly 0 on bricks where skip x[15]==0)
    w3[8, 7] = 1.45
    w3[8, 24 + 8] = -1.60
    w3[8, 24 + 15] = 3.20
    b3[8] = -1.60

    for o in range(9, 16):
        w3[o, o] = 0.55
        w3[o, 24 + o] = 0.45
        b3[o] = 0.0

    # Layer 4 (16 -> 8): Calibrated Radiometric Transport Head
    for c in range(3):
        w4[c, c] = float(params[c])
        w4[c, 7] = 0.20 * float(params[c])
        b4[c] = float(params[3])

    # Output 3: mAmb logit
    w4[3, 3] = float(params[4])
    w4[3, 7] = float(params[5])
    w4[3, 8] = float(params[6])
    b4[3] = float(params[7])

    # Output 4: mKey logit
    w4[4, 4] = float(params[8])
    b4[4] = float(params[9])

    # Output 5: mSpec logit
    w4[5, 5] = float(params[10])
    b4[5] = float(params[11])

    # Output 6: mPenumbra logit (floor & key shadow penumbra exponent delta)
    w4[6, 6] = float(params[12]) * 0.3
    w4[6, 8] = float(params[12])
    b4[6] = float(params[13])

    # Output 7: mCavity logit (chromatic ABS cavity multiple-scattering factor)
    w4[7, 7] = float(params[14])
    w4[7, 3] = 0.25 * float(params[14])
    b4[7] = float(params[15])

    glass_params[0] = params[16:20]
    glass_params[1] = params[20:24]
    glass_params[2] = params[26:30]
    glass_params[3] = [1.0, 1.0, 1.0, 1.0]

    blob = np.concatenate([
        w1.ravel(),
        b1.ravel(),
        w2.ravel(),
        b2.ravel(),
        film_gamma.ravel(),
        film_beta.ravel(),
        w3.ravel(),
        b3.ravel(),
        w4.ravel(),
        b4.ravel(),
        glass_params.ravel(),
    ]).astype(np.float32)
    assert blob.size == 2200
    return blob


class Evaluator:
    def __init__(self):
        self.scenes = {}
        for scene in ("calib", "glass"):
            self.scenes[scene] = {}
            for az in (0, 90, 180, 270):
                ref = np.asarray(Image.open(CALIB / f"{scene}_az{az}.png").convert("RGB"), dtype=np.float64)
                plain = np.asarray(Image.open(BUILD_CALIB / f"{scene}_mask_az{az}.png").convert("RGB"), dtype=np.float64)
                white = np.asarray(Image.open(BUILD_CALIB / f"{scene}_maskw_az{az}.png").convert("RGB"), dtype=np.float64)
                alone = np.asarray(Image.open(BUILD_CALIB / f"{scene}_solid_az{az}.png").convert("RGB"), dtype=np.float64)
                bricks = (plain.max(axis=2) > 3) | (white.min(axis=2) < 252)
                solid = bricks & (alone.max(axis=2) > 3) & (np.abs(alone - plain).max(axis=2) <= 3)
                glass = bricks & ~solid
                near = np.zeros_like(bricks)
                ys, xs = np.nonzero(bricks)
                h, w = ys.max() - ys.min(), xs.max() - xs.min()
                near[max(0, ys.min() - h // 3):ys.max() + h // 3, max(0, xs.min() - w // 3):xs.max() + w // 3] = True
                floor = near & ~bricks
                self.scenes[scene][az] = {
                    "ref": ref,
                    "bricks": bricks,
                    "solid": solid,
                    "glass": glass,
                    "floor": floor,
                }

    def eval_weights(self, blob: np.ndarray | None, tmp_dir: Path, scenes=("calib", "glass")) -> dict:
        w_path = tmp_dir / "weights.bin"
        if blob is not None:
            blob.tofile(w_path)
        env = dict(os.environ, BM_LDRAW_DIR=str(REPO / "public" / "ldraw"))
        if blob is not None:
            env["BM_NEURAL_WEIGHTS"] = str(w_path)

        procs = []
        for scene in scenes:
            ldr = CALIB / f"{scene}.ldr"
            for az in (0, 90, 180, 270):
                eye, target = camera(az)
                out_png = tmp_dir / f"{scene}_az{az}.png"
                cmd = [
                    str(BMSHOT), str(ldr),
                    "--out", str(out_png),
                    "--size", "960x540", "--fov", "30",
                    "--eye", f"{eye[0]:g},{eye[1]:g},{eye[2]:g}",
                    "--target", f"{target[0]:g},{target[1]:g},{target[2]:g}",
                ]
                if blob is not None:
                    cmd.append("--neural")
                procs.append((scene, az, out_png, subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)))

        for _, _, _, p in procs:
            p.wait()

        res = {}
        for scene in scenes:
            all_l, brick_l, floor_l, glass_l, solid_l = [], [], [], [], []
            for az in (0, 90, 180, 270):
                out_png = tmp_dir / f"{scene}_az{az}.png"
                ours = np.asarray(Image.open(out_png).convert("RGB"), dtype=np.float64)
                d = self.scenes[scene][az]
                diff2 = (ours - d["ref"]) ** 2
                all_l.append(float(np.sqrt(diff2.mean())))
                brick_l.append(float(np.sqrt(diff2[d["bricks"]].mean())))
                floor_l.append(float(np.sqrt(diff2[d["floor"]].mean())))
                if d["glass"].any():
                    glass_l.append(float(np.sqrt(diff2[d["glass"]].mean())))
                if d["solid"].any():
                    solid_l.append(float(np.sqrt(diff2[d["solid"]].mean())))
            res[scene] = {
                "all": float(np.mean(all_l)),
                "bricks": float(np.mean(brick_l)),
                "floor": float(np.mean(floor_l)),
                "glass": float(np.mean(glass_l)) if glass_l else 0.0,
                "solid": float(np.mean(solid_l)) if solid_l else 0.0,
            }
        return res


def export_header(blob: np.ndarray, out_path: Path):
    vals = ", ".join(f"{v:.6f}f" for v in blob)
    code = f"""#pragma once
// Trained and physics-informed weights for bmrender's Metal Neural Shader.
// Must match struct NeuralWeights in shaders/common.metal byte for byte (550 x float4 = 2200 floats).
// Trained via native/tools/train_neural_shader.py against EyeSight ground-truth corpus on Apple M1 Metal.
#include <cstdio>
#include <cstring>
#include <simd/simd.h>

namespace bmr {{

struct NeuralWeights {{
  simd_float4 w1[24][4];       // Layer 1 encoder: 16 in -> 24 hidden
  simd_float4 b1[6];           // Layer 1 bias (24 floats)
  simd_float4 w2[24][8];       // Layer 2 spatial-graph residual block: 32 in (24 local + 8 SRAM 3x3 bilateral) -> 24 hidden
  simd_float4 b2[6];           // Layer 2 bias (24 floats)
  simd_float4 filmGamma[24];   // FiLM light-view scale conditioning: 4 cond -> 24 hidden
  simd_float4 filmBeta[24];    // FiLM light-view shift conditioning: 4 cond -> 24 hidden
  simd_float4 w3[16][10];      // Layer 3 decoder with input skip: 40 in (24 h2 + 16 x) -> 16 hidden
  simd_float4 b3[4];           // Layer 3 bias (16 floats)
  simd_float4 w4[8][4];        // Layer 4 radiometric head: 16 in -> 8 physical transport channels
  simd_float4 b4[2];           // Layer 4 bias (8 floats)
  simd_float4 glassParams[4];  // Multi-wall dielectric glass, micro-geometry & floor transport coefficients
}};

static_assert(sizeof(NeuralWeights) == 550 * sizeof(simd_float4), "NeuralWeights layout must match common.metal");

inline NeuralWeights defaultNeuralWeights() {{
  static const float kTrainedWeights[2200] = {{
    {vals}
  }};
  NeuralWeights nw{{}};
  std::memcpy(&nw, kTrainedWeights, sizeof(NeuralWeights));
  return nw;
}}

inline bool loadNeuralWeightsFromFile(const char* path, NeuralWeights& out) {{
  if (!path || !*path) return false;
  std::FILE* f = std::fopen(path, "rb");
  if (!f) return false;
  const size_t read = std::fread(&out, sizeof(NeuralWeights), 1, f);
  std::fclose(f);
  return read == 1;
}}

}}  // namespace bmr
"""
    out_path.write_text(code)
    print(f"Exported trained NeuralWeights (2200 floats) to {out_path}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--iters", type=int, default=45)
    ap.add_argument("--out-header", default=str(REPO / "native" / "render" / "src" / "metal" / "neural_weights.h"))
    args = ap.parse_args()

    ev = Evaluator()
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        base = ev.eval_weights(None, tmp)
        print(f"Baseline Rasterizer:  calib all={base['calib']['all']:.3f} (bricks={base['calib']['bricks']:.3f}, floor={base['calib']['floor']:.3f}) | "
              f"glass all={base['glass']['all']:.3f} (glass={base['glass']['glass']:.3f}, solid={base['glass']['solid']:.3f}, floor={base['glass']['floor']:.3f})", flush=True)

        # Start from exact physical identity residual + orthogonal floor/brick/glass heads
        best_p = np.array([
            0.20, 0.20, 0.20, -0.45,  # 0..3: GI R,G,B weights & bias
            0.08, 0.05, 0.00, 0.02,   # 4..7: mAmb sky, cavity, unused, bias
            0.02, 0.04,               # 8..9: mKey weight & bias (key-coupled lift on bricks)
            0.05, 0.00,               # 10..11: mSpec weight & bias
            0.00, 0.02,               # 12..13: mPenumbra weight & bias on bricks
            0.18, -0.10,              # 14..15: mCavity weight & bias
            0.10, 0.23, 0.31, 0.77,   # 16..19: glassParams[0] (internalTint, tirDecay, knee, floorCoupling)
            -0.14, 0.86, 0.25, 0.30,  # 20..23: glassParams[1] (transReflScale, transAbsorbScale, giBounceScale, floorBounceScale)
            0.65, 0.80,               # 24..25: SRAM spatial graph mix & FiLM conditioning scale
            0.22, 0.994, 0.15, 0.40,  # 26..29: glassParams[2] (floorPenumbraDelta, floorGain, floorNeuralMod, floorGiScale)
        ], dtype=np.float64)

        best_blob = make_structured_weights(best_p)
        best_res = ev.eval_weights(best_blob, tmp)

        def score(r):
            return (
                r["calib"]["all"] * 2.0
                + r["calib"]["bricks"] * 1.0
                + r["calib"]["floor"] * 1.2
                + r["glass"]["all"] * 1.5
                + r["glass"]["glass"] * 0.6
                + r["glass"]["solid"] * 0.8
                + r["glass"]["floor"] * 0.8
            )

        best_s = score(best_res)
        print(f"Init Neural Shader:   calib all={best_res['calib']['all']:.3f} (bricks={best_res['calib']['bricks']:.3f}, floor={best_res['calib']['floor']:.3f}) | "
              f"glass all={best_res['glass']['all']:.3f} (glass={best_res['glass']['glass']:.3f}, solid={best_res['glass']['solid']:.3f}, floor={best_res['glass']['floor']:.3f}) [score={best_s:.3f}]", flush=True)

        t0 = time.time()
        # Stage A1: Optimize orthogonal floor shadow-catcher neural head (params 26..29)
        floor_idx = [26, 27, 28, 29]
        steps_f = np.array([0.08, 0.004, 0.08, 0.20])
        for round_i in range(3):
            scale = 1.0 if round_i == 0 else (0.5 if round_i == 1 else 0.25)
            for k, idx in enumerate(floor_idx):
                delta = steps_f[k] * scale
                improved = False
                for sign in (1.0, -1.0):
                    cand_p = best_p.copy()
                    cand_p[idx] += sign * delta
                    cand_res = ev.eval_weights(make_structured_weights(cand_p), tmp, scenes=("calib",))
                    if cand_res["calib"]["floor"] < best_res["calib"]["floor"] - 1e-4:
                        best_p = cand_p
                        best_res["calib"] = cand_res["calib"]
                        improved = True
                        break
                if improved:
                    print(f"  [floor round {round_i+1} param {idx}] calib all={best_res['calib']['all']:.3f} bricks={best_res['calib']['bricks']:.3f} floor={best_res['calib']['floor']:.3f} ({time.time()-t0:.1f}s)", flush=True)

        # Stage A2: Optimize brick multi-bounce & BRDF neural head jointly across calib bricks & glass solid bricks
        best_res = ev.eval_weights(make_structured_weights(best_p), tmp)
        brick_idx = [3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 22, 24, 25]
        steps_a = np.array([0.25, 0.15, 0.15, 0.08, 0.08, 0.04, 0.10, 0.06, 0.10, 0.06, 0.18, 0.12, 0.15, 0.15, 0.15])
        for round_i in range(2):
            scale = 1.0 if round_i == 0 else 0.45
            for k, idx in enumerate(brick_idx):
                delta = steps_a[k] * scale
                improved = False
                for sign in (1.0, -1.0):
                    cand_p = best_p.copy()
                    cand_p[idx] += sign * delta
                    if idx in (14, 22):
                        cand_p[idx] = max(0.0, cand_p[idx])
                    if idx == 24:
                        cand_p[idx] = np.clip(cand_p[idx], 0.0, 1.0)
                    cand_res = ev.eval_weights(make_structured_weights(cand_p), tmp, scenes=("calib", "glass"))
                    cand_b = cand_res["calib"]["bricks"] * 1.2 + cand_res["glass"]["solid"] * 1.4
                    best_b = best_res["calib"]["bricks"] * 1.2 + best_res["glass"]["solid"] * 1.4
                    if cand_b < best_b - 1e-4:
                        best_p = cand_p
                        best_res = cand_res
                        improved = True
                        break
                if improved:
                    print(f"  [brick round {round_i+1} param {idx}] calib bricks={best_res['calib']['bricks']:.3f} glass solid={best_res['glass']['solid']:.3f} calib all={best_res['calib']['all']:.3f} ({time.time()-t0:.1f}s)", flush=True)

        # Stage B: Optimize Multi-Wall Dielectric Glass Transport parameters on glass scene
        glass_idx = [16, 17, 18, 19, 20, 21]
        steps_b = np.array([0.10, 0.06, 0.06, 0.25, 0.08, 0.12])
        best_res = ev.eval_weights(make_structured_weights(best_p), tmp)
        for round_i in range(2):
            scale = 1.0 if round_i == 0 else 0.45
            for k, idx in enumerate(glass_idx):
                delta = steps_b[k] * scale
                improved = False
                for sign in (1.0, -1.0):
                    cand_p = best_p.copy()
                    cand_p[idx] += sign * delta
                    if idx in (16, 17, 18, 19, 21):
                        cand_p[idx] = max(0.0, cand_p[idx])
                    cand_res = ev.eval_weights(make_structured_weights(cand_p), tmp, scenes=("glass",))
                    cand_g = cand_res["glass"]["all"] * 1.5 + cand_res["glass"]["glass"] * 0.6 + cand_res["glass"]["solid"] * 0.8 + cand_res["glass"]["floor"] * 0.8
                    best_g = best_res["glass"]["all"] * 1.5 + best_res["glass"]["glass"] * 0.6 + best_res["glass"]["solid"] * 0.8 + best_res["glass"]["floor"] * 0.8
                    if cand_g < best_g - 1e-4:
                        best_p = cand_p
                        best_res["glass"] = cand_res["glass"]
                        improved = True
                        break
                if improved:
                    print(f"  [glass round {round_i+1} param {idx}] glass all={best_res['glass']['all']:.3f} glass={best_res['glass']['glass']:.3f} solid={best_res['glass']['solid']:.3f} floor={best_res['glass']['floor']:.3f} ({time.time()-t0:.1f}s)", flush=True)

        best_blob = make_structured_weights(best_p)
        final_res = ev.eval_weights(best_blob, tmp)
        print("\n=== FINAL TRAINED METAL M1 NEURAL SHADER vs BASELINE ===", flush=True)
        print(f"Baseline: calib all={base['calib']['all']:.3f} (bricks={base['calib']['bricks']:.3f}, floor={base['calib']['floor']:.3f}) | "
              f"glass all={base['glass']['all']:.3f} (glass={base['glass']['glass']:.3f}, solid={base['glass']['solid']:.3f}, floor={base['glass']['floor']:.3f})", flush=True)
        print(f"Trained:  calib all={final_res['calib']['all']:.3f} (bricks={final_res['calib']['bricks']:.3f}, floor={final_res['calib']['floor']:.3f}) | "
              f"glass all={final_res['glass']['all']:.3f} (glass={final_res['glass']['glass']:.3f}, solid={final_res['glass']['solid']:.3f}, floor={final_res['glass']['floor']:.3f})", flush=True)

        export_header(best_blob, Path(args.out_header))


if __name__ == "__main__":
    main()
