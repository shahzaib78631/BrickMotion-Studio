"""Train the placement comparator (python/booklet_mpd/solver/comparator.py).

data : per train booklet, teacher-forced: the camera registered on the step's true completed model, then for
       each new part its candidate poses scored by the hand-made gain with the step's other new parts in
       place. The true pose and the top wrong ones (by gain) become patches; one group per part.
train: a small CNN scores each patch; softmax over a part's group, the true pose as the target. The four
       benchmark sets (EVAL) are never trained on: top-1 accuracy there, against the gain's top-1, is the test.

cd python && .venv/bin/python ../scripts/train_comparator.py data --workers 5
cd python && .venv/bin/python ../scripts/train_comparator.py train
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
OUT = ROOT / ".cache/booklet-mpd/comparator-data"
EVAL = {"40353", "41605", "40271", "41488"}
WRONG = 7


def sets() -> list[str]:
    from booklet_mpd.solver.dataset import audit_rows
    return sorted(s for s, r in audit_rows().items() if r["split"] == "train" and r["alignment_ok"])


def _key(lib, part, m):
    from booklet_mpd.solver.place import _shape
    m = np.asarray(m, float)
    h, lo = _shape(lib, part, m[:3, :3])
    return h, tuple(np.round((m[:3, 3] + lo) * 2).astype(int))


def make(set_number: str) -> str:
    from assembly_model.ldraw import load_library
    from booklet_mpd.solver.candidates import candidates
    from booklet_mpd.solver.comparator import patch
    from booklet_mpd.solver.dataset import cases
    from booklet_mpd.solver.edges import NEAR_INK, ink_distance
    from booklet_mpd.solver.picture import Picture
    from booklet_mpd.solver.place import DELTAS, Scene, distinct, drawn_pose, score_candidates
    from booklet_mpd.solver.register import rank_views, search
    from booklet_mpd.solver.step import MIN_ARROW_PIXELS, SCALE_RANGE
    from booklet_mpd.viewfit import BOOKLET_SCALE
    lib = load_library(str(ROOT / "public/ldraw"))
    X, group, label, gain, rank = [], [], [], [], []
    g = 0
    try:
        all_cases = cases(set_number)
    except Exception as error:
        return f"{set_number}: no cases ({error})"
    for case in all_cases:
        base = case.visible
        if not base or case.rgb is None or not case.pts_per_px:
            continue
        after = base + list(case.added)
        try:
            pic = Picture.from_rgb(case.rgb, case.pts_per_px, BOOKLET_SCALE / case.pts_per_px)
            codes = sorted({c for _p, c, _m in after})
            classes = pic.classes(codes)
            ink = ink_distance(pic.rgb)
            views = rank_views(lib, after, case.rgb, case.pts_per_px, BOOKLET_SCALE, top=8)
            if not views:
                continue
            orients = list(dict.fromkeys(oi for _i, oi, _y, _p in views[:4]))
            regs = search(lib, after, pic, codes, orients, BOOKLET_SCALE / pic.pts_per_px, classes=classes,
                          on_ink=ink <= NEAR_INK, refine=2, scale_range=SCALE_RANGE)
        except Exception:
            continue
        if not regs:
            continue
        view = regs[0].view
        deltas = DELTAS if int(pic.arrows.sum()) >= MIN_ARROW_PIXELS else (0.0,)
        for j, (p, c, t) in enumerate(case.added):
            ctx = base + [x for k, x in enumerate(case.added) if k != j]
            try:
                cands = distinct(lib, p, candidates(lib, p, ctx))
            except Exception:
                continue
            truth = _key(lib, p, t)
            hit = [k for k, cd in enumerate(cands) if _key(lib, p, cd["matrix"]) == truth]
            if not hit or len(cands) < 2:
                continue
            scene = Scene.build(lib, ctx, view, classes, codes, ink)
            scored = score_candidates(lib, scene, p, c, cands, deltas=deltas)
            order = sorted(range(len(scored)), key=lambda k: -scored[k].score)
            wrong = [k for k in order if k != hit[0] and np.isfinite(scored[k].score)][:WRONG]
            members = [hit[0]] + wrong
            pats = [patch(lib, pic.rgb, pic.background, view, ctx, p, c, drawn_pose(scored[k])) for k in members]
            if any(x is None for x in pats):
                continue
            for k, x in zip(members, pats):
                X.append(x)
                group.append(g)
                label.append(int(k == hit[0]))
                gain.append(float(scored[k].score))
            rank.append(order.index(hit[0]))
            g += 1
    OUT.mkdir(parents=True, exist_ok=True)
    if X:
        np.savez_compressed(OUT / f"{set_number}.npz", X=np.stack(X), group=np.array(group), label=np.array(label),
                            gain=np.array(gain), rank=np.array(rank))
    top1 = float(np.mean(np.array(rank) == 0)) if rank else 0.0
    return f"{set_number}: {g} parts, {len(X)} patches, gain top-1 {top1:.2f}"


def _make_safe(set_number: str) -> str:
    try:
        return make(set_number)
    except Exception as error:          # one bad booklet must not stop the run
        return f"{set_number}: failed ({type(error).__name__}: {error})"


def data(workers: int):
    import concurrent.futures
    todo = [s for s in sets() if not (OUT / f"{s}.npz").exists()]
    print(f"{len(todo)} sets to do", flush=True)
    with concurrent.futures.ProcessPoolExecutor(workers) as pool:
        for line in pool.map(_make_safe, todo):
            print(line, flush=True)


def _load(names):
    xs, gs, ls, gains, off = [], [], [], [], 0
    for s in names:
        f = OUT / f"{s}.npz"
        if not f.exists():
            continue
        d = np.load(f)
        xs.append(d["X"]); ls.append(d["label"]); gains.append(d["gain"])
        gs.append(d["group"] + off)
        off += int(d["group"].max()) + 1
    if not xs:
        return None
    return np.concatenate(xs), np.concatenate(gs), np.concatenate(ls), np.concatenate(gains)


def _top1(scores, groups, labels):
    hits = n = 0
    for g in np.unique(groups):
        m = groups == g
        hits += int(labels[m][np.argmax(scores[m])] == 1)
        n += 1
    return hits / max(n, 1), n


def train(epochs: int, seed: int = 0):
    import torch
    from booklet_mpd.solver.comparator import MODEL_PATH, net
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    names = sets()
    pool = [s for s in names if s not in EVAL]
    val_names = pool[::6]                   # tunes the weight against the gain; EVAL stays untouched
    tr = _load([s for s in pool if s not in val_names])
    va = _load(val_names)
    te = _load([s for s in names if s in EVAL])
    X, G, L, _ = tr
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = net().to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-4)
    groups = np.unique(G)
    index = {g: np.nonzero(G == g)[0] for g in groups}
    print(f"train: {len(groups)} parts, {len(X)} patches; device {device}", flush=True)

    def scores(Xs):
        model.eval()
        out = []
        with torch.no_grad():
            for i in range(0, len(Xs), 512):
                out.append(model(torch.from_numpy(Xs[i:i + 512].astype(np.float32) / 255.0).to(device)).squeeze(-1).cpu().numpy())
        model.train()
        return np.concatenate(out)
    for epoch in range(epochs):
        rng.shuffle(groups)
        total = 0.0
        for i in range(0, len(groups), 32):
            batch = [index[g] for g in groups[i:i + 32]]
            idx = np.concatenate(batch)
            x = torch.from_numpy(X[idx].astype(np.float32) / 255.0)
            if rng.random() < 0.5:      # mirror: a booklet picture and its render flip together
                x = torch.flip(x, dims=[3])
            out = model(x.to(device)).squeeze(-1)
            loss, k = 0.0, 0
            for b in batch:
                seg = out[k:k + len(b)]
                target = torch.tensor(int(np.argmax(L[b])), device=device)
                loss = loss + torch.nn.functional.cross_entropy(seg[None], target[None])
                k += len(b)
            loss = loss / len(batch)
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += float(loss) * len(batch)
        line = f"epoch {epoch}: loss {total / len(groups):.3f}"
        if te is not None:
            Xt, Gt, Lt, gain_t = te
            acc, n = _top1(scores(Xt), Gt, Lt)
            base, _ = _top1(gain_t, Gt, Lt)
            line += f" | held-out top-1 {acc:.3f} vs gain {base:.3f} ({n} parts)"
        print(line, flush=True)
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    torch.save({k: v.cpu() for k, v in model.state_dict().items()}, MODEL_PATH)
    print("saved", MODEL_PATH)
    # weight against the gain, chosen on the validation sets: combined = gain + w * spread * logit,
    # spread = the gain's spread over the part's group (gains are pixel counts, logits are not)
    def combined(Xs, Gs, gains, w):
        lg = scores(Xs)
        out = gains.astype(float).copy()
        for g in np.unique(Gs):
            m = Gs == g
            spread = float(np.std(gains[m])) or 1.0
            out[m] = gains[m] + w * spread * lg[m]
        return out
    best = (-1.0, 0.0)
    if va is not None:
        Xv, Gv, Lv, gain_v = va
        for w in (0.0, 0.1, 0.25, 0.5, 1.0, 2.0, 4.0):
            acc, n = _top1(combined(Xv, Gv, gain_v, w), Gv, Lv)
            print(f"validation w={w}: top-1 {acc:.3f} ({n} parts)", flush=True)
            if acc > best[0] + 1e-9:
                best = (acc, w)
    if te is not None:
        Xt, Gt, Lt, gain_t = te
        acc, n = _top1(combined(Xt, Gt, gain_t, best[1]), Gt, Lt)
        base, _ = _top1(gain_t, Gt, Lt)
        print(f"held-out (EVAL) at w={best[1]}: top-1 {acc:.3f} vs gain {base:.3f} ({n} parts)")
    (MODEL_PATH.parent / "comparator-weight.txt").write_text(str(best[1]))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("mode", choices=["data", "train"])
    ap.add_argument("--workers", type=int, default=5)
    ap.add_argument("--epochs", type=int, default=12)
    a = ap.parse_args()
    if a.mode == "data":
        data(a.workers)
    else:
        train(a.epochs)


if __name__ == "__main__":
    main()
