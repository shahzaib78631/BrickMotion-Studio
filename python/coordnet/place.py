"""New-part placement with CoordNet: pick each new part's pose among its connection candidates.

With the camera solved, a candidate is judged by render-and-compare:

1. Pre-filter (cheap, all candidates): project ~250 points of the part at each candidate pose and average the
   new-part evidence there (picture foreground that the model so far does not cover), minus the share that falls
   on bare paper. Keeps the best `keep` non-colliding poses per part type.
2. Full score (shortlist): render the model + the parts placed so far + the candidate (booklet style, red on the
   new parts, as the picture) and run the network picture -> render. With the camera solved, a pixel agrees when
   the network is confident and its flow is near zero. Over the region where the candidate can matter (its own
   render pixels and the picture's unexplained foreground, dilated) score = agreeing - disagreeing pixels. A wrong
   pose shows the part where the picture has something else (disagree) and leaves the real part unexplained
   (disagree); a pose one stud off or deeper along the line of sight leaves a consistent offset (flow not zero).
   The network's new-part head is not used (it is weak on real pages).
3. Greedy: place the best-scoring candidate of any still-needed part type, re-score the others against the new
   model, repeat. Candidates that would overlap an already placed part (same type within 1 LDU) are skipped.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .camera import BookletCamera, project
from . import render as R
from .solve import correspondences


@dataclass
class Scored:
    type: str
    colour: int
    index: int
    matrix: np.ndarray
    score: float
    agree: int
    disagree: int
    residual: float


def part_points(part: str, n: int = 250, seed: int = 0) -> np.ndarray:
    v = np.unique(R.part_triangles(part).reshape(-1, 3).round(2), axis=0)
    if len(v) > n:
        v = v[np.random.default_rng(seed).choice(len(v), n, replace=False)]
    return v


def prefilter(part: str, cands: list[np.ndarray], cam: BookletCamera, centre, newprob: np.ndarray,
              fg: np.ndarray, keep: int = 12) -> list[int]:
    H, W = newprob.shape
    pts = part_points(part)
    prob = cv2.dilate(newprob.astype(np.float32), np.ones((3, 3), np.uint8))
    scores = []
    M = np.stack(cands)                                           # [C,4,4]
    world = np.einsum("cij,pj->cpi", M[:, :3, :3], pts) + M[:, None, :3, 3]
    uv, _ = project(cam, centre, world.reshape(-1, 3))
    uv = uv.reshape(len(cands), len(pts), 2)
    x = np.floor(uv[..., 0]).astype(int)
    y = np.floor(uv[..., 1]).astype(int)
    inside = (x >= 0) & (x < W) & (y >= 0) & (y < H)
    xc, yc = np.clip(x, 0, W - 1), np.clip(y, 0, H - 1)
    p = np.where(inside, prob[yc, xc], 0.0)
    paper = np.where(inside, ~fg[yc, xc], True)
    scores = p.mean(1) - 0.5 * paper.mean(1)
    order = np.argsort(-scores)
    return [int(i) for i in (order if keep is None else order[:keep])]


def score_candidate(net, picture: np.ndarray, model: list, new_idx: set[int], cand_idx: int,
                    cam: BookletCamera, centre, W: int, H: int, evidence: np.ndarray,
                    tol: float = 1.5) -> tuple[float, int, int, float]:
    """(score, agreeing, disagreeing, median |flow| on the candidate) of the candidate at index `cand_idx`."""
    ren = R.render(model, new_idx, cam, centre, W, H, R.Style(), ss=2)
    flow, conf, _new = net(picture, ren.picture)
    cand = ren.gt.part == cand_idx
    k = np.ones((5, 5), np.uint8)
    region = cv2.dilate((cand | evidence).astype(np.uint8), k).astype(bool)
    mag = np.linalg.norm(flow, axis=0)
    agree = (conf > 0.5) & (mag < tol)
    good = int((agree & region).sum())
    bad = int((~agree & region).sum())
    res = float(np.median(mag[cand & (conf > 0.5)])) if (cand & (conf > 0.5)).any() else float("inf")
    return float(good - bad), good, bad, res


def place_step(net, picture: np.ndarray, base: list, need: dict[tuple[str, int], int],
               cands: dict[tuple[str, int], list[np.ndarray]], cam: BookletCamera, centre, keep: int = 12,
               log=None, collider=None) -> list[Scored]:
    """Greedy placement. need: {(part, colour): count}; cands: {(part, colour): [4x4 row-major]}.
    With a collider (booklet_mpd.solver.collide.Collider) poses that intersect the model are never scored."""
    H, W = picture.shape[:2]
    fg = np.abs(picture.astype(int) - np.median(picture.reshape(-1, 3), 0)).sum(-1) > 30
    placed: list[Scored] = []
    need = dict(need)
    while any(v > 0 for v in need.values()):
        model = list(base) + [(s.type, s.colour, s.matrix) for s in placed]
        new_idx = set(range(len(base), len(model)))
        # the network's view of where the new parts are, with the current model rendered
        # new-part evidence: picture foreground that the model so far does not cover
        cover = R.gbuffer(*R.scene(model), cam, centre, W, H).part >= 0
        cover = cv2.dilate(cover.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
        evidence = fg & ~cover
        if collider is not None:
            collider.set_model(model)
        best: Scored | None = None
        for key, n in need.items():
            if n <= 0:
                continue
            part, colour = key
            pool = [m for m in cands[key]
                    if not any(s.type == part and np.abs(s.matrix[:3, 3] - m[:3, 3]).max() < 1 for s in placed)]
            if not pool:
                continue
            short = []
            for j in prefilter(part, pool, cam, centre, evidence.astype(np.float32), fg, None):
                if collider is not None and collider.hits(part, pool[j]):
                    continue
                short.append(j)
                if len(short) == keep:
                    break
            for j in short:
                trial = model + [(part, colour, pool[j])]
                sc, ex, mi, res = score_candidate(net, picture, trial, new_idx | {len(model)}, len(model), cam,
                                                  centre, W, H, evidence)
                s = Scored(part, colour, int(j), pool[j], sc, ex, mi, res)
                if log:
                    log(dict(type=part, colour=colour, cand=int(j), pos=pool[j][:3, 3].round(1).tolist(), score=sc,
                             agree=ex, disagree=mi, residual=res))
                if best is None or s.score > best.score:
                    best = s
        if best is None:
            break
        placed.append(best)
        need[(best.type, best.colour)] -= 1
        if log:
            log(dict(placed=best.type, pos=best.matrix[:3, 3].round(1).tolist(), score=best.score))
    return placed


def change_evidence(picture: np.ndarray, base_render: np.ndarray, thresh: float = 60.0) -> np.ndarray:
    """Pixels where the picture differs from a booklet-style render of the model so far: the new parts (also where
    they sit in front of old parts) and their red outline."""
    a = cv2.GaussianBlur(picture.astype(np.float32), (0, 0), 1.5)
    b = cv2.GaussianBlur(base_render.astype(np.float32), (0, 0), 1.5)
    ev = (np.abs(a - b).sum(-1) > thresh) & ~red_band(picture)
    return cv2.morphologyEx(ev.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)).astype(bool)


def red_band(picture: np.ndarray) -> np.ndarray:
    """Studio's new-part highlight: a red band drawn just outside the new parts' silhouette."""
    r, g, b = (picture[..., i].astype(int) for i in range(3))
    red = (r > 140) & (r - g > 70) & (r - b > 70)
    return cv2.dilate(red.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)


@dataclass
class Footprint:
    type: str
    colour: int
    matrix: np.ndarray
    mask: np.ndarray            # visible pixels (not hidden by the model so far), at 1/`step` resolution
    box: np.ndarray             # world AABB [2,3]


def footprints(scene: "JointScene", part: str, colour: int, cands: list[np.ndarray], collider=None,
               min_on: float = 0.35) -> list[Footprint]:
    """Footprints of the candidates that are plausible at all: most of the part's points on the evidence, no
    collision with the model so far, one per distinct occupied geometry."""
    W, H = scene.W, scene.H
    keep = prefilter(part, cands, scene.cam, scene.centre, scene.ev.astype(np.float32),
                     scene.ev | (scene.depth < np.inf), None)
    pts = part_points(part)
    verts = np.unique(R.part_triangles(part).reshape(-1, 3).round(3), axis=0)
    out, seen = [], set()
    for j in keep:
        m = cands[j]
        uv, _ = project(scene.cam, scene.centre, pts @ m[:3, :3].T + m[:3, 3])
        x, y = uv[:, 0].astype(int), uv[:, 1].astype(int)
        ins = (x >= 0) & (x < W) & (y >= 0) & (y < H)
        if np.where(ins, scene.ev[np.clip(y, 0, H - 1), np.clip(x, 0, W - 1)], False).mean() < min_on:
            continue
        key = (np.unique((verts @ m[:3, :3].T + m[:3, 3]).round(1), axis=0) + 0.0).tobytes()   # +0.0: -0.0 == 0.0
        if key in seen:
            continue
        if collider is not None and collider.hits(part, m):
            continue
        seen.add(key)
        f = scene.footprint(part, colour, m)
        if f.mask.any():                                # wholly hidden behind the model: nothing to compare
            out.append(f)
    return out


def _boxes_overlap(a: np.ndarray, b: np.ndarray, tol: float = 2.0) -> bool:
    return bool(np.all(np.minimum(a[1], b[1]) - np.maximum(a[0], b[0]) > tol))


class JointScene:
    """What the step's new parts must explain, at half resolution: the change evidence, the red band, and the
    model's depth (a footprint pixel behind an old part is hidden)."""

    def __init__(self, picture: np.ndarray, base: list, cam: BookletCamera, centre, outside: float = 1.0):
        H, W = picture.shape[:2]
        self.cam, self.centre, self.W, self.H, self.outside = cam, centre, W, H, outside
        rb = R.render(base, set(), cam, centre, W, H, R.Style(), ss=2, red=False).picture
        self.ev = change_evidence(picture, rb)
        g = R.gbuffer(*R.scene(base), cam, centre, W, H)
        self.depth = np.where(g.part >= 0, g.depth, np.inf)
        self.evs = self.ev[::2, ::2]
        self.reds = red_band(picture)[::2, ::2]

    def score(self, union: np.ndarray) -> float:
        # footprint on the red band is a contradiction: the band lies outside the new parts
        o = self.outside
        return float((union & self.evs).sum() - o * (union & ~self.evs & ~self.reds).sum()
                     - 4 * o * (union & self.reds).sum())

    def footprint(self, part: str, colour: int, m: np.ndarray) -> Footprint:
        g = R.gbuffer(*R.scene([(part, colour, m)]), self.cam, self.centre, self.W, self.H)
        vis = (g.part >= 0) & (g.depth < self.depth + 1.0)
        vw = np.unique(R.part_triangles(part).reshape(-1, 3).round(3), axis=0) @ m[:3, :3].T + m[:3, 3]
        return Footprint(part, colour, m, vis[::2, ::2].copy(), np.stack([vw.min(0), vw.max(0)]))

    def render_error(self, picture: np.ndarray, base: list, added: list) -> float:
        """Mean blurred colour difference between the picture and the full booklet-style render (new parts red),
        over the picture's and the render's foreground."""
        model = list(base) + list(added)
        ren = R.render(model, set(range(len(base), len(model))), self.cam, self.centre, self.W, self.H, R.Style(),
                       ss=2).picture
        a = cv2.GaussianBlur(picture.astype(np.float32), (0, 0), 1.0)
        b = cv2.GaussianBlur(ren.astype(np.float32), (0, 0), 1.0)
        paper = np.median(picture.reshape(-1, 3), 0)
        fg = (np.abs(picture.astype(int) - paper).sum(-1) > 30) | (np.abs(ren.astype(int) - paper).sum(-1) > 30)
        return float(np.abs(a - b).sum(-1)[fg].mean())

    def score_set(self, fs) -> float:
        return self.score(_union(fs, self.evs.shape))


@dataclass
class Layer:
    x0: int
    y0: int
    colour: np.ndarray          # [h,w,3] float32, booklet style
    depth: np.ndarray           # [h,w] (inf off the part)


class Compositor:
    """Cheap render-and-compare for whole layouts: each candidate is rendered once, alone, as a booklet-style
    layer with depth (over its screen box only); a layout is the depth composite of the model's render and its
    layers, with the red band drawn around the new parts' union, compared to the picture (blurred colour
    difference summed over the image). Mutual line occlusion between new parts is approximated."""

    def __init__(self, scene: "JointScene", picture: np.ndarray, base: list, style=None, margin: int = 4):
        self.sc, self.margin = scene, margin
        self.style = style or R.Style()
        W, H = scene.W, scene.H
        r = R.render(base, set(), scene.cam, scene.centre, W, H, self.style, ss=1, red=False)
        self.base_colour = r.picture.astype(np.float32)
        self.base_depth = np.where(r.gt.part >= 0, r.gt.depth, np.inf).astype(np.float32)
        self.pic_blur = cv2.GaussianBlur(picture.astype(np.float32), (0, 0), 1.0)
        self.red = np.array(self.style.red, np.float32)
        self.red_px = int(round(self.style.red_px))
        self.cache: dict = {}

    def layer(self, f: Footprint) -> Layer:
        k = id(f)
        if k not in self.cache:
            ys, xs = np.nonzero(f.mask)
            m, W, H = self.margin, self.sc.W, self.sc.H
            x0, x1 = max(0, 2 * xs.min() - m), min(W, 2 * xs.max() + 2 + m)
            y0, y1 = max(0, 2 * ys.min() - m), min(H, 2 * ys.max() + 2 + m)
            cam = self.sc.cam.with_(cx=self.sc.cam.cx - x0, cy=self.sc.cam.cy - y0)
            r = R.render([(f.type, f.colour, f.matrix)], set(), cam, self.sc.centre, x1 - x0, y1 - y0, self.style,
                         ss=1, red=False)
            # dark outline lines sit on the silhouette edge: keep a 1 px ring around the part as part of the layer
            on = r.gt.part >= 0
            ring = cv2.dilate(on.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~on
            d = np.where(on, r.gt.depth, np.inf).astype(np.float32)
            dn = cv2.erode(np.where(on, r.gt.depth, 1e9).astype(np.float32), np.ones((3, 3), np.uint8))
            d = np.where(ring, dn, d)
            self.cache[k] = Layer(x0, y0, r.picture.astype(np.float32), d)
        return self.cache[k]

    def composite(self, fs) -> np.ndarray:
        img = self.base_colour.copy()
        depth = self.base_depth.copy()
        new = np.zeros(depth.shape, bool)
        for f in fs:
            L = self.layer(f)
            h, w = L.depth.shape
            sl = (slice(L.y0, L.y0 + h), slice(L.x0, L.x0 + w))
            front = L.depth < depth[sl]
            img[sl][front] = L.colour[front]
            depth[sl] = np.where(front, L.depth, depth[sl])
            new[sl] |= front
        if self.red_px > 0 and new.any():
            k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * self.red_px + 1, 2 * self.red_px + 1))
            band = cv2.dilate(new.astype(np.uint8), k).astype(bool) & ~new & ~np.isfinite(depth)
            img[band] = self.red
        return img

    def error(self, fs) -> float:
        b = cv2.GaussianBlur(self.composite(fs), (0, 0), 1.0)
        return float(np.abs(self.pic_blur - b).sum() / 1e3)


def place_joint(picture: np.ndarray, base: list, need: dict[tuple[str, int], int],
                cands: dict[tuple[str, int], list[np.ndarray]], cam: BookletCamera, centre, collider=None,
                seeds: int = 16, per_type: int = 120, outside: float = 1.0, verify: int = 4, log=None,
                scene: JointScene | None = None, init: list | None = None, pair_n: int = 25):
    """Choose all of a step's new parts together. Identical parts that tile one area (four 4x10 plates side by side)
    cannot be judged one at a time - any one of them fits the stud field, and a part one plate higher and 20 LDU
    nearer covers nearly the same pixels - so whole layouts are compared with the picture.

    1. Footprints: candidates mostly on the change evidence, not colliding with the model (exact collider), one per
       distinct geometry; the `per_type` best by coverage (evidence pixels minus `outside` per pixel off it, 4x on
       the red band) are kept.
    2. Each of the `seeds` best single footprints starts a greedy completion by coverage, then single-part swaps
       while the composite render error (`Compositor`) falls, then pair moves: two parts that touch on screen are
       re-placed together among the `pair_n` best local footprints of each (a part stacked on another new part
       must move with its host). New parts must not intersect each other (boxes, then the exact collider).
    3. The `verify` best distinct layouts are rendered in full (supersampled) and the closest to the picture wins.
    `init`: layouts [(part, colour, matrix)] to refine as extra seeds (a previous round's answer).
    Returns (placed [(part, colour, matrix)], stats)."""
    H, W = picture.shape[:2]
    sc = scene or JointScene(picture, base, cam, centre, outside)
    if collider is not None:
        collider.set_model(list(base))
    pool: dict = {}
    for key in need:
        pool[key] = footprints(sc, key[0], key[1], cands[key], collider)
        if log:
            log(dict(type=key[0], footprints=len(pool[key])))
    shape = sc.evs.shape
    n_total = sum(need.values())

    # the composite comparison renders a layer per candidate: keep the best `per_type` footprints of each type
    for key in pool:
        pool[key] = sorted(pool[key], key=lambda f: -sc.score(f.mask))[:per_type]
    comp = Compositor(sc, picture, base)
    starts = []
    for lay in init or []:
        fs = []
        for p_, c_, m_ in lay:
            f = next((f for f in pool[(p_, c_)] if np.allclose(f.matrix, m_, atol=1e-6)), None)
            if f is None:
                f = sc.footprint(p_, c_, m_)
                if not f.mask.any():
                    continue
                pool[(p_, c_)].append(f)
            fs.append(f)
        starts.append(fs)

    pair_hit: dict = {}

    def clash(a, b) -> bool:
        """Do two new parts intersect? Boxes first; touching boxes are settled by the exact collider (a plate's
        studs reach 4 LDU into the part stacked on it, so boxes alone reject every legal stack)."""
        if not _boxes_overlap(a.box, b.box):
            return False
        if collider is None:
            return True
        k = (id(a), id(b)) if id(a) < id(b) else (id(b), id(a))
        if k not in pair_hit:
            collider.set_model([(a.type, a.colour, a.matrix)])
            pair_hit[k] = bool(collider.hits(b.type, b.matrix))
        return pair_hit[k]

    def fits(f, chosen):
        return not any(f is c or clash(f, c) for c in chosen)

    def complete(chosen):
        """Greedy by footprint coverage (cheap)."""
        chosen = list(chosen)
        left = dict(need)
        for c in chosen:
            left[(c.type, c.colour)] -= 1
        while sum(left.values()) > 0:
            u = _union(chosen, shape)
            base_sc = sc.score(u)
            best = None
            for key, n in left.items():
                if n <= 0:
                    continue
                for f in pool[key]:
                    if fits(f, chosen):
                        g = sc.score(u | f.mask) - base_sc
                        if best is None or g > best[0]:
                            best = (g, key, f)
            if best is None:
                break
            chosen.append(best[2])
            left[best[1]] -= 1
        return chosen

    def swaps(cur, cur_e):
        """Single-part swaps (same type) while the composite error falls."""
        improved = True
        while improved:
            improved = False
            for i in range(len(cur)):
                rest = cur[:i] + cur[i + 1:]
                for f in pool[(cur[i].type, cur[i].colour)]:
                    if not fits(f, rest):
                        continue
                    e = comp.error(rest[:i] + [f] + rest[i:])
                    if e < cur_e - 1e-6:
                        cur[i], cur_e, improved = f, e, True
        return cur, cur_e

    k5 = np.ones((5, 5), np.uint8)

    def local(key, region, n):
        """The `n` footprints of a type that lie mostly inside `region`, best covered first."""
        rs = []
        for f in pool[key]:
            a = int(f.mask.sum())
            inside = int((f.mask & region).sum())
            if a and inside >= 0.6 * a:
                rs.append((sc.score(f.mask & region), f))
        rs.sort(key=lambda t: -t[0])
        return [f for _s, f in rs[:n]]

    def pairs(cur, cur_e):
        """Move two parts that touch on screen together (a part stacked on another new part moves with its host)."""
        for i in range(len(cur)):
            for j in range(i + 1, len(cur)):
                mi = cv2.dilate(cur[i].mask.astype(np.uint8), k5).astype(bool)
                if not (mi & cur[j].mask).any():
                    continue
                region = cv2.dilate((cur[i].mask | cur[j].mask).astype(np.uint8), k5, iterations=3).astype(bool)
                rest = [c for k, c in enumerate(cur) if k not in (i, j)]
                A = local((cur[i].type, cur[i].colour), region, pair_n)
                B = local((cur[j].type, cur[j].colour), region, pair_n)
                for a in A:
                    if not fits(a, rest):
                        continue
                    for b in B:
                        if b is a or not fits(b, rest + [a]):
                            continue
                        e = comp.error(rest + [a, b])
                        if e < cur_e - 1e-6:
                            return rest + [a, b], e, True
        return cur, cur_e, False

    def refine(cur):
        cur, cur_e = swaps(list(cur), comp.error(cur))
        moved = True
        while moved:
            cur, cur_e, moved = pairs(cur, cur_e)
            if moved:
                cur, cur_e = swaps(cur, cur_e)
        return cur, cur_e

    singles = sorted((f for fs in pool.values() for f in fs), key=lambda f: -sc.score(f.mask))[:seeds]
    found: dict = {}
    for k, f in enumerate([None] * len(starts) + singles):
        cur, e = refine(complete(starts[k] if k < len(starts) else [f]))
        if log:
            log(dict(seed=k, composite_error=e, placed=len(cur)))
        found.setdefault(tuple(sorted(id(c) for c in cur)), (cur, e))
    n_best = max((len(x[0]) for x in found.values()), default=0)
    full = sorted((x for x in found.values() if len(x[0]) == n_best), key=lambda x: x[1])
    # final word: full supersampled renders of the best distinct layouts
    shortlist = full[:verify]
    if len(shortlist) > 1:
        errs = [sc.render_error(picture, base, [(f.type, f.colour, f.matrix) for f in cur]) for cur, _e in shortlist]
        if log:
            for (cur, e), re_ in zip(shortlist, errs):
                log(dict(layout=[(f.type, f.matrix[:3, 3].tolist()) for f in cur], composite_error=e, render_error=re_))
        best_set, best_e = shortlist[int(np.argmin(errs))]
    else:
        best_set, best_e = shortlist[0] if shortlist else ([], np.inf)
    u = _union(best_set, shape)
    stats = dict(evidence=int(sc.evs.sum()), covered=int((u & sc.evs).sum()), outside=int((u & ~sc.evs).sum()),
                 on_red=int((u & sc.reds).sum()), placed=len(best_set), needed=n_total, composite_error=best_e)
    return [(f.type, f.colour, f.matrix) for f in best_set], stats


def _union(fs, shape) -> np.ndarray:
    u = np.zeros(shape, bool)
    for f in fs:
        u |= f.mask
    return u


def connection_candidates(lib, need: dict, model: list) -> dict:
    """Every pose where each needed part type connects to `model` (studs/clips and Technic), as row-major 4x4."""
    from booklet_mpd.solver.candidates import candidates
    return {key: [np.asarray(c["matrix"], float) for c in candidates(lib, key[0], list(model))] for key in need}


def place_rounds(lib, picture: np.ndarray, base: list, need: dict, cam: BookletCamera, centre, collider=None,
                 rounds: int = 3, log=None, scene: "JointScene | None" = None, **kw):
    """Joint placement with candidates generated here, no answer key. Round 1 connects each part to the model so
    far. A part can rest on another new part (a 3x3 plate on a new 1x4 plate), whose pose is unknown in round 1, so
    each later round adds the poses that connect to the best layout's parts and searches again, seeded with that
    layout - a round can only improve it (more parts placed, then lower composite error). Stops when a round does
    not improve."""
    sc = scene or JointScene(picture, base, cam, centre)
    cands = connection_candidates(lib, need, base)
    best: list = []
    best_stats: dict = {}
    rank = lambda st: (st.get("placed", 0), -st.get("composite_error", np.inf))
    for r in range(rounds):
        if r:
            extra = connection_candidates(lib, need, best)
            cands = {k: cands[k] + extra[k] for k in cands}
        if log:
            log(dict(round=r + 1, candidates={k[0]: len(v) for k, v in cands.items()}))
        placed, stats = place_joint(picture, base, need, cands, cam, centre, collider, log=log, scene=sc,
                                    init=[best] if best else None, **kw)
        if r and rank(stats) <= rank(best_stats):
            break
        best, best_stats = placed, stats
    best_stats["rounds"] = r + 1
    return best, best_stats


def same_pose(part: str, a: np.ndarray, b: np.ndarray, tol: float = 0.5) -> bool:
    """Same occupied geometry (a symmetric part turned onto itself counts as the same pose)."""
    from scipy.spatial import cKDTree
    v = np.unique(R.part_triangles(part).reshape(-1, 3).round(3), axis=0)
    va = v @ a[:3, :3].T + a[:3, 3]
    vb = v @ b[:3, :3].T + b[:3, 3]
    return bool(cKDTree(va).query(vb)[0].max() < tol and cKDTree(vb).query(va)[0].max() < tol)


def main(argv=None):
    """python -m coordnet.place --step 8 [--ckpt …] — solve the camera from the parts built before the step,
    then place the step's new parts among public/_booklet/21065/step-NNNN-cands.json and compare with the
    verified answer."""
    import argparse
    import json
    from pathlib import Path

    import torch

    from .evaluate import BOOK, ROOT, Net, initial_camera, load_step, solve_camera

    ap = argparse.ArgumentParser()
    ap.add_argument("--step", type=int, default=8)
    ap.add_argument("--ckpt", type=Path, default=ROOT / ".cache/coordnet/ckpt/best.pt")
    ap.add_argument("--per-type", type=int, default=120, help="footprints per part type kept for the layer search")
    ap.add_argument("--out", type=Path, default=ROOT / ".cache/coordnet/place")
    ap.add_argument("--no-oracle", action="store_true")
    ap.add_argument("--cands", type=Path, default=None,
                    help="a {'types': {'part|colour': [column-major 16]}} file; default: generate (no answer key)")
    ap.add_argument("--device", default="mps" if torch.backends.mps.is_available() else "cpu")
    a = ap.parse_args(argv)
    a.out.mkdir(parents=True, exist_ok=True)
    d, parts, new, pic = load_step(a.step)
    W, H = d["width"], d["height"]
    base = [p for p, nw in zip(parts, new) if not nw]
    truth = [p for p, nw in zip(parts, new) if nw]
    net = Net(a.ckpt, a.device)
    cam0, centre = initial_camera(d, base, pic)
    cam, fits = solve_camera(net, pic, base, cam0, centre, W, H)
    print("camera", json.dumps(fits[-1] if fits else None), flush=True)
    need: dict = {}
    for p, c, _m in truth:
        need[(p, c)] = need.get((p, c), 0) + 1
    from assembly_model.ldraw import load_library
    lib = load_library(str(ROOT / "public/ldraw"))
    collider = None
    if not a.no_oracle:
        from booklet_mpd.solver.collide import Collider
        collider = Collider(lib)
        print("collision", "exact" if collider.exact else "bounding boxes", flush=True)
    logf = (a.out / f"step-{a.step:04d}.log.jsonl").open("w")

    scene = JointScene(pic, base, cam, centre)
    # diagnostic only (uses the answer key, never the choice): the verified layout under the same score
    tf = [scene.footprint(p, c, m) for p, c, m in truth]
    print("truth (diagnostic): coverage", scene.score_set(tf), "composite error",
          Compositor(scene, pic, base).error(tf), "render error", scene.render_error(pic, base, truth), flush=True)
    try:
        if a.cands:
            raw = json.loads(a.cands.read_text())["types"]
            cands = {}
            for k, mats in raw.items():
                part, colour = k.split("|")
                cands[(part, int(colour))] = [np.array(m, float).reshape(4, 4).T for m in mats]
            run = lambda **kw: place_joint(pic, base, need, cands, cam, centre, collider, scene=scene, **kw)
        else:
            run = lambda **kw: place_rounds(lib, pic, base, need, cam, centre, collider, scene=scene, **kw)
        placed, stats = run(per_type=a.per_type,
                                    log=lambda r: (logf.write(json.dumps(r) + "\n"), print(json.dumps(r), flush=True)))
    finally:
        if collider is not None:
            collider.close()
    print("coverage", json.dumps(stats), flush=True)
    left = [(p, c, m) for p, c, m in truth]
    right = 0
    for ptype, _c, pm in placed:
        hit = next((i for i, t in enumerate(left) if t[0] == ptype and same_pose(t[0], t[2], pm)), None)
        if hit is not None:
            left.pop(hit)
            right += 1
    result = dict(step=a.step, placed=len(placed), needed=len(truth), exact=right,
                  coverage=stats, poses=[dict(part=p_, pos=m_[:3, 3].tolist()) for p_, _c, m_ in placed])
    print(json.dumps(result), flush=True)
    model = base + list(placed)
    ren = R.render(model, set(range(len(base), len(model))), cam, centre, W, H, R.Style(), ss=2)
    blend = (0.5 * pic + 0.5 * ren.picture).astype(np.uint8)
    cv2.imwrite(str(a.out / f"step-{a.step:04d}.png"),
                cv2.cvtColor(np.concatenate([pic, ren.picture, blend], 0), cv2.COLOR_RGB2BGR))
    (a.out / f"step-{a.step:04d}.json").write_text(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
