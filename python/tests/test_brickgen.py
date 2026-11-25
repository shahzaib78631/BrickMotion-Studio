"""End-to-end tests for BrickGen (native C++ bridge, CLIP, geometry, model, training, and zero-overlap generation)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest
import torch

PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from brickgen.blueprint import (  # noqa: E402
    BP_G,
    BlueprintProgressTracker,
    blueprint_flip_x,
    blueprint_rot_yaw90,
    compute_blueprint_scale,
    compute_causal_frontier_features,
    rasterize_blueprint,
    render_blueprint_preview,
    stb_20_to_blueprint16,
)
from brickgen.clip_encoder import ClipEncoder  # noqa: E402
from brickgen.corpus import build_corpus  # noqa: E402
from brickgen.generate import BrickGenerator  # noqa: E402
from brickgen.geometry import (  # noqa: E402
    ROT24,
    augment_mirror_x_arrays,
    augment_yaw90_arrays,
    canonicalize_poses,
    connected_bottom_up_order,
    ldraw_bbox_to_yup,
    mirror_matrix_x,
    nearest_rot24,
    quantize_abs,
    quantize_rel,
    rotmat_to_6d,
)
from brickgen.model import PART_OFFSET, BrickGen, BrickGenConfig  # noqa: E402
from brickgen.native import BrickGenNative  # noqa: E402
from brickgen.train import BrickCorpusSplit, auto_device, train  # noqa: E402
from brickgen.train_blueprint import train_blueprint  # noqa: E402


@pytest.fixture(scope="module")
def native_engine():
    eng = BrickGenNative(use_studio=True)
    yield eng
    eng.close()


@pytest.fixture(scope="module")
def clip_enc():
    return ClipEncoder(device=auto_device(), load_vision=False)


def test_native_incremental_add_pop_and_collision_filter(native_engine: BrickGenNative):
    native_engine.reset()
    native_engine.add("3001.dat", 4, np.eye(4))
    assert native_engine.size() == 1
    assert native_engine.hits("3001.dat", np.eye(4))

    cands = native_engine.candidates("3001.dat", hosts=[0], fine_angles=False, filter_collisions=True)
    assert len(cands["matrices"]) >= 16
    # Verify every returned candidate is truly collision-free
    for m in cands["matrices"][:10]:
        assert not native_engine.hits("3001.dat", m)

    native_engine.add("3001.dat", 1, cands["matrices"][0])
    chk = native_engine.check()
    assert chk.pieces == 2
    assert chk.overlaps == 0
    assert chk.groups == 1
    assert chk.stands

    assert native_engine.pop()
    assert native_engine.size() == 1


def test_native_loads_moc_io_and_canonicalizes(native_engine: BrickGenNative):
    moc_path = Path("/Users/mac/Projects/BrickMotion-Data/MOC/Cinder_Scout_4x4.io")
    if not moc_path.exists():
        pytest.skip("MOC file absent")
    data = native_engine.load_model(moc_path)
    assert data["ok"] and data["n_pieces"] > 50 and len(data["edges"]) > 50

    mats = np.array([p["matrix"] for p in data["pieces"]], dtype=np.float64).reshape(-1, 4, 4)
    lb = np.array([p["local_bbox"] for p in data["pieces"]], dtype=np.float32)
    cmats, wb_ld = canonicalize_poses(mats, lb, force_upright=True)
    wb_yup = ldraw_bbox_to_yup(wb_ld)
    pos_yup = np.stack([cmats[:, 0, 3], -cmats[:, 1, 3], cmats[:, 2, 3]], axis=-1)
    edges = [(int(e[0]), int(e[1]), float(e[3])) for e in data["edges"]]
    order, parents = connected_bottom_up_order(len(mats), edges, wb_yup, pos_yup)

    assert abs(float(wb_yup[:, 1].min())) < 1e-3
    assert len(order) >= 50
    assert parents[0] == -1
    assert all(0 <= p < i for i, p in enumerate(parents[1:], start=1))


def test_yaw90_augmentation_group_property():
    rng = np.random.default_rng(7)
    n = 12
    xyz = rng.uniform(-100, 100, size=(n, 3)).astype(np.float32)
    xyz[:, 1] = np.abs(xyz[:, 1])
    r24 = rng.integers(0, 24, size=(n,), dtype=np.int32)
    r6 = rotmat_to_6d(ROT24[r24])
    bbox = np.concatenate([xyz - 10, xyz + 10], axis=-1).astype(np.float32)

    x1, r1, r6_1, b1 = augment_yaw90_arrays(xyz, r24, r6, bbox, 1)
    x2, r2, r6_2, b2 = augment_yaw90_arrays(x1, r1, r6_1, b1, 1)
    x3, r3, r6_3, b3 = augment_yaw90_arrays(x2, r2, r6_2, b2, 1)
    x4, r4, r6_4, b4 = augment_yaw90_arrays(x3, r3, r6_3, b3, 1)

    assert np.allclose(xyz, x4, atol=1e-4)
    assert np.array_equal(r24, r4)
    assert np.allclose(r6, r6_4, atol=1e-4)
    assert np.allclose(bbox, b4, atol=1e-4)

    # Exact X-mirror involution: mirror(mirror(x)) == x and det(R') == +1
    p_idx = np.arange(n, dtype=np.int64)
    table = np.arange(n, dtype=np.int64)
    table[0], table[1] = 1, 0  # chiral pair swap
    p1, mx1, mr1, mr6_1, mb1 = augment_mirror_x_arrays(p_idx, xyz, r24, r6, bbox, table)
    p2, mx2, mr2, mr6_2, mb2 = augment_mirror_x_arrays(p1, mx1, mr1, mr6_1, mb1, table)
    assert np.array_equal(p_idx, p2)
    assert np.allclose(xyz, mx2, atol=1e-4)
    assert np.array_equal(r24, mr2)
    assert np.allclose(r6, mr6_2, atol=1e-4)
    assert np.allclose(bbox, mb2, atol=1e-4)
    for r in ROT24:
        m = np.eye(4)
        m[:3, :3] = r
        m[:3, 3] = [40.0, -24.0, 20.0]
        mm = mirror_matrix_x(m)
        assert abs(np.linalg.det(mm[:3, :3]) - 1.0) < 1e-6
        assert np.allclose(mirror_matrix_x(mm), m, atol=1e-6)


def test_clip_matches_bricknet_reference(clip_enc: ClipEncoder):
    cap_file = Path("/Users/mac/Projects/BrickMotion-Data/bricknet/captions_sft.jsonl")
    ref_file = Path("/Users/mac/Projects/BrickMotion-Data/bricknet/captions_sft_clip.npy")
    if not cap_file.exists() or not ref_file.exists():
        pytest.skip("BrickNet CLIP reference absent")
    caps = [json.loads(l)["caption"] for l in cap_file.open()][:16]
    ref = np.load(ref_file, mmap_mode="r")[:16].astype(np.float32)
    ref = ref / np.maximum(np.linalg.norm(ref, axis=-1, keepdims=True), 1e-8)
    toks, pooled = clip_enc.encode_texts(caps)
    assert toks.shape == (16, 77, 512)
    cos = (pooled * ref).sum(axis=-1)
    assert float(cos.min()) > 0.999


def test_blueprint_equivariance_frontier_and_integral_scoring(tmp_path: Path):
    """Verify exact 3D blueprint augmentation equivariance, causal frontier parity, and integral-volume scoring."""
    lut = np.array(
        [
            [0.0, 0.0, 0.0, 0.0],
            [0.8, 0.1, 0.1, 0.0],  # red
            [0.1, 0.1, 0.2, 0.0],  # black
            [0.9, 0.95, 1.0, 1.0], # clear glass
        ],
        dtype=np.float32,
    )
    # Asymmetric L-shaped cluster so yaw90 & X-mirror are strictly nontrivial!
    bboxes = np.array(
        [
            [-40.0, 0.0, -60.0, 20.0, 24.0, 40.0],
            [20.0, 0.0, 0.0, 60.0, 24.0, 60.0],
            [-20.0, 24.0, -20.0, 40.0, 72.0, 40.0],
        ],
        dtype=np.float32,
    )
    cids = np.array([1, 2, 3], dtype=np.int64)
    xyz = 0.5 * (bboxes[:, :3] + bboxes[:, 3:6])
    r24 = np.array([0, 1, 2], dtype=np.int64)
    r6 = rotmat_to_6d(ROT24[r24])
    p_idx = np.arange(3, dtype=np.int64)

    g0, sv0 = rasterize_blueprint(bboxes, cids, lut)
    assert g0.shape == (5, BP_G, BP_G, BP_G)
    assert g0[0].sum() > 10

    # 1. Exact X-mirror equivariance
    _, _, _, _, bb_m = augment_mirror_x_arrays(p_idx, xyz, r24, r6, bboxes)
    gm, svm = rasterize_blueprint(bb_m, cids, lut)
    assert np.allclose(gm, blueprint_flip_x(g0), atol=1e-5)
    assert np.allclose(svm, sv0, atol=1e-4)

    # 2. Exact 4-way 90° Y-yaw equivariance!
    for k in range(1, 4):
        _, _, _, bb_r = augment_yaw90_arrays(xyz, r24, r6, bboxes, k)
        gr, _ = rasterize_blueprint(bb_r, cids, lut)
        assert np.allclose(gr, blueprint_rot_yaw90(g0, k), atol=1e-5), f"Mismatch at yaw k={k}"

    # 3. Causal frontier batch computation matches incremental push/pop tracker EXACTLY
    batch_fr = compute_causal_frontier_features(bboxes, g0, sv0)
    tracker = BlueprintProgressTracker(g0, sv0)
    assert np.allclose(batch_fr[0], tracker.current_feature(), atol=1e-5)
    for t in range(len(bboxes)):
        f_t = tracker.push(bboxes[t])
        assert np.allclose(batch_fr[t + 1], f_t, atol=1e-5)
    assert abs(tracker.covered_fraction - 1.0) < 1e-5
    assert abs(tracker.iou - 1.0) < 1e-5
    tracker.pop()
    assert np.allclose(batch_fr[-2], tracker.current_feature(last_box=tracker._stack[-1]), atol=1e-5)

    # 4. Integral-volume candidate scoring rewards uncovered inside-blueprint box & penalizes outside-blueprint spill
    cands_bb = np.array(
        [
            [-20.0, 24.0, -20.0, 40.0, 72.0, 40.0],   # exact uncovered glass brick!
            [-80.0, 100.0, -80.0, -40.0, 140.0, -40.0], # completely outside silhouette!
        ],
        dtype=np.float32,
    )
    gain, spill, col_sim = tracker.score_candidates(cands_bb, lut[3])
    _, _, col_sim_wrong = tracker.score_candidates(cands_bb, lut[1])
    assert gain[0] > 0.8 and spill[0] < 0.05 and col_sim[0] > 0.7 and col_sim[0] > col_sim_wrong[0] + 0.5
    assert gain[1] == 0.0 and spill[1] > 0.95

    # 5. StableText2Brick 20^3 -> canonical 16^3 conversion + preview PNG
    g20 = np.zeros((20, 20, 20), dtype=np.uint8)
    g20[4:14, 6:12, 0:5] = 1
    occ16, sv_stb = stb_20_to_blueprint16(g20)
    assert occ16.shape == (BP_G, BP_G, BP_G) and occ16.sum() > 20
    assert occ16[:, 0, :].any()  # grounded at iy = 0!
    assert sv_stb[2] >= sv_stb[0]  # longest horizontal axis aligned along Z!
    preview_p = tmp_path / "bp.png"
    render_blueprint_preview(g0, preview_p, size=64)
    assert preview_p.exists() and preview_p.stat().st_size > 1000


def test_end_to_end_tiny_corpus_overfit_and_zero_overlap_generate(tmp_path: Path):
    corpus_dir = tmp_path / "corpus"
    s1_dir = tmp_path / "run_s1"
    s2_dir = tmp_path / "run_s2"

    # Build tiny multi-source v3 corpus (BrickNet + OMR + MOC + STB blueprints)
    doc = build_corpus(
        out_dir=corpus_dir,
        max_parts=64,
        min_parts=4,
        max_vocab_parts=400,
        min_part_freq=1,
        limit_bricknet=60,
        limit_omr=8,
        limit_moc=4,
        include_stb=True,
    )
    assert doc["train_stats"]["models"] >= 30
    assert doc["val_stats"]["models"] >= 5
    assert "color_rgba" in doc and len(doc["color_rgba"]) == len(doc["colors"]) + 1

    # Stage 1: Smoke-train BlueprintFlow3D (Rectified Flow 3D DiT)
    s1_res = train_blueprint(
        corpus_dir=corpus_dir,
        out_dir=s1_dir,
        preset="small",
        steps=12,
        batch_size=8,
        lr=1e-3,
        eval_every=12,
        log_every=6,
    )
    bp_ckpt = Path(s1_res["export"])
    assert bp_ckpt.exists()

    # Stage 2: Smoke-train BrickGen v3 (3D Blueprint-Conditioned + Dual-CFG) and verify resume
    res1 = train(
        corpus_dir=corpus_dir,
        out_dir=s2_dir,
        preset="small",
        steps=20,
        batch_size=8,
        lr=1e-3,
        eval_every=20,
        log_every=20,
        max_bricks=64,
        use_blueprint=True,
    )
    assert Path(res1["export"]).exists()

    res2 = train(
        corpus_dir=corpus_dir,
        out_dir=s2_dir,
        preset="small",
        steps=32,
        batch_size=8,
        lr=1e-3,
        eval_every=32,
        log_every=16,
        max_bricks=64,
        use_blueprint=True,
    )
    assert res2["step"] == 32

    # Generate a certified 2-stage (Stage-1 Blueprint -> Stage-2 BrickGen v3 + libbmcore) zero-overlap model!
    gen = BrickGenerator(s2_dir / "brickgen.pt", blueprint_ckpt=bp_ckpt, load_vision=False)
    # Check Stage-1 symmetric blueprint sampling produces exact X-symmetric occupancy
    g_sym, sc_sym, est_p = gen.sample_blueprint("a red LEGO sports car", symmetric=True, n_steps=8, seed=1)
    assert np.allclose(g_sym, blueprint_flip_x(g_sym), atol=1e-5)
    assert g_sym[0].sum() >= 8 and est_p >= 10

    out = gen.generate_one(
        prompt="a red LEGO sports car",
        style="moc",
        min_parts=10,
        max_parts=18,
        cfg_scale=2.0,
        cfg_shape=2.0,
        bp_grid=g_sym,
        bp_scale=sc_sym,
        seed=42,
    )
    assert out.check.pieces >= 10
    assert out.check.overlaps == 0
    assert out.check.groups == 1
    assert out.blueprint_iou is not None and out.blueprint_cov is not None
    ldr = out.to_ldr("smoke_car")
    assert "1 " in ldr and "BrickNet" in ldr

    # Verify text-only fallback ALSO works cleanly on a v3 checkpoint (bp_grid=None)!
    gen_txt = BrickGenerator(s2_dir / "brickgen.pt", blueprint_ckpt=None, load_vision=False)
    out_txt = gen_txt.generate_one(
        prompt="a red LEGO sports car",
        style="moc",
        min_parts=8,
        max_parts=14,
        cfg_scale=2.0,
        seed=7,
    )
    assert out_txt.check.pieces >= 8
    assert out_txt.check.overlaps == 0
    assert out_txt.check.groups == 1
