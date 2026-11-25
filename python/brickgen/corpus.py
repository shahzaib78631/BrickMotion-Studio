"""Unified native corpus builder for BrickGen: BrickNet + OMR + MOC + BrickHeadz.

Extracts all four LEGO model sources through BrickGenNative (libbmcore) into ONE
canonicalized, connected bottom-to-top 3D pose dataset stored compactly (~50-80 MB)
in /Users/mac/Projects/BrickMotion-Data/brickgen/corpus/.

Attribution:
  - BrickNet dataset (Kulits & Schmid, CVPR 2026; research use)
  - LDraw Official Model Repository (OMR, CC BY 2.0 / 4.0, models by their OMR authors)
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from .blueprint import BP_G, load_ldraw_color_rgba, stb_20_to_blueprint16
from .clip_encoder import ClipBpeTokenizer, find_clip_snapshot
from .geometry import (
    canonicalize_poses,
    connected_bottom_up_order,
    ldraw_bbox_to_yup,
    nearest_rot24,
    rotmat_to_6d,
)
from .native import BrickGenNative

DATA_ROOT = Path("/Users/mac/Projects/BrickMotion-Data")
REPO_ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = REPO_ROOT / "public/data/catalog.json"
PART_FUNCS_PATH = REPO_ROOT / "public/data/part-functions.json"
BRICKNET_DIR = DATA_ROOT / "bricknet"
OMR_DIR = DATA_ROOT / "omr"
MOC_DIR = DATA_ROOT / "MOC"
BRICKHEADZ_DIR = DATA_ROOT / "ldraw_brickheadz"
DEFAULT_OUT = DATA_ROOT / "brickgen" / "corpus"

SOURCE_IDS = {"any": 0, "bricknet": 1, "omr": 2, "moc": 3, "brickheadz": 4}
PATTERN_RE = re.compile(r"^([0-9]+[a-z]?)(?:p[0-9a-z]+|d[0-9a-z]+|c[0-9a-z]+)$", re.IGNORECASE)
ANONYMOUS_SUB_RE = re.compile(
    r"(?:^|[\s/_-])(step|sub|submodel|part|section|bag|book|bk|minifig|fig)\s*\d*\b",
    re.IGNORECASE,
)
TRANS_COLORS = {33, 34, 36, 40, 41, 42, 43, 44, 46, 47, 52, 54, 57}

# Basic LDraw color names for rich natural-language captions on OMR/MOC/BrickHeadz
FALLBACK_COLOR_NAMES = {
    0: "black", 1: "blue", 2: "green", 3: "dark turquoise", 4: "red", 5: "dark pink",
    6: "brown", 7: "light gray", 8: "dark gray", 9: "light blue", 10: "bright green",
    11: "light turquoise", 14: "yellow", 15: "white", 16: "gray", 19: "tan",
    22: "purple", 25: "orange", 26: "magenta", 27: "lime", 28: "dark tan",
    29: "bright pink", 33: "translucent dark blue", 36: "translucent red",
    40: "translucent black", 41: "translucent light blue", 42: "translucent neon green",
    46: "translucent yellow", 47: "clear", 57: "translucent orange",
    70: "reddish brown", 71: "light bluish gray", 72: "dark bluish gray",
    73: "medium blue", 74: "medium green", 84: "medium dark flesh", 85: "dark purple",
    191: "flame yellowish orange", 212: "bright light blue", 226: "bright light yellow",
    272: "dark blue", 288: "dark green", 297: "pearl gold", 308: "dark brown",
    320: "dark red", 321: "dark azure", 322: "medium azure", 323: "light aqua",
    326: "yellowish green", 330: "olive green", 378: "sand green", 379: "sand blue",
    484: "dark orange",
}


def load_color_names() -> dict[int, str]:
    names = dict(FALLBACK_COLOR_NAMES)
    cn_path = BRICKNET_DIR / "color_names.json"
    if cn_path.exists():
        raw = json.loads(cn_path.read_text())
        if isinstance(raw, dict):
            for k, v in raw.items():
                try:
                    names[int(k)] = str(v).lower().replace("_", " ")
                except ValueError:
                    pass
    return names


def strip_stem(part_name: str) -> str:
    s = part_name.strip().lower().replace("\\", "/").rsplit("/", 1)[-1]
    return s[:-4] if s.endswith(".dat") else s


def base_mold_fallback(stem: str, allowed: set[str]) -> str | None:
    """If a patterned/printed part stem isn't in vocab, map to its unprinted base mold if present."""
    if stem in allowed:
        return stem
    m = PATTERN_RE.match(stem)
    if m and m.group(1) in allowed:
        return m.group(1)
    # Also try stripping trailing 'p...' or 'c...'
    for sep in ("p", "d"):
        idx = stem.find(sep)
        if idx >= 3 and stem[:idx] in allowed:
            return stem[:idx]
    return None


def describe_colors(colors: list[int], color_names: dict[int, str], top_k: int = 3) -> str:
    cnt = Counter(colors)
    picks = []
    for c, _ in cnt.most_common(top_k + 2):
        name = color_names.get(int(c))
        if name and name not in picks:
            picks.append(name)
        if len(picks) >= top_k:
            break
    if not picks:
        return "multicolored"
    if len(picks) == 1:
        return picks[0]
    if len(picks) == 2:
        return f"{picks[0]} and {picks[1]}"
    return f"{picks[0]}, {picks[1]}, and {picks[2]}"


def clean_filename_title(stem: str) -> str:
    s = re.sub(r"^MOC-\d+[_-]*", "", stem, flags=re.I)
    s = re.sub(r"[_-]+", " ", s)
    s = re.sub(r"\b(instruction|instructions|studio file|final|submodel build|v\d+|alt build|current chassis)\b", "", s, flags=re.I)
    s = re.sub(r"\s+", " ", s).strip()
    return s or stem


def load_part_catalog() -> tuple[dict[str, tuple[str, str]], dict[str, dict]]:
    """Load (stem -> (name, category)) from public/data/catalog.json and functional metadata from part-functions.json."""
    cat_map: dict[str, tuple[str, str]] = {}
    if CATALOG_PATH.exists():
        try:
            for item in json.loads(CATALOG_PATH.read_text()):
                pid = str(item.get("id", "")).lower()
                if pid:
                    cat_map[pid] = (str(item.get("name", "")), str(item.get("category", "")))
        except Exception:
            pass
    pf_map: dict[str, dict] = {}
    if PART_FUNCS_PATH.exists():
        try:
            pf_map = json.loads(PART_FUNCS_PATH.read_text()).get("parts", {})
        except Exception:
            pass
    return cat_map, pf_map


def describe_part_features(
    stems: list[str],
    colors: list[int],
    cat_map: dict[str, tuple[str, str]],
    pf_map: dict[str, dict],
) -> list[str]:
    """Mine accurate BrickNet-style structural feature phrases from a model's real LDraw parts."""
    counts: Counter[str] = Counter()
    for s, col in zip(stems, colors):
        name, category = cat_map.get(s, ("", ""))
        nl = name.lower()
        cl = category.lower()
        pf = pf_map.get(s, {})
        if "wheel" in cl or "tyre" in cl or "tire" in nl or "wheel" in nl:
            counts["wheels"] += 1
        if "windscreen" in cl or "windscreen" in nl or "windshield" in nl or "canopy" in nl:
            counts["windshield"] += 1
        if "window" in cl or "window" in nl or "glass" in nl:
            counts["windows"] += 1
        if "door" in nl or "gate" in nl:
            counts["doors"] += 1
        if "slope" in cl or "slope" in nl:
            counts["slopes"] += 1
        if "wedge" in nl or "wing" in nl:
            counts["wings"] += 1
        if "arch" in nl:
            counts["arches"] += 1
        if "steering" in nl:
            counts["steering"] += 1
        if "seat" in nl or "chair" in nl:
            counts["seats"] += 1
        if "baseplate" in cl or "baseplate" in nl:
            counts["baseplate"] += 1
        if "tile" in cl or nl.startswith("tile"):
            counts["tiles"] += 1
        if "technic" in cl or pf.get("teeth"):
            counts["technic"] += 1
        if "hinge" in nl or "turntable" in nl:
            counts["hinges"] += 1
        if "mudguard" in nl or "fender" in nl:
            counts["mudguards"] += 1
        if "propeller" in nl or "rotor" in nl:
            counts["propeller"] += 1
        if "plant" in nl or "leaf" in nl or "tree" in nl or "flower" in nl:
            counts["foliage"] += 1
        if int(col) in TRANS_COLORS:
            counts["lights"] += 1

    feats: list[str] = []
    if counts["wheels"] >= 2:
        feats.append("four wheels and tires" if counts["wheels"] >= 4 else "wheels and tires")
    if counts["windshield"] >= 1:
        feats.append("a clear windshield")
    if counts["steering"] >= 1 or counts["seats"] >= 1:
        feats.append("a cockpit interior")
    if counts["mudguards"] >= 2:
        feats.append("wheel arches")
    if counts["wings"] >= 2:
        feats.append("angled wings and wedge plates")
    if counts["propeller"] >= 1:
        feats.append("a spinning rotor")
    if counts["windows"] >= 1 and counts["doors"] >= 1:
        feats.append("windows and doors")
    elif counts["windows"] >= 1:
        feats.append("windows")
    elif counts["doors"] >= 1:
        feats.append("a doorway")
    if counts["arches"] >= 1:
        feats.append("arched architectural details")
    if counts["slopes"] >= 4:
        feats.append("sloped and angled surfaces")
    if counts["tiles"] >= 6:
        feats.append("smooth tiled finishing")
    if counts["technic"] >= 6:
        feats.append("Technic beams and mechanical joints")
    if counts["lights"] >= 2:
        feats.append("translucent light accents")
    if counts["baseplate"] >= 1:
        feats.append("a flat baseplate")
    if counts["foliage"] >= 2:
        feats.append("plant and foliage details")
    return feats[:5]


def describe_spatial_zones(
    ord_bbox: np.ndarray,
    ord_colors: list[int],
    color_names: dict[int, str],
) -> tuple[str, str]:
    """Derive symmetry/proportion descriptors and bottom/middle/top vertical color-zone clause from 3D geometry."""
    lo = ord_bbox[:, 0:3].min(0)
    hi = ord_bbox[:, 3:6].max(0)
    span = np.maximum(hi - lo, 16.0)
    wx, wy, wz = float(span[0] / 20.0), float(span[1] / 24.0), float(span[2] / 20.0)
    # Detect bilateral X-symmetry from bounding balance and L/R counts
    cx_bal = abs(float(lo[0] + hi[0])) <= 22.0
    mids_x = 0.5 * (ord_bbox[:, 0] + ord_bbox[:, 3])
    n_l = int((mids_x < -12.0).sum())
    n_r = int((mids_x > 12.0).sum())
    is_sym = cx_bal and (n_l + n_r >= 4) and (abs(n_l - n_r) <= max(2, int(0.18 * (n_l + n_r))))

    if wy > max(wx, wz) * 1.35:
        prop = "tall vertical"
    elif wz > max(wx, wy) * 1.55 and wy < wz * 0.65:
        prop = "long, low-profile"
    elif max(wx, wz) > wy * 1.65:
        prop = "wide and low"
    else:
        prop = "compact"
    shape_desc = f"symmetrical {prop}" if is_sym else prop

    # Vertical color-zoning (lower base / main body / upper top)
    mids_y = 0.5 * (ord_bbox[:, 1] + ord_bbox[:, 4])
    y0, y1 = float(lo[1]), float(hi[1])
    h = max(y1 - y0, 1.0)
    cols_arr = np.asarray(ord_colors, dtype=np.int32)
    b_cols = cols_arr[mids_y < y0 + h * 0.34].tolist()
    m_cols = cols_arr[(mids_y >= y0 + h * 0.34) & (mids_y < y0 + h * 0.72)].tolist()
    t_cols = cols_arr[mids_y >= y0 + h * 0.72].tolist()
    parts = []
    if b_cols:
        parts.append(f"a {describe_colors(b_cols, color_names, top_k=2)} lower base")
    if m_cols:
        parts.append(f"a {describe_colors(m_cols, color_names, top_k=2)} main body")
    if t_cols:
        parts.append(f"a {describe_colors(t_cols, color_names, top_k=2)} upper section")
    zone_clause = f" with {', '.join(parts)}" if len(parts) >= 2 else ""
    return shape_desc, zone_clause


def build_verified_mirror_tables(
    parts_vocab: list[str],
    bboxes_vocab: list[list[float]],
    cat_map: dict[str, tuple[str, str]],
) -> tuple[dict[str, str], list[bool]]:
    """Build exact L/R chiral mirror map and per-part X-mirror-safety flags verified against libbmcore bboxes."""
    idx_of = {s: i for i, s in enumerate(parts_vocab)}
    by_norm: dict[str, dict[str, str]] = {}
    for s in parts_vocab:
        name, _ = cat_map.get(s, ("", ""))
        nl = name.lower()
        if " left" not in nl and " right" not in nl:
            continue
        key = re.sub(r"\b(left|right)\b", "<SIDE>", nl)
        side = "L" if " left" in nl else "R"
        by_norm.setdefault(key, {})[side] = s

    cand_pairs = [(v["L"], v["R"]) for v in by_norm.values() if "L" in v and "R" in v]
    cand_pairs.extend([
        ("24299", "24307"), ("43723", "43722"), ("43723a", "43722a"),
        ("41770", "41769"), ("41770a", "41769a"), ("54384", "54383"),
        ("48208", "48205"), ("47397", "47398"), ("5091", "5092"),
        ("30355", "30356"), ("43710", "43711"), ("41748", "41747"),
        ("41764", "41765"), ("6564", "6565"), ("29119", "29120"),
    ])

    mirror_map: dict[str, str] = {}
    for a, b in cand_pairs:
        if a not in idx_of or b not in idx_of or a == b:
            continue
        ba = np.array(bboxes_vocab[idx_of[a]], dtype=np.float32)
        bb = np.array(bboxes_vocab[idx_of[b]], dtype=np.float32)
        # Verify exact X-reflection geometry: [-max_x_a, -min_x_a] == [min_x_b, max_x_b]
        if np.allclose([-ba[3], -ba[0]], [bb[0], bb[3]], atol=2.0) and np.allclose(ba[[1, 2, 4, 5]], bb[[1, 2, 4, 5]], atol=2.0):
            mirror_map[a] = b
            mirror_map[b] = a

    mirror_ok: list[bool] = []
    for s, bb in zip(parts_vocab, bboxes_vocab):
        if s in mirror_map:
            mirror_ok.append(True)
        else:
            name = cat_map.get(s, ("", ""))[0].lower()
            is_chiral_name = (" left" in name) or (" right" in name)
            # X-symmetric if min_x ≈ -max_x and not labeled chiral left/right
            x_sym = (not is_chiral_name) and (abs(float(bb[0]) + float(bb[3])) <= 1.5)
            mirror_ok.append(bool(x_sym))
    return mirror_map, mirror_ok


def load_omr_metadata() -> dict[str, tuple[str, str, str]]:
    """Map set_num -> (set_name, theme_name, year)."""
    themes: dict[int, str] = {}
    t_path = OMR_DIR / "themes.csv"
    if t_path.exists():
        with t_path.open(newline="", encoding="utf-8", errors="replace") as f:
            for r in csv.DictReader(f):
                try:
                    themes[int(r["id"])] = r["name"].strip()
                except Exception:
                    pass
    sets_meta: dict[str, tuple[str, str, str]] = {}
    s_path = OMR_DIR / "sets.csv"
    if s_path.exists():
        with s_path.open(newline="", encoding="utf-8", errors="replace") as f:
            for r in csv.DictReader(f):
                num = r.get("set_num", "").strip()
                if num:
                    th = themes.get(int(r["theme_id"]), "") if r.get("theme_id", "").isdigit() else ""
                    sets_meta[num] = (r.get("name", "").strip(), th, r.get("year", "").strip())
    # Supplement from OMR index.jsonl
    idx_path = OMR_DIR / "index.jsonl"
    if idx_path.exists():
        for line in idx_path.read_text(errors="ignore").splitlines():
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
                num = str(rec.get("number") or "").strip()
                if num and num not in sets_meta:
                    sets_meta[num] = (str(rec.get("name") or num).strip(), "LEGO", "")
            except Exception:
                pass
    return sets_meta


def _extract_native_records(
    eng: BrickGenNative,
    files: list[tuple[Path, str, list[str]]],
    source_name: str,
    max_parts: int,
    min_parts: int,
    color_names: dict[int, str],
    cat_map: dict[str, tuple[str, str]],
    pf_map: dict[str, dict],
) -> list[dict]:
    """Load real .mpd/.ldr/.io files through libbmcore, extracting whole models + named submodels."""
    records: list[dict] = []
    t0 = time.time()
    for fi, (path, title, base_captions) in enumerate(files):
        data = eng.load_model(path, check_overlaps=False, check_stability=False)
        if not data.get("ok") or data.get("n_pieces", 0) < min_parts:
            continue
        pieces = data["pieces"]
        n = len(pieces)
        all_edges = [(int(e[0]), int(e[1]), float(e[3])) for e in data.get("edges", [])]

        def _make_record(idxs: list[int], sub_label: str | None) -> dict | None:
            if len(idxs) < min_parts:
                return None
            idx_map = {orig: new for new, orig in enumerate(idxs)}
            sub_edges = [(idx_map[u], idx_map[v], w) for u, v, w in all_edges if u in idx_map and v in idx_map]
            if not sub_edges:
                return None
            stems = [strip_stem(pieces[i]["part"]) for i in idxs]
            colors = [int(pieces[i]["color"]) for i in idxs]
            mats = np.array([pieces[i]["matrix"] for i in idxs], dtype=np.float64).reshape(-1, 4, 4)
            lb = np.array([pieces[i]["local_bbox"] for i in idxs], dtype=np.float32)

            cmats, wb_ld = canonicalize_poses(mats, lb, force_upright=True)
            wb_yup = ldraw_bbox_to_yup(wb_ld)
            pos_yup = np.stack([cmats[:, 0, 3], -cmats[:, 1, 3], cmats[:, 2, 3]], axis=-1)
            order, parents = connected_bottom_up_order(len(idxs), sub_edges, wb_yup, pos_yup)
            if len(order) < min_parts:
                return None
            truncated = False
            if len(order) > max_parts:
                order = order[:max_parts]
                parents = parents[:max_parts]
                truncated = True

            ord_stems = [stems[i] for i in order]
            ord_colors = [colors[i] for i in order]
            ord_pos = pos_yup[order].astype(np.float32)
            ord_R = cmats[order, :3, :3]
            ord_r24 = nearest_rot24(ord_R).astype(np.int8)
            ord_r6 = rotmat_to_6d(ord_R).astype(np.float32)
            ord_bbox = wb_yup[order].astype(np.float32)

            col_desc = describe_colors(ord_colors, color_names)
            span = ord_bbox[:, 3:6].max(0) - ord_bbox[:, 0:3].min(0)
            wx, wy, wz = int(round(span[0] / 20)), int(round(span[1] / 24)), int(round(span[2] / 20))
            size_tag = f"{wx}x{wz} studs, {wy} bricks tall"
            shape_desc, zone_clause = describe_spatial_zones(ord_bbox, ord_colors, color_names)
            feats = describe_part_features(ord_stems, ord_colors, cat_map, pf_map)
            feat_clause = f", featuring {', '.join(feats)}" if feats else ""
            caps = []
            if sub_label:
                clean_sub = clean_filename_title(sub_label.removesuffix(".ldr").removesuffix(".dat"))
                caps.append(f"This LEGO model is a {shape_desc} {col_desc} {clean_sub} sub-assembly from {title}{zone_clause}{feat_clause}, made of {len(order)} pieces.")
                caps.append(f"A {shape_desc} {col_desc} LEGO {clean_sub} for {title}{feat_clause}.")
                caps.append(f"Detailed {col_desc} LEGO {clean_sub} ({source_name.upper()} style, {len(order)} parts).")
            else:
                suffix = " (lower structural base)" if truncated else ""
                for bc in base_captions:
                    caps.append(f"{bc}{suffix}, a {shape_desc} build in {col_desc}{zone_clause}{feat_clause} ({len(order)} pieces, {size_tag}).")
                caps.append(f"This is a {shape_desc}, {col_desc} LEGO {source_name.upper()} model of {title}{suffix}{feat_clause}.")
                if feats:
                    caps.append(f"A {shape_desc} {col_desc} LEGO {title}{suffix} with {', '.join(feats[:3])}.")

            return {
                "name": f"{source_name}:{path.stem}" + (f"/{sub_label}" if sub_label else ""),
                "source": SOURCE_IDS[source_name],
                "is_whole": sub_label is None,
                "stems": ord_stems,
                "colors": ord_colors,
                "parents": np.array(parents, dtype=np.int16),
                "xyz": ord_pos,
                "rot24": ord_r24,
                "rot6d": ord_r6,
                "bbox": ord_bbox,
                "captions": caps,
            }

        # 1. Whole model (or grounded bottom-up structural slice if > max_parts)
        whole = _make_record(list(range(n)), None)
        if whole is not None:
            records.append(whole)

        # 2. Named meaningful submodels for large/multi-submodel sets (skip anonymous step/sub/minifig noise!)
        sub_min = max(16, min_parts)
        if n > 48:
            by_sub: dict[str, list[int]] = defaultdict(list)
            for i, p in enumerate(pieces):
                pth = p.get("path") or []
                if pth:
                    by_sub[str(pth[-1])].append(i)
            for sub_name, sub_idxs in by_sub.items():
                if ANONYMOUS_SUB_RE.search(sub_name):
                    continue
                if sub_min <= len(sub_idxs) <= max_parts and len(sub_idxs) <= int(0.85 * n):
                    sub_rec = _make_record(sub_idxs, sub_name)
                    if sub_rec is not None:
                        records.append(sub_rec)

        if (fi + 1) % 100 == 0 or (fi + 1) == len(files):
            print(f"  [{source_name}] {fi + 1}/{len(files)} files -> {len(records)} models ({time.time() - t0:.1f}s)", flush=True)
    return records


def _extract_bricknet_split(
    split: str,
    eng: BrickGenNative,
    part_bboxes: dict[str, np.ndarray],
    max_parts: int,
    min_parts: int,
    limit: int | None = None,
) -> list[dict]:
    """Decode BrickNet split into canonical connected bottom-to-top records."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bricknet"))
    import decode  # noqa: E402

    t0 = time.time()
    cat = decode.Catalog(BRICKNET_DIR)
    arrs = decode.load(BRICKNET_DIR / f"{split}.npz")
    n_models = len(arrs["node_ptr"]) - 1
    if limit is not None:
        n_models = min(n_models, limit)

    # Load all captions grouped by model id
    caps_by_id: dict[int, list[str]] = defaultdict(list)
    cap_file = BRICKNET_DIR / f"captions_{split}.jsonl"
    if cap_file.exists():
        for line in cap_file.read_text(encoding="utf-8", errors="ignore").splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            caps_by_id[int(r["id"])].append(str(r["caption"]).strip())

    # Pre-cache local bboxes for every unique BrickNet stem used in this split
    used_pids = np.unique(arrs["part_ids"][: int(arrs["node_ptr"][n_models])])
    for pid in used_pids.tolist():
        stem = cat.stems[pid].lower()
        if stem not in part_bboxes:
            bbox, has_mesh, _ = eng.part_info(stem)
            part_bboxes[stem] = bbox if has_mesh else np.array([-10, -12, -10, 10, 12, 10], dtype=np.float32)

    records: list[dict] = []
    skipped = 0
    for i in range(n_models):
        pids, colors, edges = decode.model(arrs, i)
        if len(pids) < min_parts or not edges:
            skipped += 1
            continue
        try:
            real_order, real_poses = decode.realise(cat, pids, edges)
        except Exception:
            skipped += 1
            continue
        if len(real_order) < min_parts:
            skipped += 1
            continue

        idx_map = {orig: new for new, orig in enumerate(real_order)}
        sub_edges = [(idx_map[e[0]], idx_map[e[2]], 1.0) for e in edges if e[0] in idx_map and e[2] in idx_map]
        if not sub_edges:
            skipped += 1
            continue

        stems = [cat.stems[pids[u]].lower() for u in real_order]
        cols = [int(colors[u]) for u in real_order]
        mats = np.stack(real_poses, axis=0).astype(np.float64)
        lb = np.stack([part_bboxes[s] for s in stems], axis=0)

        cmats, wb_ld = canonicalize_poses(mats, lb, force_upright=True)
        wb_yup = ldraw_bbox_to_yup(wb_ld)
        pos_yup = np.stack([cmats[:, 0, 3], -cmats[:, 1, 3], cmats[:, 2, 3]], axis=-1)
        order, parents = connected_bottom_up_order(len(real_order), sub_edges, wb_yup, pos_yup)
        if len(order) < min_parts:
            skipped += 1
            continue
        if len(order) > max_parts:
            order = order[:max_parts]
            parents = parents[:max_parts]

        ord_R = cmats[order, :3, :3]
        caps = caps_by_id.get(i) or [f"A LEGO model with {len(order)} pieces."]
        records.append(
            {
                "name": f"bricknet:{split}_{i:05d}",
                "source": SOURCE_IDS["bricknet"],
                "is_whole": True,
                "stems": [stems[k] for k in order],
                "colors": [cols[k] for k in order],
                "parents": np.array(parents, dtype=np.int16),
                "xyz": pos_yup[order].astype(np.float32),
                "rot24": nearest_rot24(ord_R).astype(np.int8),
                "rot6d": rotmat_to_6d(ord_R).astype(np.float32),
                "bbox": wb_yup[order].astype(np.float32),
                "captions": caps,
            }
        )
        if (i + 1) % 10000 == 0 or (i + 1) == n_models:
            print(f"  [bricknet:{split}] {i + 1}/{n_models} -> {len(records)} kept, {skipped} skipped ({time.time() - t0:.1f}s)", flush=True)
    return records


def _pack_split(
    records: list[dict],
    part_to_id: dict[str, int],
    color_to_id: dict[int, int],
    allowed_parts: set[str],
    tokenizer: ClipBpeTokenizer,
    min_parts: int,
    out_npz: Path,
    out_meta: Path,
) -> dict:
    """Map stems/colors to dense vocab IDs, tokenize captions, and save compact compressed npz."""
    part_ids_all, color_ids_all, parents_all = [], [], []
    xyz_all, rot24_all, rot6d_all, bbox_all = [], [], [], []
    seq_ptr = [0]
    source_ids = []
    is_whole_list = []
    cap_ptr = [0]
    all_caps: list[str] = []
    meta = []
    dropped = 0
    fallback_hits = 0

    for rec in records:
        mapped_parts = []
        ok = True
        for s in rec["stems"]:
            fb = base_mold_fallback(s, allowed_parts)
            if fb is None:
                ok = False
                break
            if fb != s:
                fallback_hits += 1
            mapped_parts.append(part_to_id[fb])
        if not ok or len(mapped_parts) < min_parts:
            dropped += 1
            continue

        mapped_colors = [color_to_id.get(int(c), color_to_id.get(16, 1)) for c in rec["colors"]]
        part_ids_all.append(np.array(mapped_parts, dtype=np.int16))
        color_ids_all.append(np.array(mapped_colors, dtype=np.int16))
        parents_all.append(rec["parents"].astype(np.int16))
        xyz_all.append(rec["xyz"].astype(np.float16))
        rot24_all.append(rec["rot24"].astype(np.int8))
        rot6d_all.append(rec["rot6d"].astype(np.float16))
        bbox_all.append(rec["bbox"].astype(np.float16))
        seq_ptr.append(seq_ptr[-1] + len(mapped_parts))
        source_ids.append(rec["source"])
        is_whole_list.append(bool(rec.get("is_whole", True)))

        caps = rec["captions"]
        all_caps.extend(caps)
        cap_ptr.append(cap_ptr[-1] + len(caps))
        meta.append({"name": rec["name"], "source": int(rec["source"]), "is_whole": bool(rec.get("is_whole", True)), "n_parts": len(mapped_parts), "caption": caps[0]})

    if not part_ids_all:
        raise RuntimeError(f"No valid records left for {out_npz.name}")

    clip_ids, clip_lens = tokenizer.encode_batch(all_caps)
    np.savez_compressed(
        out_npz,
        part_id=np.concatenate(part_ids_all),
        color_id=np.concatenate(color_ids_all),
        parent=np.concatenate(parents_all),
        xyz=np.concatenate(xyz_all),
        rot24=np.concatenate(rot24_all),
        rot6d=np.concatenate(rot6d_all),
        bbox=np.concatenate(bbox_all),
        seq_ptr=np.array(seq_ptr, dtype=np.int64),
        source_id=np.array(source_ids, dtype=np.int8),
        is_whole=np.array(is_whole_list, dtype=bool),
        cap_ptr=np.array(cap_ptr, dtype=np.int64),
        clip_tokens=clip_ids.astype(np.uint16),
        clip_lengths=clip_lens.astype(np.int16),
    )
    out_meta.write_text(json.dumps(meta, indent=1))
    by_src = Counter(source_ids)
    return {
        "models": len(source_ids),
        "dropped_oov": dropped,
        "base_mold_fallbacks": fallback_hits,
        "placements": int(seq_ptr[-1]),
        "captions": len(all_caps),
        "by_source": {k: int(v) for k, v in sorted(by_src.items())},
        "size_mb": round(out_npz.stat().st_size / 1e6, 2),
    }


def _pack_stabletext2brick(out_npz: Path, tokenizer: ClipBpeTokenizer, limit: int | None = None) -> dict | None:
    """Convert pre-extracted StableText2Brick 20^3 shapes into canonical 16^3 bit-packed blueprints."""
    sdir = DATA_ROOT / "shape"
    occ_p, sp_p, cs_p, cap_p = sdir / "occ.npy", sdir / "split.npy", sdir / "caption_shape.npy", sdir / "captions.json"
    if not (occ_p.exists() and sp_p.exists() and cs_p.exists() and cap_p.exists()):
        return None
    t0 = time.time()
    occ_packed = np.load(occ_p)
    split = np.load(sp_p)
    cap_shape = np.load(cs_p)
    caps_all = json.loads(cap_p.read_text())

    n_shapes = len(occ_packed) if limit is None else min(len(occ_packed), limit)
    caps_by_shape: list[list[str]] = [[] for _ in range(n_shapes)]
    for cap, sid in zip(caps_all, cap_shape.tolist()):
        if sid < n_shapes:
            caps_by_shape[sid].append(str(cap).strip())

    occ_bits = np.zeros((n_shapes, (BP_G ** 3) // 8), dtype=np.uint8)
    scale_vecs = np.zeros((n_shapes, 4), dtype=np.float16)
    cap_ptr = [0]
    flat_caps: list[str] = []

    for i in range(n_shapes):
        g20 = np.unpackbits(occ_packed[i])[: 20 * 20 * 20].reshape(20, 20, 20)
        occ16, sv = stb_20_to_blueprint16(g20, g=BP_G)
        occ_bits[i] = np.packbits(occ16.reshape(-1))
        scale_vecs[i] = sv.astype(np.float16)
        scaps = caps_by_shape[i] or ["A LEGO brick model."]
        flat_caps.extend(scaps)
        cap_ptr.append(cap_ptr[-1] + len(scaps))
        if (i + 1) % 15000 == 0 or (i + 1) == n_shapes:
            print(f"  [stb_blueprints] {i + 1}/{n_shapes} shapes ({time.time() - t0:.1f}s)", flush=True)

    clip_ids, clip_lens = tokenizer.encode_batch(flat_caps)
    np.savez_compressed(
        out_npz,
        occ_bits=occ_bits,
        scale_vec=scale_vecs,
        split=split[:n_shapes].astype(np.int8),
        cap_ptr=np.array(cap_ptr, dtype=np.int64),
        clip_tokens=clip_ids.astype(np.uint16),
        clip_lengths=clip_lens.astype(np.int16),
    )
    return {
        "shapes": n_shapes,
        "captions": len(flat_caps),
        "size_mb": round(out_npz.stat().st_size / 1e6, 2),
    }


def build_corpus(
    out_dir: Path = DEFAULT_OUT,
    max_parts: int = 384,
    min_parts: int = 8,
    max_vocab_parts: int = 3500,
    min_part_freq: int = 3,
    limit_bricknet: int | None = None,
    limit_omr: int | None = None,
    limit_moc: int | None = None,
    include_stb: bool = True,
) -> dict:
    """Build the full unified canonical BrickNet + OMR + MOC + BrickHeadz corpus."""
    t_start = time.time()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    color_names = load_color_names()

    print("Initializing native C++ libbmcore engine...", flush=True)
    eng = BrickGenNative(use_studio=True)
    tokenizer = ClipBpeTokenizer(find_clip_snapshot())
    cat_map, pf_map = load_part_catalog()
    part_bboxes: dict[str, np.ndarray] = {}

    # 1. Gather OMR files
    omr_meta = load_omr_metadata()
    omr_files: list[tuple[Path, str, list[str]]] = []
    omr_models_dir = OMR_DIR / "models"
    if omr_models_dir.exists():
        for d in sorted(omr_models_dir.iterdir()):
            if not d.is_dir():
                continue
            set_num = d.name
            set_name, theme, year = omr_meta.get(set_num, (set_num, "LEGO", ""))
            # Pick main model file(s)
            candidates = sorted([f for f in d.iterdir() if f.suffix.lower() in (".mpd", ".ldr")])
            for f in candidates:
                is_b = "b-model" in f.name.lower() or "alt" in f.name.lower()
                title = f"{set_name} (alternate model)" if is_b else set_name
                th_str = f"LEGO {theme}" if theme and theme.lower() != "lego" else "LEGO"
                base_caps = [
                    f"This is an official {th_str} set: {title}",
                    f"A detailed {th_str} {title} model",
                ]
                omr_files.append((f, title, base_caps))
    if limit_omr is not None:
        omr_files = omr_files[:limit_omr]

    # 2. Gather MOC files (resolve official set numbers via omr_meta when present)
    moc_files: list[tuple[Path, str, list[str]]] = []
    if MOC_DIR.exists():
        for f in sorted(MOC_DIR.rglob("*")):
            if f.is_file() and f.suffix.lower() in (".io", ".mpd", ".ldr"):
                m_set = re.match(r"^(\d{4,6}-\d+)", f.stem)
                if m_set and m_set.group(1) in omr_meta:
                    title = omr_meta[m_set.group(1)][0]
                else:
                    title = clean_filename_title(f.stem)
                base_caps = [
                    f"This is a custom LEGO MOC build of {title}",
                    f"A detailed custom LEGO {title} MOC",
                ]
                moc_files.append((f, title, base_caps))
    if limit_moc is not None:
        moc_files = moc_files[:limit_moc]

    # 3. Gather BrickHeadz files (ldraw_brickheadz + extra top-level character folders, deduplicated)
    bh_files: list[tuple[Path, str, list[str]]] = []
    seen_bh_keys: set[str] = set()
    if BRICKHEADZ_DIR.exists():
        for f in sorted(BRICKHEADZ_DIR.rglob("*")):
            if f.is_file() and f.suffix.lower() in (".mpd", ".ldr"):
                title = clean_filename_title(re.sub(r"^\d+\s*-\s*", "", f.stem))
                key = re.sub(r"[^a-z0-9]+", "", title.lower())
                seen_bh_keys.add(key)
                m_num = re.match(r"^(\d{4,6})\b", f.stem)
                if m_num:
                    seen_bh_keys.add(m_num.group(1))
                base_caps = [
                    f"This is a LEGO BrickHeadz collectible character figure of {title}",
                    f"A LEGO BrickHeadz {title} character",
                ]
                bh_files.append((f, title, base_caps))
    # Scan extra top-level BrickHeadz folders directly under DATA_ROOT (e.g. Deadpool, Hellboy, Hulk)
    skip_dirs = {"bricknet", "omr", "moc", "ldraw_brickheadz", "brickgen", "shape", "shape2", "stabletext2brick", "kaggle", "kaggle-lab", "lab", "mepnet", "colab-brickgen", "colab-brickgen-v2", "colab-brickgen-v3"}
    if DATA_ROOT.exists():
        for sub in sorted(DATA_ROOT.iterdir()):
            if not sub.is_dir() or sub.name.lower() in skip_dirs or sub.name.startswith("colab-"):
                continue
            for f in sorted(sub.glob("*.mpd")) + sorted(sub.glob("*.ldr")):
                raw_name = sub.name if re.match(r"^\d+(?:-\d+)?$", f.stem) else f.stem
                title = clean_filename_title(re.sub(r"^\d+(?:-\d+)?\s*-\s*", "", raw_name))
                key = re.sub(r"[^a-z0-9]+", "", title.lower())
                m_num = re.match(r"^(\d{4,6})\b", sub.name)
                if key in seen_bh_keys or (m_num and m_num.group(1) in seen_bh_keys):
                    continue
                seen_bh_keys.add(key)
                if m_num:
                    seen_bh_keys.add(m_num.group(1))
                base_caps = [
                    f"This is a LEGO BrickHeadz collectible character figure of {title}",
                    f"A LEGO BrickHeadz {title} character",
                ]
                bh_files.append((f, title, base_caps))

    print(f"Found {len(omr_files)} OMR files, {len(moc_files)} MOC files, {len(bh_files)} BrickHeadz files.", flush=True)

    # Extract native sources with rich part-feature captions
    omr_recs = _extract_native_records(eng, omr_files, "omr", max_parts, min_parts, color_names, cat_map, pf_map)
    moc_recs = _extract_native_records(eng, moc_files, "moc", max_parts, min_parts, color_names, cat_map, pf_map)
    bh_recs = _extract_native_records(eng, bh_files, "brickheadz", max_parts, min_parts, color_names, cat_map, pf_map)

    # Extract BrickNet SFT + Val
    bn_train = _extract_bricknet_split("sft", eng, part_bboxes, max_parts, min_parts, limit=limit_bricknet)
    bn_val = _extract_bricknet_split("val", eng, part_bboxes, max_parts, min_parts, limit=min(512, limit_bricknet) if limit_bricknet else None)

    # Deterministic 90/10 train/val split for OMR, MOC, BrickHeadz (by model name hash)
    def _split_native(recs: list[dict]) -> tuple[list[dict], list[dict]]:
        tr, va = [], []
        for idx, r in enumerate(recs):
            if idx % 10 == 0 and len(recs) >= 10:
                va.append(r)
            else:
                tr.append(r)
        return tr, va

    omr_tr, omr_va = _split_native(omr_recs)
    moc_tr, moc_va = _split_native(moc_recs)
    bh_tr, bh_va = _split_native(bh_recs)

    train_recs = bn_train + omr_tr + moc_tr + bh_tr
    val_recs = bn_val + omr_va + moc_va + bh_va

    # Build unified part & color vocabularies from train_recs
    print("Building unified part & color vocabularies with native mesh/connector verification...", flush=True)
    part_counts = Counter()
    native_priority_parts = set()
    color_counts = Counter()
    for r in train_recs:
        part_counts.update(r["stems"])
        color_counts.update(r["colors"])
        if r["source"] != SOURCE_IDS["bricknet"]:
            native_priority_parts.update(r["stems"])

    # Verify mesh + connectors via native C++ engine
    valid_parts: list[str] = []
    valid_bboxes: list[list[float]] = []
    valid_conns: list[int] = []
    candidate_stems = [s for s, c in part_counts.most_common() if c >= min_part_freq or s in native_priority_parts]
    for s in candidate_stems:
        if len(valid_parts) >= max_vocab_parts and s not in native_priority_parts:
            continue
        bbox, has_mesh, n_conns = eng.part_info(s)
        if has_mesh and n_conns > 0:
            valid_parts.append(s)
            valid_bboxes.append([round(float(v), 3) for v in bbox.tolist()])
            valid_conns.append(n_conns)

    # Sort parts by frequency descending for clean indexing
    order_v = sorted(range(len(valid_parts)), key=lambda k: -part_counts[valid_parts[k]])
    parts_vocab = [valid_parts[k] for k in order_v]
    bboxes_vocab = [valid_bboxes[k] for k in order_v]
    conns_vocab = [valid_conns[k] for k in order_v]
    part_to_id = {s: i for i, s in enumerate(parts_vocab)}
    allowed_parts = set(parts_vocab)

    # Color vocab: 1..N (0 reserved for PAD) + exact LDConfig.ldr sRGB/translucency LUT
    colors_vocab = [int(c) for c, _ in color_counts.most_common(192)]
    if 16 not in colors_vocab:
        colors_vocab.append(16)
    color_to_id = {c: i + 1 for i, c in enumerate(colors_vocab)}
    rgba_map = load_ldraw_color_rgba()
    color_rgba = [[0.0, 0.0, 0.0, 0.0]] + [list(rgba_map.get(c, (0.62, 0.62, 0.62, 0.0))) for c in colors_vocab]

    mirror_map, mirror_ok = build_verified_mirror_tables(parts_vocab, bboxes_vocab, cat_map)
    print(
        f"Vocab built: {len(parts_vocab)} verified parts (with mesh+connectors), {len(colors_vocab)} colors, "
        f"{len(mirror_map)//2} verified L/R mirror pairs, {sum(mirror_ok)}/{len(mirror_ok)} X-mirror-safe.",
        flush=True,
    )

    # Pack splits
    train_stats = _pack_split(
        train_recs, part_to_id, color_to_id, allowed_parts, tokenizer, min_parts, out_dir / "train.npz", out_dir / "meta_train.json"
    )
    val_stats = _pack_split(
        val_recs, part_to_id, color_to_id, allowed_parts, tokenizer, min_parts, out_dir / "val.npz", out_dir / "meta_val.json"
    )
    stb_stats = None
    if include_stb:
        stb_limit = min(200, limit_bricknet) if limit_bricknet is not None else None
        stb_stats = _pack_stabletext2brick(out_dir / "stb_blueprints.npz", tokenizer, limit=stb_limit)

    vocab_doc = {
        "parts": parts_vocab,
        "part_bboxes": bboxes_vocab,
        "part_conns": conns_vocab,
        "mirror_map": mirror_map,
        "mirror_ok": mirror_ok,
        "colors": colors_vocab,
        "color_rgba": color_rgba,
        "color_names": {str(c): color_names.get(c, f"color {c}") for c in colors_vocab},
        "sources": SOURCE_IDS,
        "max_parts": max_parts,
        "min_parts": min_parts,
        "attribution": "BrickNet (Kulits & Schmid, CVPR 2026), LDraw OMR (CC BY 2.0/4.0), and StableText2Brick (MIT).",
        "train_stats": train_stats,
        "val_stats": val_stats,
        "stb_stats": stb_stats,
        "elapsed_sec": round(time.time() - t_start, 1),
    }
    (out_dir / "vocab.json").write_text(json.dumps(vocab_doc, indent=1))
    eng.close()
    print(f"Done in {vocab_doc['elapsed_sec']}s! Train: {train_stats} | Val: {val_stats} | STB: {stb_stats}", flush=True)
    return vocab_doc


def main() -> None:
    ap = argparse.ArgumentParser(description="Build unified BrickNet + OMR + MOC + BrickHeadz canonical corpus (v3).")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--max-parts", type=int, default=384)
    ap.add_argument("--min-parts", type=int, default=8)
    ap.add_argument("--max-vocab", type=int, default=3500)
    ap.add_argument("--limit-bricknet", type=int, default=None)
    ap.add_argument("--limit-omr", type=int, default=None)
    ap.add_argument("--limit-moc", type=int, default=None)
    ap.add_argument("--no-stb", action="store_true", help="Skip StableText2Brick 16^3 blueprint packing")
    a = ap.parse_args()
    build_corpus(
        out_dir=a.out,
        max_parts=a.max_parts,
        min_parts=a.min_parts,
        max_vocab_parts=a.max_vocab,
        limit_bricknet=a.limit_bricknet,
        limit_omr=a.limit_omr,
        limit_moc=a.limit_moc,
        include_stb=not a.no_stb,
    )


if __name__ == "__main__":
    main()
