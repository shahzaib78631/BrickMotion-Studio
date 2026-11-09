"""Piece-to-piece habits from BrickNet: for every part, where other parts get attached to it, and how
often, counted over all 67k BrickNet models. Feeds "What fits here?" (src/suggest/fitsAt.ts).

    python -I habits.py DATA_DIR OUT_JSON [--top 48] [--min 3]

Each BrickNet joint says exactly where part b sits in part a's frame:
    M = frame_a[conn_a] · joint(kind, yaw, flip, rot) · inv(frame_b[conn_b])
so the poses are counted straight from the joints, without rebuilding the models. A pose counts
once per model (eight studs of one 2×4 on another are one habit), in both directions.

Output (LDraw axes, LDU): {models, parts: [stem], rots: [[r00..r22]], habits: {stem: [[other,
rot, tx, ty, tz, models, same colour %, kind], ...]}}, best first. W_other = W_anchor · [rot|t].
Data: BrickNet (Kulits & Schmid, CVPR 2026), github.com/kulits/BrickNet.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import decode  # noqa: E402


def ry(a: np.ndarray) -> np.ndarray:
    c, s = np.cos(a), np.sin(a)
    m = np.zeros((len(a), 4, 4))
    m[:, 0, 0], m[:, 0, 2], m[:, 1, 1], m[:, 2, 0], m[:, 2, 2], m[:, 3, 3] = c, s, 1, -s, c, 1
    return m


def joints(kind: np.ndarray, yaw: np.ndarray, flip: np.ndarray, rot: np.ndarray) -> np.ndarray:
    """decode.joint for every edge at once."""
    n = len(kind)
    J = np.tile(np.eye(4), (n, 1, 1))
    k = {name: kind == i for i, name in enumerate(decode.KINDS)}
    sh = k['stud'] | k['hole']
    J[sh] = ry(yaw[sh])
    h = k['hinge']
    J[h] = ry(yaw[h])
    hf = h & flip
    J[hf] = J[hf] @ decode.RX_PI
    a = k['axle']
    J[a] = ry(rot[a, 0])
    af = a & flip
    J[af] = J[af] @ decode.RX_PI
    J[a, 1, 3] = -yaw[a]
    for i in np.flatnonzero(k['ball']):
        J[i] = decode.euler_xyz(*rot[i])
    return J


def main() -> None:
    args = sys.argv[1:]
    d, out = Path(args[0]), Path(args[1])
    top = int(args[args.index('--top') + 1]) if '--top' in args else 48
    least = int(args[args.index('--min') + 1]) if '--min' in args else 3
    arrs = decode.load(d / 'sft.npz')
    cat = decode.Catalog(d)
    node_ptr, edge_ptr = arrs['node_ptr'], arrs['edge_ptr']
    n_models = len(node_ptr) - 1
    pids, colors = arrs['part_ids'], arrs['colors']

    # every used part's connector frames in one table
    used = np.unique(pids)
    off = np.full(int(used.max()) + 1, -1, dtype=np.int64)
    blocks, at = [], 0
    for p in used:
        try:
            f = cat.frames(int(p))
        except KeyError:
            f = np.zeros((0, 4, 4))
        off[p] = at
        blocks.append(f)
        at += len(f)
    F = np.concatenate(blocks)
    print(f'::progress 1/5 frames for {len(used)} parts ({at} connectors)', flush=True)

    model_of_edge = np.repeat(np.arange(n_models), np.diff(edge_ptr))
    base = node_ptr[model_of_edge]
    ei = arrs['edge_idx']
    na, nb = base + ei[:, 0], base + ei[:, 2]
    pa, pb = pids[na], pids[nb]
    ia, ib = off[pa] + ei[:, 1], off[pb] + ei[:, 3]
    nconn = np.array([len(b) for b in blocks])
    cnt = np.zeros_like(off)
    cnt[used] = nconn
    ok = (ei[:, 1] < cnt[pa]) & (ei[:, 3] < cnt[pb]) & (cnt[pa] > 0) & (cnt[pb] > 0)
    print(f'{ok.sum()} of {len(ok)} joints usable', flush=True)

    sel = np.flatnonzero(ok)
    J = joints(arrs['edge_kind'][sel], arrs['edge_yaw'][sel], arrs['edge_flip'][sel], arrs['edge_rot'][sel])
    Fb = F[ib[sel]]
    Fb_inv = np.linalg.inv(Fb)
    M = F[ia[sel]] @ J @ Fb_inv
    Minv = np.linalg.inv(M)
    print('::progress 2/5 joint poses', flush=True)

    def rows(M, a, b):
        r = np.round(M[:, :3, :3].reshape(-1, 9) * 1000).astype(np.int32)
        t = np.round(M[:, :3, 3]).astype(np.int32)
        return np.column_stack([model_of_edge[sel], a, b, r, t, arrs['edge_kind'][sel].astype(np.int32)])

    same = (colors[na[sel]] == colors[nb[sel]]).astype(np.int32)
    R = np.concatenate([rows(M, pa[sel], pb[sel]), rows(Minv, pb[sel], pa[sel])])
    S = np.concatenate([same, same])
    del M, Minv, J, Fb, Fb_inv
    # once per model
    uniq, inv = np.unique(R, axis=0, return_inverse=True)
    inv = inv.ravel()
    s1 = np.zeros(len(uniq), dtype=np.int32)
    np.maximum.at(s1, inv, S)
    del R, S
    print(f'::progress 3/5 {len(uniq)} (model, habit) pairs', flush=True)
    keys, inv2, models = np.unique(uniq[:, 1:], axis=0, return_inverse=True, return_counts=True)
    inv2 = inv2.ravel()
    same_n = np.bincount(inv2, weights=s1, minlength=len(keys))
    print(f'::progress 4/5 {len(keys)} distinct habits', flush=True)

    keep = models >= least
    keys, models, same_n = keys[keep], models[keep], same_n[keep]
    order = np.lexsort((-models, keys[:, 0]))
    rot_ids: dict[tuple, int] = {}
    rots: list[list[float]] = []
    habits: dict[str, list] = {}
    stems = cat.stems
    part_ids: dict[int, int] = {}
    parts: list[str] = []

    def part(p: int) -> int:
        if p not in part_ids:
            part_ids[p] = len(parts)
            parts.append(stems[p])
        return part_ids[p]

    for i in order:
        k = keys[i]
        anchor = stems[int(k[0])]
        lst = habits.setdefault(anchor, [])
        if len(lst) >= top:
            continue
        rk = tuple(int(v) for v in k[2:11])
        if rk not in rot_ids:
            rot_ids[rk] = len(rots)
            rots.append([v / 1000 for v in rk])
        lst.append([part(int(k[1])), rot_ids[rk], int(k[11]), int(k[12]), int(k[13]), int(models[i]),
                    int(round(100 * same_n[i] / models[i])), decode.KINDS[int(k[14])]])
    # parts most often joined by each kind of joint, whatever they join to: the fallback for an anchor part
    # with no habits of its own
    kp, kc = np.unique(uniq[:, [14, 2, 0]], axis=0)[:, :2], None
    kp, kc = np.unique(kp, axis=0, return_counts=True)
    partners: dict[str, list] = {}
    for kind in range(len(decode.KINDS)):
        m = kp[:, 0] == kind
        o = np.argsort(-kc[m])[:24]
        partners[decode.KINDS[kind]] = [[part(int(kp[m][j, 1])), int(kc[m][j])] for j in o]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({'models': n_models, 'source': 'BrickNet (Kulits & Schmid, CVPR 2026)',
                               'parts': parts, 'rots': rots, 'habits': habits, 'partners': partners},
                              separators=(',', ':')))
    print(f'::progress 5/5 {len(habits)} anchor parts, {sum(map(len, habits.values()))} habits, '
          f'{len(rots)} rotations, {out.stat().st_size / 1e6:.1f} MB', flush=True)


if __name__ == '__main__':
    main()
