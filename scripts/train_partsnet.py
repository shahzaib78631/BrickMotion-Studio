"""Train P5 PartsNet (python/booklet_mpd/solver/partsnet.py) strictly on eligible TRAIN booklets.

Usage:
    PYTHONPATH=python python/.venv/bin/python scripts/train_partsnet.py data --workers 6
    PYTHONPATH=python python/.venv/bin/python scripts/train_partsnet.py train --epochs 35
"""
from __future__ import annotations

import argparse
import concurrent.futures
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

DATA_PATH = ROOT / ".cache/booklet-mpd/partsnet-data.npz"
WEIGHT_PATH = ROOT / ".cache/booklet-mpd/partsnet-weight.txt"


def train_split_sets() -> tuple[list[str], list[str]]:
    """Strict zero-leakage split INSIDE `tuning_sets(grades())` ONLY.
    Never touches validation or test sets."""
    from booklet_mpd.protocol import tuning_sets
    from booklet_mpd.solver.bench import family
    from booklet_mpd.solver.dataset import grades, pairs

    avail = pairs()
    eligible = sorted(s for s in tuning_sets(grades()) if s in avail)
    studded = [s for s in eligible if family(s) == "studded"]
    technic = [s for s in eligible if family(s) == "technic"]
    inner_dev = sorted(studded[2::6] + technic[1::6])
    dev_set = set(inner_dev)
    inner_train = [s for s in eligible if s not in dev_set]
    return inner_train, inner_dev


def _extract_one(set_number: str) -> dict | None:
    """Extract inventory patches, NPR LDraw render patches, and labeled callout->inventory pairs
    for one eligible TRAIN booklet."""
    from assembly_model.ldraw import load_library
    from booklet_mpd.solver.dataset import cases, extract_of
    from booklet_mpd.solver.evaluate import same_colour, same_part
    from booklet_mpd.solver.parts import (
        _lab,
        _read,
        assign,
        describe,
        element_index,
        ldraw_part,
        rendered_part_images,
        resolve_element,
        similarity,
        size_ratio,
        step_callouts,
        template_score,
    )
    from booklet_mpd.solver.partsnet import PATCH, patch

    lib = load_library(str(ROOT / "public/ldraw"))
    index = element_index()
    try:
        data, folder = extract_of(set_number)
    except Exception:
        return None
    inventory = [e for e in data.get("inventory", []) if e.get("element")]
    if not inventory:
        return None

    inv_crops = [_read(folder, e.get("crop")) for e in inventory]
    inv_desc = [describe(img) for img in inv_crops]
    inv_pc: list[tuple[str, int] | None] = []
    inv_patches: list[np.ndarray] = []
    inv_valid: list[bool] = []
    render_patches: list[np.ndarray] = []
    render_inv_idx: list[int] = []

    for j, (e, crop, d) in enumerate(zip(inventory, inv_crops, inv_desc)):
        rec = resolve_element(e["element"], index, None)
        pt = ldraw_part(lib, rec)[0] if rec else None
        pc = (pt, int(rec["color"])) if (rec and pt) else None
        inv_pc.append(pc)
        if crop is not None and d is not None:
            inv_patches.append(patch(crop))
            inv_valid.append(True)
        else:
            inv_patches.append(np.full((PATCH, PATCH, 3), 255, np.uint8))
            inv_valid.append(False)
        if pc is not None and inv_valid[-1]:
            # Render 4 upright NPR views and keep the views that best match the printed art
            imgs = rendered_part_images(lib, pc[0], pc[1])
            for rimg in imgs:
                render_patches.append(patch(rimg))
                render_inv_idx.append(j)

    # Deduplicate callout crops by content hash
    groups: dict[str, list[tuple[int, int]]] = defaultdict(list)
    descs: dict[str, object] = {}
    pics: dict[str, np.ndarray] = {}
    for si, st in enumerate(data["steps"]):
        for ci, call in step_callouts(st):
            img = _read(folder, call.get("crop"))
            if img is None:
                continue
            k = f"{img.shape}:{hash(img.tobytes())}"
            groups[k].append((si, ci))
            if k not in descs:
                descs[k] = describe(img)
                pics[k] = img

    ratio = size_ratio(descs, inv_desc, 0.85) or 1.33

    # Source 1: Answer-key step supervision (exact 1-to-1 or low-ambiguity Hungarian alignment)
    labeled_keys: dict[str, tuple[int, int]] = {}  # key -> (inv_idx, source_priority: 2=omr, 1=self)
    try:
        all_cases = list(cases(set_number, with_images=False))
    except Exception:
        all_cases = []

    for c in all_cases:
        si = c.booklet_step
        if si >= len(data["steps"]):
            continue
        calls = step_callouts(data["steps"][si])
        if not calls:
            continue
        truth_counts: dict[tuple[str, int], int] = defaultdict(int)
        for tp, tc, _m in c.added:
            truth_counts[(tp, tc)] += 1
        # Resolve each truth (part, colour) to candidate inventory indices
        truth_items = []
        ok_all = True
        for (tp, tc), tcnt in truth_counts.items():
            matches = [j for j, pc in enumerate(inv_pc)
                       if inv_valid[j] and pc is not None and same_colour(pc[1], tc) and same_part(lib, pc[0], tp)]
            if not matches:
                ok_all = False
                break
            truth_items.append((matches, tcnt))
        if not ok_all:
            continue
        # Group callouts in this step by image hash
        step_groups: dict[str, int] = defaultdict(int)
        for ci, call in calls:
            img = _read(folder, call.get("crop"))
            if img is None:
                continue
            k = f"{img.shape}:{hash(img.tobytes())}"
            step_groups[k] += int(call.get("count", 1) or 1)
        if len(step_groups) != len(truth_items):
            continue
        g_keys = list(step_groups.keys())
        # Build score matrix between step's callout groups and step's truth items
        n = len(g_keys)
        S = np.full((n, n), -1e3, dtype=np.float64)
        best_j = np.full((n, n), -1, dtype=np.int32)
        for gi, k in enumerate(g_keys):
            dk = descs.get(k)
            if dk is None:
                continue
            for ti, (matches, tcnt) in enumerate(truth_items):
                if step_groups[k] != tcnt:
                    continue
                for j in matches:
                    s = similarity(dk, inv_desc[j], ratio)
                    ts = template_score(pics[k], inv_crops[j], ratio) if inv_crops[j] is not None else 0.0
                    comb = s + 0.5 * ts
                    if comb > S[gi, ti]:
                        S[gi, ti] = comb
                        best_j[gi, ti] = j
        row_ind, col_ind = linear_sum_assignment(-S)
        if any(S[r, col] < 0.35 or best_j[r, col] < 0 for r, col in zip(row_ind, col_ind)):
            continue
        # Verify count compatibility and margin on multi-item steps
        for r, col in zip(row_ind, col_ind):
            k = g_keys[r]
            j = int(best_j[r, col])
            if n == 1:
                labeled_keys[k] = (j, 2)
            else:
                # Require colour plausibility with the matched truth element (catches Grade B step-order shifts!)
                cd = float(np.linalg.norm(_lab(descs[k].colour) - _lab(inv_desc[j].colour)))
                if cd < 24.0 and S[r, col] >= 0.65:
                    labeled_keys[k] = (j, 2)

    # Source 2: High-confidence self-labeled pairs (pixel-verified LEGO art via template >= 0.90)
    counts_at = {(si, ci): int(call.get("count", 1) or 1)
                 for si, st in enumerate(data["steps"]) for ci, call in step_callouts(st)}
    totals = {k: sum(counts_at[si, ci] for si, ci in v) for k, v in groups.items()}
    asgn = assign(descs, totals, inv_desc, [int(e.get("count", 0) or 0) for e in inventory], ratio,
                  template=(pics, inv_crops), valid_crop=inv_valid)
    for k, (j, sc, margin) in asgn.items():
        if k in labeled_keys or not inv_valid[j] or descs.get(k) is None:
            continue
        cd = float(np.linalg.norm(_lab(descs[k].colour) - _lab(inv_desc[j].colour)))
        ts = template_score(pics[k], inv_crops[j], ratio) if inv_crops[j] is not None else 0.0
        if sc >= 0.85 and margin >= 0.07 and ts >= 0.88 and cd < 16.0:
            labeled_keys[k] = (j, 1)

    if not labeled_keys:
        return None

    call_patches = []
    call_targets = []
    call_sources = []
    for k, (j, src) in labeled_keys.items():
        call_patches.append(patch(pics[k]))
        call_targets.append(j)
        call_sources.append(src)

    return {
        "set": set_number,
        "inv_patches": np.stack(inv_patches),
        "inv_valid": np.array(inv_valid, dtype=bool),
        "call_patches": np.stack(call_patches),
        "call_targets": np.array(call_targets, dtype=np.int32),
        "call_sources": np.array(call_sources, dtype=np.int8),
        "render_patches": np.stack(render_patches) if render_patches else np.zeros((0, PATCH, PATCH, 3), np.uint8),
        "render_inv_idx": np.array(render_inv_idx, dtype=np.int32),
    }


def build_data(workers: int):
    inner_train, inner_dev = train_split_sets()
    all_sets = sorted(inner_train + inner_dev)
    print(f"Extracting PartsNet data from {len(all_sets)} eligible TRAIN sets ({len(inner_train)} inner_train, {len(inner_dev)} inner_dev)...", flush=True)
    t0 = time.time()
    with concurrent.futures.ProcessPoolExecutor(workers) as pool:
        results = list(pool.map(_extract_one, all_sets))

    inv_p, inv_v, inv_book = [], [], []
    call_p, call_t, call_s, call_book = [], [], [], []
    rend_p, rend_t, rend_book = [], [], []
    book_names = []

    for res in results:
        if res is None:
            continue
        bi = len(book_names)
        book_names.append(res["set"])
        n_inv = len(res["inv_patches"])
        inv_p.append(res["inv_patches"])
        inv_v.append(res["inv_valid"])
        inv_book.append(np.full(n_inv, bi, dtype=np.int32))

        n_call = len(res["call_patches"])
        call_p.append(res["call_patches"])
        call_t.append(res["call_targets"])
        call_s.append(res["call_sources"])
        call_book.append(np.full(n_call, bi, dtype=np.int32))

        n_rend = len(res["render_patches"])
        if n_rend:
            rend_p.append(res["render_patches"])
            rend_t.append(res["render_inv_idx"])
            rend_book.append(np.full(n_rend, bi, dtype=np.int32))

    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        DATA_PATH,
        book_names=np.array(book_names),
        inner_dev=np.array(inner_dev),
        inv_patches=np.concatenate(inv_p),
        inv_valid=np.concatenate(inv_v),
        inv_book=np.concatenate(inv_book),
        call_patches=np.concatenate(call_p),
        call_targets=np.concatenate(call_t),
        call_sources=np.concatenate(call_s),
        call_book=np.concatenate(call_book),
        render_patches=np.concatenate(rend_p) if rend_p else np.zeros((0, 64, 64, 3), np.uint8),
        render_targets=np.concatenate(rend_t) if rend_t else np.zeros(0, np.int32),
        render_book=np.concatenate(rend_book) if rend_book else np.zeros(0, np.int32),
    )
    n_calls = sum(len(x) for x in call_p)
    n_omr = int((np.concatenate(call_s) == 2).sum())
    n_inv = sum(len(x) for x in inv_p)
    n_rend = sum(len(x) for x in rend_p)
    print(f"Saved {DATA_PATH} in {time.time()-t0:.1f}s: {len(book_names)} booklets, {n_inv} inv crops, {n_calls} callout pairs ({n_omr} OMR-supervised), {n_rend} NPR renders", flush=True)


def _augment(x):
    """Fast MPS-native booklet-safe augmentation on (B, 3, H, W) float32 tensor in [0, 1] on white bg."""
    import torch

    B, C, H, W = x.shape
    device = x.device
    y = x.clone()
    # Fast random translation (+-2 px) with white border fill (no slow MPS grid_sample!)
    dx = int(torch.randint(-2, 3, (1,)).item())
    dy = int(torch.randint(-2, 3, (1,)).item())
    if dx != 0 or dy != 0:
        shifted = torch.ones_like(y)
        sx0, sx1 = max(0, dx), min(W, W + dx)
        sy0, sy1 = max(0, dy), min(H, H + dy)
        shifted[:, :, sy0:sy1, sx0:sx1] = y[:, :, sy0 - dy:sy1 - dy, sx0 - dx:sx1 - dx]
        y = shifted
    # Subtle brightness/contrast jitter ONLY on non-white foreground pixels (preserving LEGO colour identity!)
    fg = (y.min(dim=1, keepdim=True).values < 0.96).float()
    gain = 1.0 + (torch.rand(B, 1, 1, 1, device=device) * 2.0 - 1.0) * 0.08
    bias = (torch.rand(B, 1, 1, 1, device=device) * 2.0 - 1.0) * 0.03
    noise = torch.randn_like(y) * 0.012
    y = torch.clamp(y * (1.0 - fg) + (y * gain + bias + noise) * fg, 0.0, 1.0)
    return y


def train_model(epochs: int, seed: int = 0):
    import torch
    import torch.nn.functional as F
    from booklet_mpd.solver.partsnet import WEIGHTS, Net

    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    d = np.load(DATA_PATH, allow_pickle=True)
    book_names = list(d["book_names"])
    dev_names = set(d["inner_dev"].tolist())
    inv_patches = d["inv_patches"]
    inv_valid = d["inv_valid"]
    inv_book = d["inv_book"]
    call_patches = d["call_patches"]
    call_targets = d["call_targets"]
    call_book = d["call_book"]
    render_patches = d["render_patches"]
    render_targets = d["render_targets"]
    render_book = d["render_book"]

    # Index per booklet
    books = {}
    for bi, name in enumerate(book_names):
        im = inv_book == bi
        cm = call_book == bi
        rm = render_book == bi
        books[bi] = {
            "name": name,
            "is_dev": name in dev_names,
            "inv_x": torch.from_numpy(np.ascontiguousarray(inv_patches[im])).permute(0, 3, 1, 2).float() / 255.0,
            "inv_valid": inv_valid[im],
            "call_x": torch.from_numpy(np.ascontiguousarray(call_patches[cm])).permute(0, 3, 1, 2).float() / 255.0,
            "call_t": torch.from_numpy(call_targets[cm]).long(),
            "rend_x": torch.from_numpy(np.ascontiguousarray(render_patches[rm])).permute(0, 3, 1, 2).float() / 255.0,
            "rend_t": torch.from_numpy(render_targets[rm]).long(),
        }

    tr_books = [bi for bi, b in books.items() if not b["is_dev"] and len(b["call_t"]) > 0]
    dev_books = [bi for bi, b in books.items() if b["is_dev"] and len(b["call_t"]) > 0]
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Training PartsNet on {device}: {len(tr_books)} train booklets ({sum(len(books[b]['call_t']) for b in tr_books)} callouts), "
          f"{len(dev_books)} inner_dev booklets ({sum(len(books[b]['call_t']) for b in dev_books)} callouts)", flush=True)

    model = Net().to(device)
    logit_scale = torch.nn.Parameter(torch.tensor(float(np.log(1.0 / 0.07)), device=device))
    opt = torch.optim.AdamW(list(model.parameters()) + [logit_scale], lr=1.5e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs, eta_min=5e-5)

    def _max_by_target(sim_cr, rt, n_inv: int):
        # Pure MPS-native group-max without scatter_reduce_ (which stalls/falls back on MPS!)
        # sim_cr: (C, R), rt: (R,) in [0, n_inv) -> (C, n_inv)
        eq = rt[None, :] == torch.arange(n_inv, device=sim_cr.device)[:, None]  # (n_inv, R)
        # (C, n_inv, R) masked max (R <= 64 during train, or chunked in eval)
        masked = torch.where(eq[None, :, :], sim_cr[:, None, :], torch.full_like(sim_cr[:, None, :], -1e4))
        return masked.max(dim=2).values

    def eval_split(b_ids):
        model.eval()
        hit = tot = rend_hit = rend_tot = 0
        with torch.no_grad():
            for bi in b_ids:
                b = books[bi]
                zi = model(b["inv_x"].to(device))
                zc = model(b["call_x"].to(device))
                sim = zc @ zi.T
                invalid = torch.from_numpy(~b["inv_valid"]).to(device)
                sim[:, invalid] = -1e9
                pred = sim.argmax(dim=1).cpu()
                hit += int((pred == b["call_t"]).sum())
                tot += len(b["call_t"])
                if len(b["rend_t"]) > 0:
                    zr = model(b["rend_x"].to(device))
                    sim_cr = (zc @ zr.T).cpu().numpy()
                    rt_np = b["rend_t"].numpy()
                    n_inv = len(b["inv_valid"])
                    sim_via_r = np.full((len(zc), n_inv), -1e9, dtype=np.float32)
                    np.maximum.at(sim_via_r.T, rt_np, sim_cr.T)
                    rpred = sim_via_r.argmax(axis=1)
                    rend_hit += int((rpred == b["call_t"].numpy()).sum())
                    rend_tot += len(b["call_t"])
        model.train()
        return hit / max(1, tot), rend_hit / max(1, rend_tot)

    # Pre-move tensors to device for fast MPS training (total dataset is ~70 MB!)
    for bi in books:
        books[bi]["inv_d"] = books[bi]["inv_x"].to(device)
        books[bi]["call_d"] = books[bi]["call_x"].to(device)
        books[bi]["call_td"] = books[bi]["call_t"].to(device)
        books[bi]["inv_inval_d"] = torch.from_numpy(~books[bi]["inv_valid"]).to(device)
        books[bi]["rend_d"] = books[bi]["rend_x"].to(device) if len(books[bi]["rend_t"]) else None
        books[bi]["rend_td"] = books[bi]["rend_t"].to(device) if len(books[bi]["rend_t"]) else None

    best_score = -1.0
    best_state = None
    t_train = time.time()

    for epoch in range(epochs):
        rng.shuffle(tr_books)
        tot_loss = 0.0
        n_steps = 0
        # Fast 2D MPS training with float16 autocast (~3-4x faster on Apple Silicon MPS!)
        for i in range(0, len(tr_books), 2):
            batch_bs = tr_books[i:i + 2]
            scale = torch.clamp(logit_scale.exp(), max=45.0)
            xs = []
            slices = []
            cur = 0
            for bi in batch_bs:
                b = books[bi]
                ni, nc = len(b["inv_d"]), len(b["call_d"])
                xs.append(b["inv_d"])
                i0, i1 = cur, cur + ni
                cur = i1
                if nc > 96:
                    csel = torch.randperm(nc, device=device)[:96]
                    xs.append(b["call_d"][csel])
                    ct_sel = b["call_td"][csel]
                else:
                    xs.append(b["call_d"])
                    ct_sel = b["call_td"]
                c0, c1 = cur, cur + len(ct_sel)
                cur = c1
                r0 = r1 = -1
                rt_sel = None
                if b["rend_d"] is not None and len(b["rend_d"]) > 0:
                    nr = len(b["rend_d"])
                    sel = torch.randperm(nr, device=device)[:48]
                    xs.append(b["rend_d"][sel])
                    rt_sel = b["rend_td"][sel]
                    r0, r1 = cur, cur + len(sel)
                    cur = r1
                slices.append((bi, i0, i1, c0, c1, ct_sel, r0, r1, rt_sel))

            x_all = _augment(torch.cat(xs, dim=0))
            with torch.autocast(device_type=device, dtype=torch.float16, enabled=(device == "mps")):
                z_all = model(x_all).float()
            loss = torch.tensor(0.0, device=device)
            all_zc, all_zi_pos = [], []
            for bi, i0, i1, c0, c1, ct_sel, r0, r1, rt_sel in slices:
                b = books[bi]
                zi = z_all[i0:i1]
                zc = z_all[c0:c1]
                invalid = b["inv_inval_d"]
                # 1. Within-booklet callout -> inventory InfoNCE (same-colour look-alike hard negatives!)
                logits = (scale * (zc @ zi.T)).masked_fill(invalid[None, :], -1e4)
                loss = loss + F.cross_entropy(logits, ct_sel)
                all_zc.append(zc)
                all_zi_pos.append(zi[ct_sel])
                # 2. Cross-domain NPR render -> inventory InfoNCE (pure 2D matmul, <0.2 ms!)
                if r0 >= 0:
                    zr = z_all[r0:r1]
                    r_logits = (scale * (zr @ zi.T)).masked_fill(invalid[None, :], -1e4)
                    loss = loss + 0.50 * F.cross_entropy(r_logits, rt_sel)

            Z_c = torch.cat(all_zc, dim=0)
            Z_i = torch.cat(all_zi_pos, dim=0)
            if len(Z_c) > 96:
                perm = torch.randperm(len(Z_c), device=device)[:96]
                Z_c, Z_i = Z_c[perm], Z_i[perm]
            sim_b = scale * (Z_c @ Z_i.T)
            tgt_b = torch.arange(len(Z_c), device=device)
            loss = loss / len(batch_bs) + 0.25 * 0.5 * (F.cross_entropy(sim_b, tgt_b) + F.cross_entropy(sim_b.T, tgt_b))

            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 2.0)
            opt.step()
            tot_loss += float(loss.detach())
            n_steps += 1
        sched.step()

        if (epoch + 1) % 3 == 0 or epoch == epochs - 1 or epoch == 0:
            tr_acc, tr_r = eval_split(tr_books[:12])
            dv_acc, dv_r = eval_split(dev_books)
            comb = dv_acc + 0.35 * dv_r
            marker = ""
            if comb > best_score:
                best_score = comb
                best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
                marker = " *BEST*"
            print(f"epoch {epoch+1:2d}/{epochs} ({time.time()-t_train:4.0f}s): loss={tot_loss/max(1,n_steps):.3f} temp={1.0/float(logit_scale.detach().exp()):.3f} | "
                  f"tr_top1={tr_acc:.3f} (rend={tr_r:.3f}) | inner_dev_top1={dv_acc:.3f} (rend={dv_r:.3f}){marker}", flush=True)

    WEIGHTS.parent.mkdir(parents=True, exist_ok=True)
    torch.save(best_state, WEIGHTS)
    print(f"Saved best PartsNet weights to {WEIGHTS}", flush=True)

    # Calibrate PARTSNET_W strictly on inner_dev booklets via actual end-to-end read_parts()!
    from assembly_model.ldraw import load_library
    from booklet_mpd.solver import partsnet
    from booklet_mpd.solver.dataset import cases, extract_of, pairs
    from booklet_mpd.solver.evaluate import same_colour, same_part
    from booklet_mpd.solver.parts import element_index, read_parts
    from booklet_mpd.solver.pipeline import inventory_fallback
    import pymupdf

    partsnet.loaded.cache_clear()
    lib = load_library(str(ROOT / "public/ldraw"))
    idx = element_index()
    avail = pairs()
    inner_dev_sets = sorted(dev_names)
    print(f"\nCalibrating PARTSNET_W on {len(inner_dev_sets)} inner_dev sets (strictly inside train split)...", flush=True)

    best_w = (0.0, -1.0)
    for w in (0.0, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75):
        os.environ["PARTSNET_W"] = str(w)
        h = t = sok = sc = 0
        for sn in inner_dev_sets:
            try:
                extract, folder = extract_of(sn)
                fb = inventory_fallback(lib, pymupdf.open(str(avail[sn].pdf)), extract, idx, None)
                steps, _rep = read_parts(lib, extract, folder, idx, None, fallback=fb)
                for c in cases(sn, with_images=False):
                    pred = list(steps[c.booklet_step].parts) if c.booklet_step < len(steps) else []
                    truth = [(p, co) for p, co, _ in c.added]
                    used = [False] * len(pred)
                    sh = 0
                    for tp, tc in truth:
                        for j, (pp, pc) in enumerate(pred):
                            if not used[j] and same_colour(pc, tc) and same_part(lib, pp, tp):
                                used[j] = True
                                sh += 1
                                break
                    h += sh
                    t += len(truth)
                    sc += 1
                    sok += int(sh == len(truth) == len(pred))
            except Exception:
                continue
        rec = h / max(1, t)
        sacc = sok / max(1, sc)
        print(f"  PARTSNET_W={w:.2f}: inner_dev recall={h}/{t} ({100*rec:.2f}%) step_acc={sok}/{sc} ({100*sacc:.2f}%)", flush=True)
        metric = rec + 0.1 * sacc
        if metric > best_w[1] + 1e-6:
            best_w = (w, metric)

    WEIGHT_PATH.write_text(f"{best_w[0]}\n")
    print(f"Selected PARTSNET_W={best_w[0]} -> saved {WEIGHT_PATH}", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("mode", choices=["data", "train", "all"])
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--epochs", type=int, default=35)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    if a.mode in ("data", "all"):
        build_data(a.workers)
    if a.mode in ("train", "all"):
        train_model(a.epochs, a.seed)


if __name__ == "__main__":
    main()
