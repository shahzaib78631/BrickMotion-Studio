"""Train V2 NPR Whole-Layout & Sub-Build Reranker (python/booklet_mpd/solver/comparator.py).

Strictly uses ONLY eligible TRAIN booklets EXCLUDING the 6 primary Gate 4b evaluation sets
(`EVAL6 = {40271, 40350, 41488, 41605, 41620, 40348}`) and NEVER touches validation or test sets.

Harvests two types of real-booklet groups rendered on ONE shared 96x96 NPR crop window:
  1. Whole-step groups: true step layout vs top-K highest-ModelScorer wrong layouts (single-part
     hard swaps + beam runner-ups), directly targeting close visual calls.
  2. Sub-build panel groups: real booklet sub-build panels, true sub-build assembly vs runner-up
     wrong connected assemblies (including black-on-black / same-colour seams).

Usage:
    PYTHONPATH=python python/.venv/bin/python scripts/train_comparator_v2.py data --workers 6
    PYTHONPATH=python python/.venv/bin/python scripts/train_comparator_v2.py train --epochs 25
"""
from __future__ import annotations

import argparse
import concurrent.futures
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

OUT_DIR = ROOT / ".cache/booklet-mpd/layout-comparator-data"
WEIGHT_PATH = ROOT / ".cache/booklet-mpd/layout-comparator-weight.txt"
EVAL6 = {"40271", "40350", "41488", "41605", "41620", "40348"}
MAX_WRONG = 7


def eligible_train_pool() -> tuple[list[str], list[str]]:
    """Eligible TRAIN studded sets (<= 300 parts, excluding EVAL6, strict zero-leakage!),
    split into inner_train / inner_dev. Skips 1,000+ part megasets (e.g. 31203/21311/21319)."""
    from booklet_mpd.protocol import tuning_sets
    from booklet_mpd.solver.bench import family
    from booklet_mpd.solver.dataset import audit_rows, grades, pairs

    avail = pairs()
    ar = audit_rows()
    all_tr = sorted(
        s for s in tuning_sets(grades())
        if s in avail and s not in EVAL6 and family(s) == "studded"
        and int(ar.get(s, {}).get("omr_parts") or ar.get(s, {}).get("parts") or 0) <= 300
        and s not in {"21036", "21311", "21319", "31203", "75272", "75277", "75969", "75980"}
    )
    inner_dev = sorted(all_tr[1::6])
    dev_s = set(inner_dev)
    inner_train = [s for s in all_tr if s not in dev_s]
    return inner_train, inner_dev


def _layout_key(lib, placed: list) -> frozenset:
    from booklet_mpd.solver.place import _shape
    out = []
    for p, c, m in placed:
        m = np.asarray(m, float)
        h, lo = _shape(lib, p, m[:3, :3])
        out.append((p, int(c), h, tuple(np.round((m[:3, 3] + lo) * 2).astype(int))))
    return frozenset(out)


def _extract_set(set_number: str) -> str:
    out_file = OUT_DIR / f"{set_number}.npz"
    if out_file.exists():
        return f"{set_number}: cached"
    from assembly_model.ldraw import load_library
    from booklet_mpd.solver.candidates import candidates
    from booklet_mpd.solver.collide import Collider
    from booklet_mpd.solver.comparator import layout_patches
    from booklet_mpd.solver.dataset import cases
    from booklet_mpd.solver.edges import ink_distance
    from booklet_mpd.solver.exact_place import score_candidates_calibrated

    def _edges(arr: np.ndarray) -> np.ndarray:
        e = np.zeros(arr.shape, bool)
        e[:, 1:] |= arr[:, 1:] != arr[:, :-1]
        e[1:, :] |= arr[1:, :] != arr[:-1, :]
        return e
    from booklet_mpd.solver.picture import Picture
    from booklet_mpd.solver.place import distinct
    from booklet_mpd.solver.render import render
    from booklet_mpd.solver.scorer import ModelScorer
    from booklet_mpd.solver.step import MIN_ARROW_PIXELS, _units, solve
    from booklet_mpd.viewfit import BOOKLET_SCALE

    lib = load_library(str(ROOT / "public/ldraw"))
    collider = Collider(lib, use_oracle=True)
    try:
        all_cases = list(cases(set_number))
    except Exception as e:
        return f"{set_number}: cases error ({e})"

    X, G, L, S, KIND = [], [], [], [], []   # KIND: 0=whole_step, 1=subbuild_panel
    g_id = 0
    for ci, c in enumerate(all_cases):
        base = c.visible if c.visible else []
        if c.rgb is None or not base or not c.added or len(c.added) > 12:
            continue
        prev_c = all_cases[ci - 1] if ci > 0 and all_cases[ci - 1].file == c.file and all_cases[ci - 1].step_number == c.step_number - 1 else None
        px = BOOKLET_SCALE / c.pts_per_px if c.pts_per_px else None
        pic = Picture.from_rgb(c.rgb, c.pts_per_px, px)
        if int(pic.arrows.sum()) >= MIN_ARROW_PIXELS:
            continue  # drawn apart: seated truth differs from exploded drawing

        # Register oracle camera on true completed model; skip steps with poor camera fit
        full = list(base) + list(c.added)
        try:
            oracle = solve(lib, full, [], c.rgb, c.pts_per_px, collider=collider)
        except Exception:
            continue
        if oracle.view is None:
            continue
        _d, lab = render(lib, full, oracle.view, pic.rgb.shape[:2])
        edge = (_edges(lab) & (lab >= 0)) | _edges(lab >= 0)
        if not edge.any():
            continue
        p90 = float(np.percentile(ink_distance(pic.rgb)[edge] / pic.factor, 90))
        if p90 > 1.6:
            continue

        codes = sorted({int(co) for _p, co, _m in full})
        ms = ModelScorer(lib, list(base), pic, oracle.view, codes,
                         prev_rgb=prev_c.rgb if prev_c is not None else None,
                         prev_pts=prev_c.pts_per_px if prev_c is not None else None)
        collider.set_model(list(base))

        # 1. Harvest whole-step hard negatives (true layout + top-ModelScorer single-part swaps & beam alts)
        truth = [(p, int(co), np.asarray(m, float)) for p, co, m in c.added]
        t_key = _layout_key(lib, truth)
        t_score = float(ms.score(truth))
        wrong_pool: list[tuple[float, list]] = []
        seen_k = {t_key}

        # Single-part hard negatives (moves one part to its highest-ModelScorer non-colliding wrong pose)
        for j, (part, col, _tm) in enumerate(truth):
            others = [x for k, x in enumerate(truth) if k != j]
            try:
                cands = distinct(lib, part, candidates(lib, part, list(base) + others))
            except Exception:
                continue
            cands = [q for q in cands if not collider.hits_extra(part, q["matrix"], others)]
            if not cands:
                continue
            sc = score_candidates_calibrated(lib, ms, others, part, col, cands, deltas=(0.0,))
            sc.sort(key=lambda s: -s.score)
            added_for_j = 0
            for item in sc[:10]:
                if added_for_j >= 3:
                    break
                cand_lay = list(truth)
                cand_lay[j] = (part, col, np.asarray(item.candidate["matrix"], float))
                ck = _layout_key(lib, cand_lay)
                if ck in seen_k:
                    continue
                seen_k.add(ck)
                ex_sc = float(ms.score(cand_lay))
                wrong_pool.append((ex_sc, cand_lay))
                added_for_j += 1

        # Keep top MAX_WRONG hardest negatives (highest ModelScorer, i.e. closest calls!)
        wrong_pool.sort(key=lambda x: -x[0])
        chosen_wrong = wrong_pool[:MAX_WRONG]
        if chosen_wrong:
            layouts = [truth] + [w[1] for w in chosen_wrong]
            scores_g = [t_score] + [w[0] for w in chosen_wrong]
            pats = layout_patches(lib, pic.rgb, pic.background, oracle.view, list(base), layouts)
            if pats is not None and len(pats) == len(layouts):
                for idx_k, (pat, sc_k) in enumerate(zip(pats, scores_g)):
                    X.append(pat)
                    G.append(g_id)
                    L.append(1 if idx_k == 0 else 0)
                    S.append(sc_k)
                    KIND.append(0)
                g_id += 1

        # 2. Also harvest sub-build panel groups when this step has a single-unit sub-build panel!
        if c.subbuilds and len(c.added) <= 8:
            try:
                specs, rest = _units(lib, [(p, int(co)) for p, co, _ in truth], c.subbuilds)
            except Exception:
                specs, rest = [], []
            if len(specs) == 1 and not rest and specs[0]["count"] == 1:
                sp = specs[0]
                spic = sp["picture"]
                if int(spic.arrows.sum()) < 20:
                    try:
                        sub_or = solve(lib, truth, [], spic.rgb, spic.pts_per_px, collider=collider)
                    except Exception:
                        sub_or = None
                    if sub_or is not None and sub_or.view is not None:
                        _ds, ls = render(lib, truth, sub_or.view, spic.rgb.shape[:2])
                        es = (_edges(ls) & (ls >= 0)) | _edges(ls >= 0)
                        if es.any() and float(np.percentile(ink_distance(spic.rgb)[es] / spic.factor, 90)) <= 1.8:
                            scodes = sp["codes"]
                            sms = ModelScorer(lib, [], spic, sub_or.view, scodes)
                            collider.set_model([])
                            st_score = float(sms.score(truth))
                            swrong = []
                            sseen = {t_key}
                            for j, (part, col, _tm) in enumerate(truth):
                                others = [x for k, x in enumerate(truth) if k != j]
                                if not others:
                                    continue
                                try:
                                    cands = distinct(lib, part, candidates(lib, part, others))
                                except Exception:
                                    continue
                                cands = [q for q in cands if not collider.hits_extra(part, q["matrix"], others)]
                                if not cands:
                                    continue
                                sc = score_candidates_calibrated(lib, sms, others, part, col, cands, deltas=(0.0,))
                                sc.sort(key=lambda s: -s.score)
                                cnt_j = 0
                                for item in sc[:8]:
                                    if cnt_j >= 3:
                                        break
                                    cand_lay = list(truth)
                                    cand_lay[j] = (part, col, np.asarray(item.candidate["matrix"], float))
                                    ck = _layout_key(lib, cand_lay)
                                    if ck in sseen:
                                        continue
                                    sseen.add(ck)
                                    swrong.append((float(sms.score(cand_lay)), cand_lay))
                                    cnt_j += 1
                            swrong.sort(key=lambda x: -x[0])
                            swrong = swrong[:MAX_WRONG]
                            if swrong:
                                layouts_s = [truth] + [w[1] for w in swrong]
                                scores_s = [st_score] + [w[0] for w in swrong]
                                pats_s = layout_patches(lib, spic.rgb, spic.background, sub_or.view, [], layouts_s)
                                if pats_s is not None and len(pats_s) == len(layouts_s):
                                    for idx_k, (pat, sc_k) in enumerate(zip(pats_s, scores_s)):
                                        X.append(pat)
                                        G.append(g_id)
                                        L.append(1 if idx_k == 0 else 0)
                                        S.append(sc_k)
                                        KIND.append(1)
                                    g_id += 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if X:
        np.savez_compressed(
            out_file,
            X=np.stack(X),
            group=np.array(G, dtype=np.int32),
            label=np.array(L, dtype=np.int8),
            score=np.array(S, dtype=np.float32),
            kind=np.array(KIND, dtype=np.int8),
        )
    n_sub = int(sum(1 for g in set(G) if KIND[G.index(g)] == 1)) if G else 0
    return f"{set_number}: {g_id} groups ({n_sub} subbuild), {len(X)} patches"


def _extract_safe(sn: str) -> str:
    try:
        return _extract_set(sn)
    except Exception as e:
        return f"{sn}: failed ({type(e).__name__}: {e})"


def build_data(workers: int, limit: int = 0):
    tr, dv = eligible_train_pool()
    all_sets = sorted(tr + dv)
    if limit > 0:
        all_sets = all_sets[:limit]
    print(f"Extracting V2 layout-comparator data from {len(all_sets)} non-EVAL6 train sets ({len(tr)} inner_train, {len(dv)} inner_dev)...", flush=True)
    t0 = time.time()
    with concurrent.futures.ProcessPoolExecutor(workers) as pool:
        futs = {pool.submit(_extract_safe, sn): sn for sn in all_sets}
        for fut in concurrent.futures.as_completed(futs):
            print(" ", fut.result(), flush=True)
    print(f"Extraction done in {time.time()-t0:.1f}s", flush=True)


def _load_sets(names: list[str]):
    xs, gs, ls, ss, ks = [], [], [], [], []
    off = 0
    for sn in names:
        f = OUT_DIR / f"{sn}.npz"
        if not f.exists():
            continue
        d = np.load(f)
        if not len(d["X"]):
            continue
        xs.append(d["X"])
        ls.append(d["label"])
        ss.append(d["score"])
        ks.append(d["kind"])
        gs.append(d["group"] + off)
        off += int(d["group"].max()) + 1
    if not xs:
        return None
    return np.concatenate(xs), np.concatenate(gs), np.concatenate(ls), np.concatenate(ss), np.concatenate(ks)


def _group_top1(scores: np.ndarray, groups: np.ndarray, labels: np.ndarray) -> tuple[float, int]:
    hits = n = 0
    for g in np.unique(groups):
        m = groups == g
        hits += int(labels[m][int(np.argmax(scores[m]))] == 1)
        n += 1
    return hits / max(1, n), n


def train_model(epochs: int, seed: int = 0):
    import torch
    import torch.nn.functional as F
    from booklet_mpd.solver.comparator import LAYOUT_MODEL_PATH, layout_net

    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    tr_names, dv_names = eligible_train_pool()
    tr = _load_sets(tr_names)
    dv = _load_sets(dv_names)
    if tr is None or dv is None:
        raise RuntimeError("Missing extracted data; run `data` first.")

    Xtr, Gtr, Ltr, Str, Ktr = tr
    Xdv, Gdv, Ldv, Sdv, Kdv = dv
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    groups_tr = np.unique(Gtr)
    idx_tr = {int(g): np.nonzero(Gtr == g)[0] for g in groups_tr}
    base_tr, _ = _group_top1(Str, Gtr, Ltr)
    base_dv, n_dv = _group_top1(Sdv, Gdv, Ldv)
    print(f"Training LayoutNet on {device}: train={len(groups_tr)} groups ({len(Xtr)} patches, base top-1={base_tr:.3f}) | "
          f"inner_dev={n_dv} groups ({len(Xdv)} patches, base top-1={base_dv:.3f})", flush=True)

    model = layout_net().to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=1.5e-3, weight_decay=2e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs, eta_min=5e-5)

    def predict(Xs: np.ndarray) -> np.ndarray:
        model.eval()
        out = []
        with torch.no_grad():
            for i in range(0, len(Xs), 256):
                xb = torch.from_numpy(np.ascontiguousarray(Xs[i:i + 256]).astype(np.float32) / 255.0).to(device)
                with torch.autocast(device_type=device, dtype=torch.float16, enabled=(device == "mps")):
                    out.append(model(xb).float().squeeze(-1).cpu().numpy())
        model.train()
        return np.concatenate(out)

    def blend_groups(base_s: np.ndarray, lg: np.ndarray, gs: np.ndarray, w: float) -> np.ndarray:
        out = base_s.astype(float).copy()
        for g in np.unique(gs):
            m = gs == g
            s = base_s[m].astype(float)
            z = lg[m].astype(float)
            z = z - float(z.mean())
            top_n = min(4, len(s))
            spread = min(max(float(np.std(np.sort(s)[-top_n:])), 15.0), 250.0)
            out[m] = s + w * spread * z
        return out

    best_dv = -1.0
    best_state = None
    t0 = time.time()

    for epoch in range(epochs):
        rng.shuffle(groups_tr)
        tot_loss = 0.0
        n_g = 0
        for i in range(0, len(groups_tr), 24):
            batch_gs = groups_tr[i:i + 24]
            slices = [idx_tr[int(g)] for g in batch_gs]
            cat_idx = np.concatenate(slices)
            x = torch.from_numpy(np.ascontiguousarray(Xtr[cat_idx]).astype(np.float32) / 255.0).to(device)
            # Group-consistent horizontal flip (all candidates in a group flip together with picture!)
            if rng.random() < 0.5:
                x = torch.flip(x, dims=[3])
            # Group-consistent tiny translation jitter (+-2 px)
            dx = int(rng.integers(-2, 3))
            dy = int(rng.integers(-2, 3))
            if dx != 0 or dy != 0:
                x = torch.roll(x, shifts=(dy, dx), dims=(2, 3))
            # Subtle brightness jitter on picture RGB channels (0..2) only -> bridges booklet shading variation
            if rng.random() < 0.5:
                gain = float(rng.uniform(0.92, 1.08))
                x[:, :3] = torch.clamp(x[:, :3] * gain, 0.0, 1.0)

            with torch.autocast(device_type=device, dtype=torch.float16, enabled=(device == "mps")):
                logits = model(x).float().squeeze(-1)
            loss = torch.tensor(0.0, device=device)
            cur = 0
            for sl in slices:
                k = len(sl)
                seg = logits[cur:cur + k]
                tgt = int(np.argmax(Ltr[sl]))
                loss = loss + F.cross_entropy(seg[None, :], torch.tensor([tgt], device=device))
                cur += k
            loss = loss / len(slices)

            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 2.0)
            opt.step()
            tot_loss += float(loss.detach()) * len(slices)
            n_g += len(slices)
        sched.step()

        if (epoch + 1) % 3 == 0 or epoch == 0 or epoch == epochs - 1:
            lg_dv = predict(Xdv)
            raw_acc, _ = _group_top1(lg_dv, Gdv, Ldv)
            blend_acc, _ = _group_top1(blend_groups(Sdv, lg_dv, Gdv, 0.4), Gdv, Ldv)
            marker = ""
            if blend_acc > best_dv + 1e-6 or (abs(blend_acc - best_dv) < 1e-6 and raw_acc > best_dv):
                best_dv = blend_acc
                best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
                marker = " *BEST*"
            print(f"epoch {epoch+1:2d}/{epochs} ({time.time()-t0:4.0f}s): loss={tot_loss/max(1,n_g):.3f} | "
                  f"inner_dev raw={raw_acc:.3f} blend0.4={blend_acc:.3f} (base={base_dv:.3f}){marker}", flush=True)

    LAYOUT_MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    torch.save(best_state, LAYOUT_MODEL_PATH)
    model.load_state_dict({k: v.to(device) for k, v in best_state.items()})
    lg_dv = predict(Xdv)
    best_w = (0.0, base_dv)
    print("\nCalibrating blend weight on inner_dev:")
    for w in (0.0, 0.10, 0.20, 0.30, 0.45, 0.60, 0.80, 1.0, 1.5):
        acc, n = _group_top1(blend_groups(Sdv, lg_dv, Gdv, w), Gdv, Ldv)
        sub_m = Kdv == 1
        sub_str = ""
        if sub_m.any():
            sa, sn = _group_top1(blend_groups(Sdv[sub_m], lg_dv[sub_m], Gdv[sub_m], w), Gdv[sub_m], Ldv[sub_m])
            sb, _ = _group_top1(Sdv[sub_m], Gdv[sub_m], Ldv[sub_m])
            sub_str = f" | subbuild={sa:.3f} (base={sb:.3f}, n={sn})"
        print(f"  w={w:4.2f}: inner_dev top-1={acc:.3f} (base={base_dv:.3f}, n={n}){sub_str}", flush=True)
        if acc > best_w[1] + 1e-6:
            best_w = (w, acc)

    WEIGHT_PATH.write_text(f"{best_w[0]}\n")
    print(f"Saved {LAYOUT_MODEL_PATH} and {WEIGHT_PATH} (w={best_w[0]})", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("mode", choices=["data", "train", "all"])
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--epochs", type=int, default=25)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    if a.mode in ("data", "all"):
        build_data(a.workers, a.limit)
    if a.mode in ("train", "all"):
        train_model(a.epochs, a.seed)


if __name__ == "__main__":
    main()
