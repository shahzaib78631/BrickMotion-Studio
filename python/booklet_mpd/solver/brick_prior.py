"""Zero-leakage 3D LEGO Structural Prior (`BrickPriorNet`) trained on 73,310 clean LEGO models.

Scores the structural plausibility of any candidate `(host_part, host_pose) -> (new_part, new_pose)`
connection in <1ms on Apple Silicon MPS / CPU, giving the booklet solver human-like LEGO building
intuition (curved slope direction, SNOT orientation, hinge orientation, stud/plate alignment, display
stand idioms) when 2D visual evidence is occluded or nearly tied.

Strict protocol isolation: `train_clean_prior()` asserts that ZERO models whose name/set matches any
`validation`, `test`, or `CONTAMINATED` set in `booklet_mpd.protocol` ever enter the training set.
"""
from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path

import numpy as np

from ..inventory_check import base_number

MODEL_PATH = Path(__file__).resolve().parents[3] / ".cache/booklet-mpd/brick-prior-clean.pt"
CORPUS_DIR = Path("/Users/mac/Projects/BrickMotion-Data/brickgen/corpus")

_SINGLETON: "BrickPriorScorer | None" = None
_LOAD_FAILED = False


def enabled() -> bool:
    return os.environ.get("BOOKLET_SOLVER_BRICK_PRIOR", "1") != "0"


def _fourier_encode(dp_studs: np.ndarray) -> np.ndarray:
    """Multi-scale harmonic encoding of 3D local displacement (in stud units, 1 stud = 20 LDU)."""
    # Shape: (N, 3) -> (N, 3 + 3*2*4 = 27)
    freqs = np.array([0.5, 1.0, 2.0, 4.0], dtype=np.float32) * math.pi
    ang = dp_studs[:, :, None] * freqs[None, None, :]  # (N, 3, 4)
    return np.concatenate([
        np.clip(dp_studs, -8.0, 8.0) / 4.0,
        np.sin(ang).reshape(len(dp_studs), -1),
        np.cos(ang).reshape(len(dp_studs), -1),
    ], axis=-1).astype(np.float32)


def _rotmat_to_6d(R: np.ndarray) -> np.ndarray:
    return np.concatenate([R[..., :, 0], R[..., :, 1]], axis=-1).astype(np.float32)


def _build_net(n_parts: int, emb_dim: int = 48, hidden: int = 256):
    import torch
    import torch.nn as nn

    class BrickPriorNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.part_emb = nn.Embedding(n_parts + 1, emb_dim, padding_idx=0)
            # Strictly SE(3)-invariant & bidirectional features:
            # p_emb(48) + c_emb(48) + p_size(3) + c_size(3) + fourier_dp(27) + r6_rel(6) + same_col(1) = 136
            in_dim = emb_dim * 2 + 3 + 3 + 27 + 6 + 1
            self.in_proj = nn.Sequential(nn.Linear(in_dim, hidden), nn.LayerNorm(hidden), nn.SiLU())
            self.block1 = nn.Sequential(nn.Linear(hidden, hidden), nn.LayerNorm(hidden), nn.SiLU(), nn.Linear(hidden, hidden))
            self.block2 = nn.Sequential(nn.Linear(hidden, hidden), nn.LayerNorm(hidden), nn.SiLU(), nn.Linear(hidden, hidden))
            self.head = nn.Sequential(nn.LayerNorm(hidden), nn.SiLU(), nn.Linear(hidden, 1))

        def forward(self, p_id, c_id, cont):
            x = torch.cat([self.part_emb(p_id), self.part_emb(c_id), cont], dim=-1)
            h = self.in_proj(x)
            h = h + self.block1(h)
            h = h + self.block2(h)
            return self.head(h).squeeze(-1)

    return BrickPriorNet()


def _forbidden_sets() -> set[str]:
    from ..protocol import CONTAMINATED, heldout_sets
    from .dataset import grades
    g = grades()
    return set(heldout_sets(g, "validation")) | set(heldout_sets(g, "test")) | set(CONTAMINATED)


def train_clean_prior(out_path: Path = MODEL_PATH, epochs: int = 8, batch_size: int = 4096,
                      max_pairs: int = 1_500_000, lr: float = 2e-3) -> dict:
    """Train `BrickPriorNet` strictly on zero-leakage clean models from `BrickMotion-Data/brickgen/corpus`."""
    import torch
    import torch.nn.functional as F
    from brickgen.geometry import ROT24

    t0 = time.time()
    forbidden = _forbidden_sets()
    vocab = json.loads((CORPUS_DIR / "vocab.json").read_text())
    meta = json.loads((CORPUS_DIR / "meta_train.json").read_text())
    data = np.load(CORPUS_DIR / "train.npz")

    # Map every 0-based vocab part (`train.npz["part_id"]` is 0..len(raw_parts)-1) to canonical base_number id (1..n_base, 0=UNK)
    raw_parts: list[str] = vocab["parts"]
    raw_bboxes = np.asarray(vocab["part_bboxes"], dtype=np.float32)  # (V, 6)
    has_pad_bb = len(raw_bboxes) == len(raw_parts) + 1
    base_vocab: dict[str, int] = {}
    raw_to_base = np.zeros(len(raw_parts), dtype=np.int32)
    base_sizes: dict[int, list[np.ndarray]] = {}
    for idx, pname in enumerate(raw_parts):
        bn = base_number(pname)
        if bn not in base_vocab:
            base_vocab[bn] = len(base_vocab) + 1
        bid = base_vocab[bn]
        raw_to_base[idx] = bid
        bb = raw_bboxes[idx + 1] if has_pad_bb else raw_bboxes[idx]
        sz = np.abs(bb[3:6] - bb[0:3]) / 40.0
        base_sizes.setdefault(bid, []).append(sz)
    n_base = len(base_vocab)
    size_lut = np.zeros((n_base + 1, 3), dtype=np.float32)
    for bid, lst in base_sizes.items():
        size_lut[bid] = np.mean(lst, axis=0)

    # Filter models strictly excluding ALL forbidden sets (val + test + contaminated)!
    seq_ptr = data["seq_ptr"]
    part_id = data["part_id"]
    color_id = data["color_id"]
    parent = data["parent"]
    xyz = data["xyz"].astype(np.float32)
    rot24_idx = data["rot24"].astype(np.int32)

    clean_indices = []
    n_excluded = 0
    for mi, mrec in enumerate(meta):
        name = str(mrec.get("name", ""))
        if any(f in name for f in forbidden):
            n_excluded += 1
            continue
        clean_indices.append(mi)

    # Double-check zero leakage!
    for mi in clean_indices:
        nm = str(meta[mi].get("name", ""))
        assert not any(f in nm for f in forbidden), f"Leakage detected: {nm}"

    # Extract all parent -> child connections from clean models
    p_ids, c_ids, p_rot_i, c_rot_i, dp_world, same_col = [], [], [], [], [], []
    rng = np.random.default_rng(42)
    rng.shuffle(clean_indices)
    total_pairs = 0
    for mi in clean_indices:
        s, e = int(seq_ptr[mi]), int(seq_ptr[mi + 1])
        if e - s < 2:
            continue
        par = parent[s:e].astype(np.int32)
        valid = np.where((par >= 0) & (par < (e - s)))[0]
        if not len(valid):
            continue
        ci = s + valid
        pi = s + par[valid]
        pb = raw_to_base[np.clip(part_id[pi], 0, len(raw_parts) - 1)]
        cb = raw_to_base[np.clip(part_id[ci], 0, len(raw_parts) - 1)]
        ok = (pb > 0) & (cb > 0) & (rot24_idx[pi] >= 0) & (rot24_idx[pi] < 24) & (rot24_idx[ci] >= 0) & (rot24_idx[ci] < 24)
        if not ok.any():
            continue
        pi, ci, pb, cb = pi[ok], ci[ok], pb[ok], cb[ok]
        # Convert brickgen Y-up xyz -> LDraw Y-down delta: (dx, -dy_up, dz)
        d_up = xyz[ci] - xyz[pi]
        d_ld = np.stack([d_up[:, 0], -d_up[:, 1], d_up[:, 2]], axis=-1)
        p_ids.append(pb)
        c_ids.append(cb)
        p_rot_i.append(rot24_idx[pi])
        c_rot_i.append(rot24_idx[ci])
        dp_world.append(d_ld)
        same_col.append((color_id[ci] == color_id[pi]).astype(np.float32))
        total_pairs += len(pb)
        if total_pairs >= max_pairs:
            break

    p_ids = np.concatenate(p_ids)
    c_ids = np.concatenate(c_ids)
    p_rot_i = np.concatenate(p_rot_i)
    c_rot_i = np.concatenate(c_rot_i)
    dp_world = np.concatenate(dp_world)
    same_col = np.concatenate(same_col)

    # Precompute strictly SE(3)-invariant, BIDIRECTIONAL connections:
    # For every real connection (p -> c), include BOTH (p -> c) AND its exact inverse (c -> p) so the
    # prior works identically on bottom-up, top-down, upside-down stands, sideways SNOT, and angled hinges!
    R24 = ROT24.astype(np.float32)  # (24, 3, 3)
    Rp = R24[p_rot_i]               # (N, 3, 3)
    Rc = R24[c_rot_i]               # (N, 3, 3)
    dp_fwd = np.einsum("nji,nj->ni", Rp, dp_world) / 20.0
    dp_inv = np.einsum("nji,nj->ni", Rc, -dp_world) / 20.0
    R_fwd = np.einsum("nji,njk->nik", Rp, Rc)
    R_inv = np.swapaxes(R_fwd, 1, 2)

    p_ids = np.concatenate([p_ids, c_ids], axis=0)
    c_ids_orig = c_ids
    c_ids = np.concatenate([c_ids_orig, p_ids[:len(c_ids_orig)]], axis=0)
    dp_local = np.concatenate([dp_fwd, dp_inv], axis=0).astype(np.float32)
    R_rel = np.concatenate([R_fwd, R_inv], axis=0).astype(np.float32)
    r6_rel = _rotmat_to_6d(R_rel)
    sc_feat = np.concatenate([same_col, same_col], axis=0)[:, None].astype(np.float32)

    # Shuffle combined bidirectional pairs consistently before train/val split
    perm_all = rng.permutation(len(p_ids))
    p_ids, c_ids = p_ids[perm_all], c_ids[perm_all]
    dp_local, R_rel, r6_rel, sc_feat = dp_local[perm_all], R_rel[perm_all], r6_rel[perm_all], sc_feat[perm_all]

    N = len(p_ids)
    n_val = min(60_000, N // 20)
    tr_sl = slice(0, N - n_val)
    va_sl = slice(N - n_val, N)

    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    model = _build_net(n_base).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)

    # Precompute rotation twist matrices for fast on-GPU hard negative generation!
    R24_t = torch.from_numpy(R24).to(device)
    size_lut_t = torch.from_numpy(size_lut).to(device)

    def make_cont(pb_t, cb_t, dp_t, r6_t, sc_t):
        # Vectorized Fourier encode on GPU!
        freqs = torch.tensor([0.5, 1.0, 2.0, 4.0], device=device) * math.pi
        ang = dp_t.unsqueeze(-1) * freqs.view(1, 1, 4)
        fourier = torch.cat([
            dp_t.clamp(-8.0, 8.0) / 4.0,
            torch.sin(ang).reshape(len(dp_t), -1),
            torch.cos(ang).reshape(len(dp_t), -1),
        ], dim=-1)
        return torch.cat([size_lut_t[pb_t], size_lut_t[cb_t], fourier, r6_t, sc_t], dim=-1)

    p_tr = torch.from_numpy(p_ids[tr_sl].astype(np.int64))
    c_tr = torch.from_numpy(c_ids[tr_sl].astype(np.int64))
    dp_tr = torch.from_numpy(dp_local[tr_sl])
    r6_tr = torch.from_numpy(r6_rel[tr_sl])
    sc_tr = torch.from_numpy(sc_feat[tr_sl])
    rr_tr = torch.from_numpy(R_rel[tr_sl])

    p_va = torch.from_numpy(p_ids[va_sl].astype(np.int64)).to(device)
    c_va = torch.from_numpy(c_ids[va_sl].astype(np.int64)).to(device)
    dp_va = torch.from_numpy(dp_local[va_sl]).to(device)
    r6_va = torch.from_numpy(r6_rel[va_sl]).to(device)
    sc_va = torch.from_numpy(sc_feat[va_sl]).to(device)
    rr_va = torch.from_numpy(R_rel[va_sl]).to(device)

    n_tr = len(p_tr)
    for ep in range(epochs):
        model.train()
        perm = torch.randperm(n_tr)
        loss_sum, steps = 0.0, 0
        for i in range(0, n_tr, batch_size):
            idx = perm[i:i + batch_size]
            B = len(idx)
            pb = p_tr[idx].to(device)
            cb = c_tr[idx].to(device)
            dp = dp_tr[idx].to(device)
            r6 = r6_tr[idx].to(device)
            sc = sc_tr[idx].to(device)
            rr = rr_tr[idx].to(device)

            # Generate 4 targeted hard negatives per batch:
            # Neg 1: wrong relative rotation (random non-identity rot24 multiplied into R_rel)
            k_neg = torch.randint(1, 24, (B,), device=device)
            rr_bad = torch.bmm(rr, R24_t[k_neg])
            r6_bad = torch.cat([rr_bad[:, :, 0], rr_bad[:, :, 1]], dim=-1)

            # Neg 2: 0.5-1.5 stud / 1-plate local translation shift
            jitter = torch.zeros_like(dp)
            axis_j = torch.randint(0, 3, (B,), device=device)
            sgn_j = torch.where(torch.rand(B, device=device) > 0.5, 1.0, -1.0)
            mag_j = torch.where(axis_j == 1, 0.4 * torch.randint(1, 3, (B,), device=device).float(),
                                0.5 * torch.randint(1, 4, (B,), device=device).float())
            jitter[torch.arange(B, device=device), axis_j] = sgn_j * mag_j
            dp_shift = dp + jitter

            # Neg 3: wrong 90/180 yaw turn (pure horizontal spin - hardest visual tie!)
            k_yaw = torch.randint(1, 4, (B,), device=device)
            rr_yaw = torch.bmm(rr, R24_t[k_yaw])
            r6_yaw = torch.cat([rr_yaw[:, :, 0], rr_yaw[:, :, 1]], dim=-1)

            # Neg 4: swapped/backside pose from another sample in batch
            shuf = torch.randperm(B, device=device)
            dp_shuf = dp[shuf]
            r6_shuf = r6[shuf]
            sc_shuf = sc[shuf]

            pb_all = torch.cat([pb, pb, pb, pb, pb], dim=0)
            cb_all = torch.cat([cb, cb, cb, cb, cb], dim=0)
            cont_all = make_cont(
                pb_all, cb_all,
                torch.cat([dp, dp, dp_shift, dp, dp_shuf], dim=0),
                torch.cat([r6, r6_bad, r6, r6_yaw, r6_shuf], dim=0),
                torch.cat([sc, sc, sc, sc, sc_shuf], dim=0),
            )
            labels = torch.cat([torch.ones(B, device=device), torch.zeros(4 * B, device=device)], dim=0)
            logits = model(pb_all, cb_all, cont_all)
            w = torch.cat([torch.full((B,), 4.0, device=device), torch.ones(4 * B, device=device)], dim=0)
            loss = F.binary_cross_entropy_with_logits(logits, labels, weight=w)
            opt.zero_grad()
            loss.backward()
            opt.step()
            loss_sum += float(loss.item())
            steps += 1
        sched.step()

    # Evaluate validation accuracy on held-out clean pairs (pos vs rot-neg & shift-neg)
    model.eval()
    with torch.no_grad():
        B = len(p_va)
        pos_l = model(p_va, c_va, make_cont(p_va, c_va, dp_va, r6_va, sc_va))
        k_v = torch.randint(1, 24, (B,), device=device)
        rr_vb = torch.bmm(rr_va, R24_t[k_v])
        r6_vb = torch.cat([rr_vb[:, :, 0], rr_vb[:, :, 1]], dim=-1)
        neg_rot = model(p_va, c_va, make_cont(p_va, c_va, dp_va, r6_vb, sc_va))
        dp_vs = dp_va + torch.tensor([1.0, 0.0, 0.0], device=device)
        neg_sh = model(p_va, c_va, make_cont(p_va, c_va, dp_vs, r6_va, sc_va))
        rot_win = float((pos_l > neg_rot).float().mean().item())
        sh_win = float((pos_l > neg_sh).float().mean().item())

    out_path.parent.mkdir(parents=True, exist_ok=True)
    meta_out = {
        "version": 2,
        "bidirectional_se3_invariant": True,
        "n_clean_models": len(clean_indices),
        "n_excluded_models": n_excluded,
        "excluded_sets": sorted(forbidden),
        "n_pairs": int(N),
        "rot_win_acc": round(rot_win, 4),
        "shift_win_acc": round(sh_win, 4),
        "elapsed_sec": round(time.time() - t0, 1),
    }
    torch.save({
        "state_dict": {k: v.cpu() for k, v in model.state_dict().items()},
        "base_vocab": base_vocab,
        "size_lut": size_lut,
        "meta": meta_out,
    }, out_path)
    return meta_out


class BrickPriorScorer:
    """Fast (<1ms) neural structural prior over parent->child LEGO connector poses."""

    def __init__(self, path: Path = MODEL_PATH):
        import torch
        self.torch = torch
        ckpt = torch.load(path, map_location="cpu", weights_only=False)
        self.base_vocab: dict[str, int] = ckpt["base_vocab"]
        self.size_lut: np.ndarray = np.asarray(ckpt["size_lut"], dtype=np.float32)
        self.meta: dict = ckpt.get("meta", {})
        self.device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
        self.model = _build_net(len(self.base_vocab))
        self.model.load_state_dict(ckpt["state_dict"])
        self.model.eval().to(self.device)

    def score_pairs(self, host_parts: list[str], host_colors: list[int], host_mats: np.ndarray,
                    child_part: str, child_color: int, child_mats: np.ndarray) -> np.ndarray:
        """Score `N` `(host -> child)` connections; returns `(N,)` probabilities in `[0, 1]`."""
        N = len(child_mats)
        if N == 0:
            return np.zeros(0, dtype=np.float32)
        torch = self.torch
        pb = np.array([self.base_vocab.get(base_number(p), 0) for p in host_parts], dtype=np.int64)
        cb_id = self.base_vocab.get(base_number(child_part), 0)
        cb = np.full(N, cb_id, dtype=np.int64)

        Rp = host_mats[:, :3, :3].astype(np.float32)
        Rc = child_mats[:, :3, :3].astype(np.float32)
        dp_w = (child_mats[:, :3, 3] - host_mats[:, :3, 3]).astype(np.float32)
        dp_local = np.einsum("nji,nj->ni", Rp, dp_w) / 20.0
        R_rel = np.einsum("nji,njk->nik", Rp, Rc)
        r6_rel = _rotmat_to_6d(R_rel)
        sc = np.array([1.0 if int(hc) == int(child_color) else 0.0 for hc in host_colors], dtype=np.float32)[:, None]

        cont = np.concatenate([
            self.size_lut[pb],
            self.size_lut[cb],
            _fourier_encode(dp_local),
            r6_rel,
            sc,
        ], axis=-1).astype(np.float32)

        with torch.no_grad():
            logits = self.model(
                torch.from_numpy(pb).to(self.device),
                torch.from_numpy(cb).to(self.device),
                torch.from_numpy(cont).to(self.device),
            )
            probs = torch.sigmoid(logits).cpu().numpy()
        return probs.astype(np.float32)


def prior() -> BrickPriorScorer | None:
    global _SINGLETON, _LOAD_FAILED
    if not enabled() or _LOAD_FAILED or not MODEL_PATH.exists():
        return None
    if _SINGLETON is None:
        try:
            _SINGLETON = BrickPriorScorer(MODEL_PATH)
        except Exception:
            _LOAD_FAILED = True
            return None
    return _SINGLETON


if __name__ == "__main__":
    print("Training zero-leakage BrickPriorNet on clean 73k LEGO corpus...")
    res = train_clean_prior()
    print("Done:", json.dumps(res, indent=2))
