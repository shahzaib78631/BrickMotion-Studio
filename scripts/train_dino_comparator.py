"""Train a FoundationPose-style DINOv2 Spatial Render-and-Compare Head (`dino-spatial-comparator.pt`).

Uses ONLY the 32 clean non-EVAL6 train booklets already extracted in `.cache/booklet-mpd/layout-comparator-data/`
(strictly excluding EVAL6, validation, test, and CONTAMINATED sets).

Extracts frozen FoundPose multi-layer DINOv2 (`layers [7, 11]`) dense 16x16 patch features for both
the booklet picture crop and candidate NPR render crop, builds a 10-channel 16x16 spatial discrepancy
tensor:
  0: layer-7 patch cosine similarity
  1: layer-11 patch cosine similarity
  2-4: |pic_rgb - ren_rgb| per-channel L1 difference (downsampled to 16x16)
  5: Sobel edge magnitude correlation (pic vs render)
  6: added_vis_mask (16x16)
  7: pic_edge_map (16x16)
  8: ren_edge_map (16x16)
  9: signed edge excess (ren_edge - pic_edge)
and trains a compact (~40K param) 2D residual spatial head with listwise group InfoNCE loss.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

DATA_DIR = ROOT / ".cache/booklet-mpd/layout-comparator-data"
FEAT_CACHE = ROOT / ".cache/booklet-mpd/dino-spatial-feats.npz"
OUT_CKPT = ROOT / ".cache/booklet-mpd/dino-spatial-comparator.pt"
EVAL6 = {"40271", "40350", "41488", "41605", "41620", "40348"}


def _sobel_mag(rgb: np.ndarray) -> np.ndarray:
    g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    mag = np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3))
    sc = max(float(np.percentile(mag, 98)), 25.0)
    return np.clip(mag / sc, 0.0, 1.0)


def build_spatial_features_batch(perc, pics_rgb: np.ndarray, rens_rgb: np.ndarray,
                                 vis_masks: np.ndarray, pic_edges: np.ndarray | None = None,
                                 batch_size: int = 64) -> np.ndarray:
    """Compute `(N, 10, 16, 16)` float32 spatial comparison maps using frozen DINOv2 [7, 11]."""
    N = len(pics_rgb)
    out = np.zeros((N, 10, 16, 16), dtype=np.float32)
    device = perc.device
    mean = perc.mean
    std = perc.std

    for i0 in range(0, N, batch_size):
        i1 = min(N, i0 + batch_size)
        B = i1 - i0
        p224 = np.stack([cv2.resize(pics_rgb[k], (224, 224), interpolation=cv2.INTER_LINEAR) for k in range(i0, i1)])
        r224 = np.stack([cv2.resize(rens_rgb[k], (224, 224), interpolation=cv2.INTER_LINEAR) for k in range(i0, i1)])
        both = np.concatenate([p224, r224], axis=0).astype(np.float32) / 255.0
        x = torch.from_numpy(both).permute(0, 3, 1, 2).to(device)
        x = (x - mean) / std
        with torch.no_grad():
            layers = perc.model.get_intermediate_layers(x, n=[7, 11], reshape=False, return_class_token=False, norm=True)
            p7 = F.normalize(layers[0][:B], dim=-1)
            r7 = F.normalize(layers[0][B:], dim=-1)
            c7 = (p7 * r7).sum(dim=-1).reshape(B, 16, 16).cpu().numpy()

            p11 = F.normalize(layers[1][:B], dim=-1)
            r11 = F.normalize(layers[1][B:], dim=-1)
            c11 = (p11 * r11).sum(dim=-1).reshape(B, 16, 16).cpu().numpy()

        for b in range(B):
            k = i0 + b
            p_rgb = pics_rgb[k]
            r_rgb = rens_rgb[k]
            diff = np.abs(p_rgb.astype(np.float32) - r_rgb.astype(np.float32)) / 255.0
            diff16 = cv2.resize(diff, (16, 16), interpolation=cv2.INTER_AREA).transpose(2, 0, 1)
            pe = (pic_edges[k].astype(np.float32) / 255.0) if pic_edges is not None else _sobel_mag(p_rgb)
            re = _sobel_mag(r_rgb)
            pe16 = cv2.resize(pe, (16, 16), interpolation=cv2.INTER_AREA)
            re16 = cv2.resize(re, (16, 16), interpolation=cv2.INTER_AREA)
            ecorr16 = cv2.resize(pe * re, (16, 16), interpolation=cv2.INTER_AREA)
            vm16 = cv2.resize(vis_masks[k].astype(np.float32) / 255.0, (16, 16), interpolation=cv2.INTER_AREA)
            out[k, 0] = c7[b]
            out[k, 1] = c11[b]
            out[k, 2:5] = diff16
            out[k, 5] = ecorr16
            out[k, 6] = vm16
            out[k, 7] = pe16
            out[k, 8] = re16
            out[k, 9] = re16 - pe16
    return out


class DinoSpatialHead(nn.Module):
    """Compact ~38K-param FoundationPose-style spatial comparator over (B, 10, 16, 16) feature maps."""

    def __init__(self, in_ch: int = 10):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(in_ch, 32, 3, padding=1, bias=False),
            nn.BatchNorm2d(32),
            nn.SiLU(inplace=True),
            nn.Conv2d(32, 48, 3, stride=2, padding=1, bias=False),  # 8x8
            nn.BatchNorm2d(48),
            nn.SiLU(inplace=True),
            nn.Conv2d(48, 64, 3, stride=2, padding=1, bias=False),  # 4x4
            nn.BatchNorm2d(64),
            nn.SiLU(inplace=True),
        )
        self.head = nn.Sequential(
            nn.Linear(128, 32),
            nn.SiLU(inplace=True),
            nn.Dropout(0.15),
            nn.Linear(32, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        f = self.net(x)
        pooled = torch.cat([f.mean(dim=(2, 3)), f.amax(dim=(2, 3))], dim=1)
        return self.head(pooled).squeeze(-1)


def main() -> None:
    from booklet_mpd.protocol import CONTAMINATED, heldout_sets
    from booklet_mpd.solver.dataset import grades
    from booklet_mpd.solver.vision_prior import perceptor

    t0 = time.time()
    g = grades()
    forbidden = set(heldout_sets(g, "validation")) | set(heldout_sets(g, "test")) | set(CONTAMINATED) | EVAL6

    files = sorted(f for f in DATA_DIR.glob("*.npz") if not f.name.startswith("._"))
    clean_files = [f for f in files if f.stem not in forbidden]
    assert len(clean_files) >= 10, f"Too few clean comparator sets: {len(clean_files)}"
    for f in clean_files:
        assert f.stem not in forbidden, f"Leakage: {f.stem}"

    if FEAT_CACHE.exists():
        cache = np.load(FEAT_CACHE, allow_pickle=False)
        F_all = cache["F"]
        G_all = cache["G"]
        L_all = cache["L"]
        S_all = cache["S"]
        IS_DEV = cache["IS_DEV"]
        print(f"Loaded cached DINO spatial features: {F_all.shape}")
    else:
        perc = perceptor()
        assert perc is not None, "DINOv2 perceptor unavailable"
        F_list, G_list, L_list, S_list, D_list = [], [], [], [], []
        g_off = 0
        dev_sids = {clean_files[i].stem for i in range(1, len(clean_files), 6)}
        for fi, f in enumerate(clean_files):
            d = np.load(f)
            X = d["X"]  # (N, 8, 96, 96) uint8
            if len(X) == 0:
                continue
            pics = X[:, 0:3].transpose(0, 2, 3, 1)
            rens = X[:, 3:6].transpose(0, 2, 3, 1)
            vis = X[:, 6]
            pe = X[:, 7]
            feats = build_spatial_features_batch(perc, pics, rens, vis, pe, batch_size=64)
            grp = d["group"].astype(np.int64) + g_off
            g_off = int(grp.max()) + 1
            F_list.append(feats)
            G_list.append(grp)
            L_list.append(d["label"].astype(np.int64))
            S_list.append(d["score"].astype(np.float32))
            D_list.append(np.full(len(X), 1 if f.stem in dev_sids else 0, dtype=np.int8))
            if (fi + 1) % 8 == 0 or fi + 1 == len(clean_files):
                print(f"  extracted {fi+1}/{len(clean_files)} sets ({sum(len(x) for x in F_list)} patches, {time.time()-t0:.1f}s)", flush=True)
        F_all = np.concatenate(F_list, axis=0)
        G_all = np.concatenate(G_list, axis=0)
        L_all = np.concatenate(L_list, axis=0)
        S_all = np.concatenate(S_list, axis=0)
        IS_DEV = np.concatenate(D_list, axis=0)
        np.savez_compressed(FEAT_CACHE, F=F_all, G=G_all, L=L_all, S=S_all, IS_DEV=IS_DEV)
        print(f"Saved {FEAT_CACHE} ({F_all.shape})")

    # Build train & dev groups (each group has >=2 candidates and exactly 1 positive!)
    tr_groups, dev_groups = [], []
    for gid in np.unique(G_all):
        idx = np.flatnonzero(G_all == gid)
        pos = np.flatnonzero(L_all[idx] == 1)
        if len(idx) < 2 or len(pos) != 1:
            continue
        item = (idx, int(pos[0]))
        if IS_DEV[idx[0]]:
            dev_groups.append(item)
        else:
            tr_groups.append(item)
    print(f"Groups: train={len(tr_groups)}, inner_dev={len(dev_groups)}")

    # Baseline on inner_dev: raw ModelScorer vs zero-shot DINO cosine (ch0+ch1 weighted by ch6)
    ms_ok, raw_dino_ok = 0, 0
    for idx, pos_k in dev_groups:
        if int(np.argmax(S_all[idx])) == pos_k:
            ms_ok += 1
        w = F_all[idx, 6] + 0.1
        d_sc = ((0.5 * F_all[idx, 0] + 0.5 * F_all[idx, 1]) * w).sum(axis=(1, 2)) / w.sum(axis=(1, 2))
        if int(np.argmax(d_sc)) == pos_k:
            raw_dino_ok += 1
    print(f"inner_dev baseline Top-1: ModelScorer={ms_ok}/{len(dev_groups)} ({100*ms_ok/max(1,len(dev_groups)):.1f}%) | ZeroShot-DINO={raw_dino_ok}/{len(dev_groups)} ({100*raw_dino_ok/max(1,len(dev_groups)):.1f}%)")

    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    F_t = torch.from_numpy(F_all).to(device)
    model = DinoSpatialHead(10).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=1.5e-3, weight_decay=2e-3)
    epochs = 25
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
    rng = np.random.default_rng(42)

    best_dev, best_state = -1.0, None
    for ep in range(epochs):
        model.train()
        order = rng.permutation(len(tr_groups))
        # Mini-batch 16 groups per optimizer step
        loss_sum = 0.0
        for b0 in range(0, len(order), 16):
            opt.zero_grad()
            batch_loss = 0.0
            cnt = 0
            for gi in order[b0:b0 + 16]:
                idx, pos_k = tr_groups[int(gi)]
                x_g = F_t[idx]
                # Random horizontal flip augmentation preserves spatial match!
                if rng.random() < 0.5:
                    x_g = torch.flip(x_g, dims=[-1])
                logits = model(x_g)
                loss_g = F.cross_entropy(logits.unsqueeze(0), torch.tensor([pos_k], device=device))
                batch_loss = batch_loss + loss_g
                cnt += 1
            (batch_loss / max(1, cnt)).backward()
            opt.step()
            loss_sum += float(batch_loss.item())
        sched.step()

        model.eval()
        dev_ok, blend_ok = 0, 0
        with torch.no_grad():
            for idx, pos_k in dev_groups:
                lg = model(F_t[idx]).cpu().numpy()
                if int(np.argmax(lg)) == pos_k:
                    dev_ok += 1
                s = S_all[idx]
                z = lg - lg.mean()
                sp = min(max(float(np.std(s)), 15.0), 250.0)
                if int(np.argmax(s + 0.65 * sp * z)) == pos_k:
                    blend_ok += 1
        acc = dev_ok / max(1, len(dev_groups))
        bacc = blend_ok / max(1, len(dev_groups))
        if bacc > best_dev or (bacc == best_dev and acc > best_dev):
            best_dev = bacc
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}
        if (ep + 1) % 5 == 0 or ep + 1 == epochs:
            print(f"  ep {ep+1:2d}: loss={loss_sum/max(1,len(tr_groups)):.4f} | dev Top-1={dev_ok}/{len(dev_groups)} ({100*acc:.1f}%) | MS+Head={blend_ok}/{len(dev_groups)} ({100*bacc:.1f}%)", flush=True)

    meta = {
        "train_sets": sorted(f.stem for f in clean_files),
        "excluded_sets": sorted(forbidden),
        "n_train_groups": len(tr_groups),
        "n_dev_groups": len(dev_groups),
        "dev_ms_top1": round(ms_ok / max(1, len(dev_groups)), 4),
        "dev_dino_raw_top1": round(raw_dino_ok / max(1, len(dev_groups)), 4),
        "dev_blend_top1": round(best_dev, 4),
        "elapsed_sec": round(time.time() - t0, 1),
    }
    torch.save({"state_dict": best_state, "meta": meta}, OUT_CKPT)
    print(f"Saved {OUT_CKPT}: {json.dumps(meta, indent=2)}")


if __name__ == "__main__":
    main()
