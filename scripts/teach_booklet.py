"""Teacher workbench: build a set from its booklets step by step, every step checked and corrected by hand.

The solver proposes each step on top of the verified model so far; a review image shows the booklet picture
next to the proposal (new parts filled and numbered). The teacher accepts it, picks an alternative, or edits
it (drop / move / rotate / swap a part for another connection candidate / add copies for "Nx" repeats).
Verified steps are kept in .cache/booklet-mpd/teach/<set>/verified.json and written out as one MPD.

cd python
.venv/bin/python ../scripts/teach_booklet.py init 21065 BOOK1.pdf BOOK2.pdf BOOK3.pdf
.venv/bin/python ../scripts/teach_booklet.py propose 21065 1 5 --chain 4     # book 1, steps 5..8
.venv/bin/python ../scripts/teach_booklet.py cands 21065 1 5 2               # candidate poses of part 2
.venv/bin/python ../scripts/teach_booklet.py accept 21065 1 5 --edit '{"cand": {"2": 3}}'
.venv/bin/python ../scripts/teach_booklet.py mpd 21065
"""
from __future__ import annotations

import argparse
from functools import lru_cache
import hashlib
import json
import pickle
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
TEACH = ROOT / ".cache/booklet-mpd/teach"
EXTRACT = ROOT / ".cache/booklet-mpd/solver/extract"

_LIB: dict = {}


def lib():
    if "lib" not in _LIB:
        from assembly_model.ldraw import load_library
        _LIB["lib"] = load_library(str(ROOT / "public/ldraw"))
    return _LIB["lib"]


def collider():
    if "col" not in _LIB:
        from booklet_mpd.solver.collide import Collider
        _LIB["col"] = Collider(lib(), use_oracle=True)
    return _LIB["col"]


# ------------------------------------------------------------------ state

def folder(s: str) -> Path:
    f = TEACH / s
    f.mkdir(parents=True, exist_ok=True)
    return f


def config(s: str) -> dict:
    return json.loads((folder(s) / "config.json").read_text())


def verified(s: str) -> dict:
    f = folder(s) / "verified.json"
    return json.loads(f.read_text()) if f.exists() else {}


def save_verified(s: str, v: dict) -> None:
    f = folder(s) / "verified.json"
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(v))
    tmp.replace(f)


def key(book: int, step: int) -> str:
    return f"{book}:{step:04d}"


def as_parts(rows) -> list:
    return [(p, int(c), np.array(m, float)) for p, c, m in rows]


def as_rows(parts) -> list:
    return [[p, int(c), np.asarray(m, float).round(4).tolist()] for p, c, m in parts]


def model_before(s: str, book: int, step: int, extra: dict | None = None) -> list:
    """Verified parts of every step before (book, step), plus tentative `extra` {key: rows}."""
    v = dict(verified(s))
    for k, rows in (extra or {}).items():
        v.setdefault(k, {"parts": rows})
    out = []
    for k in sorted(v):
        if k < key(book, step):
            out += as_parts(v[k]["parts"])
    return out


# ------------------------------------------------------------------ init: books, extracts, parts per step

def init(s: str, pdfs: list[Path]) -> None:
    from booklet_mpd.solver import pipeline
    from booklet_mpd.solver.parts import element_index, read_parts, rebrickable_client
    books, inventory, inv_dir = [], None, None
    for n, pdf in enumerate(pdfs, start=1):
        digest = hashlib.sha256(pdf.read_bytes()).hexdigest()[:16]
        data, f = pipeline.extract(pdf, EXTRACT / digest)
        books.append({"book": n, "pdf": str(pdf.resolve()), "extract": str(f), "steps": len(data["steps"])})
        if any(e.get("element") for e in data.get("inventory", [])):
            inventory, inv_dir = data["inventory"], f
    if inventory is None:
        raise SystemExit("no printed parts list in any booklet")
    import shutil
    try:
        client = rebrickable_client()
    except Exception:
        client = None
    index = element_index()
    for b in books:          # every booklet reads its callouts against the one printed parts list
        f = Path(b["extract"])
        data = json.loads((f / "extract.json").read_text())
        if not data.get("inventory"):
            for e in inventory:
                if not (f / e["crop"]).exists():
                    (f / e["crop"]).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy(inv_dir / e["crop"], f / e["crop"])
            data["inventory"] = inventory
            (f / "extract.json").write_text(json.dumps(data))
        steps, report = read_parts(lib(), data, f, index, client)
        rows = []
        for st, sp in zip(data["steps"], steps):
            rows.append({"number": st["number"], "page": st["page"], "repeat": int(st.get("repeat") or 1),
                         "substeps": len(st.get("substeps", [])), "parts": [list(x) for x in sp.parts],
                         "confidence": [round(float(c), 3) for c in sp.confidence], "unresolved": sp.unresolved})
        (folder(s) / f"parts-{b['book']}.json").write_text(json.dumps(rows))
        print(f"book {b['book']}: {len(rows)} steps, {sum(len(r['parts']) for r in rows)} pieces read, "
              f"{sum(r['unresolved'] for r in rows)} unresolved", flush=True)
    (folder(s) / "config.json").write_text(json.dumps({"set": s, "books": books}, indent=1))


@lru_cache(maxsize=16)
def _reviewed_source_sha(path: str, mtime_ns: int, size: int) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def step_parts(s: str, book: int) -> list[dict]:
    """Per step (by position in the book), the parts it adds, with the teacher's overrides applied."""
    audited = folder(s) / f"audited-parts-{book}.json"
    if audited.exists():
        data = json.loads(audited.read_text())
        pdf = Path(next(b["pdf"] for b in config(s)["books"] if b["book"] == book))
        stat = pdf.stat()
        if data.get("format") != "reviewed-booklet-parts-v1" or data.get("sourceHash") != _reviewed_source_sha(str(pdf), stat.st_mtime_ns, stat.st_size):
            raise RuntimeError("Reviewed parts do not match the source booklet; rebuild the reviewed manifest")
        manifest = ROOT / "public" / "_booklet" / s / f"book{book}-parts.json"
        if manifest.exists():
            ms = manifest.stat()
            if data.get("manifestSha256") != _reviewed_source_sha(str(manifest), ms.st_mtime_ns, ms.st_size):
                raise RuntimeError("Reviewed parts cache is stale relative to the published manifest; rebuild it")
        rows = data["steps"]
    else:
        rows = json.loads((folder(s) / f"parts-{book}.json").read_text())
    f = folder(s) / f"overrides-{book}.json"
    for pos, parts in (json.loads(f.read_text()) if f.exists() else {}).items():
        r = rows[int(pos) - 1]
        r["parts"] = [list(x) for x in parts]
        r["confidence"] = [1.0] * len(parts)
        r["unresolved"] = 0
        r["teacher"] = True
    return rows


def set_parts(s: str, book: int, pos: int, spec: str) -> None:
    """spec: "11212/0x2 2445/72 78329/0x2 3023/15" -> the step's parts, replacing what was read."""
    parts = []
    for tok in spec.split():
        pc, _, n = tok.partition("x")
        p, c = pc.split("/")
        parts += [[p, int(c)]] * int(n or 1)
    f = folder(s) / f"overrides-{book}.json"
    o = json.loads(f.read_text()) if f.exists() else {}
    o[str(pos)] = parts
    f.write_text(json.dumps(o, indent=0))
    print(f"book {book} step {pos}: {len(parts)} parts set")


def _rasterised_picture(page, box):
    """The step picture rasterised from the page: the union of the large colour images centred in the box,
    leaving out those inside a sub-build panel (pointer lines around a picture can look like a panel to
    `main_model_image_info`, which then finds nothing)."""
    import pymupdf
    from booklet_mpd.rawimages import subbuild_images
    panels = [pymupdf.Rect(x["panel"]) for x in subbuild_images(page, box) if x.get("panel")]
    rects = []
    for info in page.get_image_info(xrefs=True):
        r = pymupdf.Rect(info["bbox"])
        c = pymupdf.Point((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2)
        inside = any((r & pn).get_area() > 0.8 * r.get_area() for pn in panels)
        if info.get("colorspace") == 3 and box.contains(c) and r.get_area() > 2000 and not inside:
            rects.append(r)
    if not rects:
        return None, None
    u = rects[0]
    for r in rects[1:]:
        u |= r
    dpi = 150
    pix = page.get_pixmap(dpi=dpi, clip=u)
    rgb = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)[..., :3].copy()
    return rgb, 72.0 / dpi


def picture(s: str, book: int, index: int):
    """(rgb, points per pixel, sub-build panels) of a step's main picture."""
    import pymupdf
    from booklet_mpd.rawimages import main_model_image_info, subbuild_images
    b = config(s)["books"][book - 1]
    data = json.loads((Path(b["extract"]) / "extract.json").read_text())
    st = data["steps"][index]
    doc = pymupdf.open(b["pdf"])
    page = doc[st["page"] - 1]
    box = pymupdf.Rect(st["pictureBox"]) if st.get("pictureBox") else None
    rgb, pts = main_model_image_info(page, box)
    if rgb is None and box is not None:
        rgb, pts = _rasterised_picture(page, box)
    # booklet drawn at another scale than the solver's prior (BOOKLET_SCALE): pts per pixel is the only
    # way the solver sees the scale, so the measured factor goes in there
    k = float(config(s).get("scale", {}).get(str(book), 1.0))
    return rgb, (pts / k if pts else pts), [dict(x, pts_per_px=x["pts_per_px"] / k) if x.get("pts_per_px") else x for x in subbuild_images(page, box)]


# ------------------------------------------------------------------ propose

def _camera(s: str):
    f = folder(s) / "camera.pkl"
    if f.exists():
        return pickle.loads(f.read_bytes())
    from booklet_mpd.solver.step import SectionCamera
    return SectionCamera()


def teacher_camera(s: str, book: int, number: int, tentative: dict):
    """(view, orientation index, expected completed score) from the last verified step before this one:
    the teacher's camera is held (expected 0: the solver never swaps it for a free search)."""
    from booklet_mpd.solver.render import View
    from booklet_mpd.viewfit import ORIENTATIONS
    v = verified(s)
    for k in sorted(v, reverse=True):
        if k < key(book, number) and k.startswith(f"{book}:") and v[k].get("view"):
            c = v[k]["view"]
            o = np.array(c["orientation"], float)
            oi = next(i for i, x in enumerate(ORIENTATIONS) if np.allclose(np.asarray(x, float), o))
            return View(o, c["yaw"], c["pitch"], c["scale"], tuple(c["offset"])), oi, 0.0
    return None


def propose(s: str, book: int, step: int, chain: int = 1, free: bool = False, flip: bool | None = None) -> None:
    from booklet_mpd.solver.step import solve
    rows = step_parts(s, book)
    tentative: dict = {}
    section = _camera(s)
    for number in range(step, step + chain):        # `number`: position in the book (1-based)
        i = number - 1
        r = rows[i]
        parts = [(p, int(c)) for p, c in r["parts"]]
        base = model_before(s, book, number, tentative)
        rgb, pts, subs = picture(s, book, i)
        rec = {"book": book, "number": number, "printed": r["number"], "page": r["page"], "parts": parts, "repeat": r["repeat"],
               "confidence": r["confidence"], "unresolved": r["unresolved"], "base_n": len(base)}
        if rgb is None or not parts:
            rec["status"] = "no picture" if rgb is None else "no parts read"
        else:
            if flip is not None and number == step and base:   # the model was turned: fit the base alone
                from booklet_mpd.viewfit import ORIENTATIONS
                fv = fit_view(base, rgb, pts, flipped=flip)
                oi = next(i for i, x in enumerate(ORIENTATIONS) if np.allclose(np.asarray(x, float), fv.orientation))
                cam = (fv, oi, 0.0)
            else:
                cam = None if free or not base else teacher_camera(s, book, number, tentative) or section.prior(book)
            res = solve(lib(), base, parts, rgb, pts, collider=collider(), subbuilds=subs, camera=cam)
            section.add(book, res, len(base))
            rec.update(status=res.status, view=res.view, placed=as_rows(res.placed), completed=res.completed,
                       alternatives=[as_rows(a.placed) for a in res.alternatives[:4]],
                       scores=[None if sc is None else (float(sc.score), float(sc.margin)) for sc in res.scores])
            review(s, rec, rgb, pts, base)
            tentative[key(book, number)] = rec["placed"]
        (folder(s) / f"proposal-{book}-{number:04d}.pkl").write_bytes(pickle.dumps(rec))
        print(f"book {book} #{number} (printed {r['number']}, p{r['page']}): {len(parts)} parts x{r['repeat']}, {rec['status']}, "
              f"completed {rec.get('completed', 0):.3f}, review {folder(s) / f'review-{book}-{number:04d}.png'}",
              flush=True)
    (folder(s) / "camera.pkl").write_bytes(pickle.dumps(section))


def review(s: str, rec: dict, rgb, pts, base: list, placed=None, path: Path | None = None) -> Path:
    """picture | proposal (new parts filled, magenta outline, numbered) | alternatives 1..3 (small)."""
    import cv2
    from booklet_mpd.solver.picture import Picture, colour_rgb
    from booklet_mpd.solver.render import render
    from booklet_mpd.viewfit import BOOKLET_SCALE
    pic = Picture.from_rgb(rgb, pts, BOOKLET_SCALE / pts if pts else None)
    img = pic.rgb.copy()
    h, w = img.shape[:2]

    def draw(new, label=True):
        _d, lab = render(lib(), base + new, rec["view"], (h, w))
        out = img.copy()
        nb = len(base)
        for k, (p, c, _m) in enumerate(new):
            m = lab == nb + k
            out[m] = (0.35 * out[m] + 0.65 * np.array(colour_rgb(c))).astype(np.uint8)
        for k in range(nb + len(new)):
            m = (lab == k).astype(np.uint8)
            edge = cv2.morphologyEx(m, cv2.MORPH_GRADIENT, np.ones((2, 2), np.uint8)) > 0
            out[edge] = (255, 0, 255) if k >= nb else (0, 200, 220)
        if label:
            for k in range(len(new)):
                ys, xs = np.nonzero(lab == nb + k)
                if len(xs):
                    at = (int(xs.mean()), int(ys.mean()))
                    cv2.putText(out, str(k), at, cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 3)
                    cv2.putText(out, str(k), at, cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 0), 1)
        return out
    placed = as_parts(placed if placed is not None else rec["placed"])
    panels = [img, draw(placed)]
    for alt in rec.get("alternatives", [])[:3] if path is None else []:
        panels.append(draw(as_parts(alt), label=False))
    sep = np.full((h, 4, 3), 255, np.uint8)
    row = panels[0]
    for p in panels[1:]:
        row = np.concatenate([row, sep, p], 1)
    legend = "  ".join(f"{k}:{p.replace('.dat', '')}/{c}" for k, (p, c, _m) in enumerate(placed))
    bar = np.full((22, row.shape[1], 3), 255, np.uint8)
    cv2.putText(bar, f"#{rec['number']} (printed {rec.get('printed')}) x{rec['repeat']}  {legend}"[:220], (4, 15),
                cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 0, 0), 1)
    out = np.concatenate([bar, row], 0)
    path = path or folder(s) / f"review-{rec['book']}-{rec['number']:04d}.png"
    cv2.imwrite(str(path), cv2.cvtColor(out, cv2.COLOR_RGB2BGR))
    return path


# ------------------------------------------------------------------ candidates of one part, for the teacher

def cands(s: str, book: int, number: int, idx: int, top: int = 12) -> None:
    import cv2
    from booklet_mpd.solver.candidates import candidates
    from booklet_mpd.solver.place import distinct
    rec = pickle.loads((folder(s) / f"proposal-{book}-{number:04d}.pkl").read_bytes())
    placed = as_parts(rec["placed"])
    base = model_before(s, book, number)
    ctx = base + [x for k, x in enumerate(placed) if k != idx]
    p, c, cur = placed[idx]
    cs = distinct(lib(), p, candidates(lib(), p, ctx))
    # nearest to the current pose first: the teacher usually wants a small correction
    d = [float(np.linalg.norm(np.asarray(x["matrix"])[:3, 3] - cur[:3, 3])) for x in cs]
    order = sorted(range(len(cs)), key=lambda k: d[k])[:top]
    rgb, pts, _subs = picture(s, book, number - 1)
    tiles = []
    for j in order:
        new = [x if k != idx else (p, c, np.asarray(cs[j]["matrix"], float)) for k, x in enumerate(placed)]
        t = folder(s) / f"cand-{j}.png"
        review(s, rec, rgb, pts, base, placed=as_rows(new), path=t)
        im = cv2.imread(str(t))
        h = im.shape[0]
        im = im[22:, im.shape[1] // 2:]          # the proposal half
        cv2.putText(im, f"cand {j}", (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)
        tiles.append(im)
        t.unlink()
    grid_rows = []
    for k in range(0, len(tiles), 4):
        r = tiles[k:k + 4] + [np.full_like(tiles[0], 255)] * (4 - len(tiles[k:k + 4]))
        grid_rows.append(np.concatenate(r, 1))
    out = folder(s) / f"cands-{book}-{number:04d}-{idx}.png"
    cv2.imwrite(str(out), np.concatenate(grid_rows, 0))
    (folder(s) / f"cands-{book}-{number:04d}-{idx}.pkl").write_bytes(pickle.dumps(cs))
    print(out)


# ------------------------------------------------------------------ accept with edits

def _rot(axis: str, deg: float) -> np.ndarray:
    a = np.radians(deg)
    c, s_ = round(np.cos(a), 9), round(np.sin(a), 9)
    return {"x": np.array([[1, 0, 0], [0, c, -s_], [0, s_, c]]),
            "y": np.array([[c, 0, s_], [0, 1, 0], [-s_, 0, c]]),
            "z": np.array([[c, -s_, 0], [s_, c, 0], [0, 0, 1]])}[axis]


def apply_edit(s: str, book: int, number: int, placed: list, edit: dict) -> list:
    """Edits, in this order: cand {i: j}, move {i: [dx,dy,dz]}, rotate {i: [axis, deg]} (about the part's
    own origin), colour {i: c}, part {i: id}, copy [{"of": [i..], "move": [..], "rotate": [axis, deg, [cx,cy,cz]]}]
    (Nx repeats; rotation about point c), add [[id, colour, 4x4]], drop [i..]."""
    out = [list(x) for x in placed]
    if edit.get("cand"):
        cs = None
        for i, j in edit["cand"].items():
            f = folder(s) / f"cands-{book}-{number:04d}-{int(i)}.pkl"
            cs = pickle.loads(f.read_bytes())
            out[int(i)][2] = np.asarray(cs[int(j)]["matrix"], float)
    for i, d in (edit.get("move") or {}).items():
        out[int(i)][2] = out[int(i)][2].copy()
        out[int(i)][2][:3, 3] += np.array(d, float)
    for i, (axis, deg) in (edit.get("rotate") or {}).items():
        m = out[int(i)][2].copy()
        m[:3, :3] = m[:3, :3] @ _rot(axis, deg)
        out[int(i)][2] = m
    for i, c in (edit.get("colour") or {}).items():
        out[int(i)][1] = int(c)
    for i, p in (edit.get("part") or {}).items():
        out[int(i)][0] = p if p.endswith(".dat") else p + ".dat"
    for cp in edit.get("copy") or []:
        for i in cp["of"]:
            p, c, m = out[int(i)]
            m = m.copy()
            if cp.get("rotate"):
                axis, deg, centre = cp["rotate"]
                r = np.eye(4)
                r[:3, :3] = _rot(axis, deg)
                t = np.eye(4)
                t[:3, 3] = centre
                ti = np.eye(4)
                ti[:3, 3] = -np.array(centre, float)
                m = t @ r @ ti @ m
            if cp.get("move"):
                m[:3, 3] += np.array(cp["move"], float)
            out.append([p, c, m])
    for row in edit.get("add") or []:
        out.append([row[0], int(row[1]), np.array(row[2], float)])
    # grid: [part, colour, x studs, level plates (up), z studs, turn about the vertical in degrees]
    # (LDraw: y points down, a plate is 8 LDU, a stud 20 LDU; part origins sit on their top face)
    for row in edit.get("grid") or []:
        p, c, x, lv, z = row[:5]
        m = np.eye(4)
        m[:3, :3] = _rot("y", float(row[5]) if len(row) > 5 else 0.0)
        m[:3, 3] = (20.0 * x, -8.0 * lv, 20.0 * z)
        out.append([p if str(p).endswith(".dat") else f"{p}.dat", int(c), m])
    drop = {int(i) for i in edit.get("drop") or []}
    return [tuple(x) for k, x in enumerate(out) if k not in drop]


def _foreground(rgb):
    import cv2
    from booklet_mpd.solver.parts import _background
    bg = _background(rgb)
    fg = (np.linalg.norm(rgb.astype(float) - bg, axis=-1) > 30).astype(np.uint8)
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    from booklet_mpd.stepimage import fill_holes
    return fill_holes(fg.astype(bool))


def _place(view, model, mask):
    """Scale and offset so the model's silhouette box matches the picture's foreground box."""
    from booklet_mpd.solver.render import bounds
    ys, xs = np.nonzero(mask)
    v = view.replace(scale=1.0, offset=(0.0, 0.0))
    lo, hi = bounds(lib(), model, v)
    k = 0.5 * ((np.ptp(xs) + 1) / max(hi[0] - lo[0], 1e-6) + (np.ptp(ys) + 1) / max(hi[1] - lo[1], 1e-6))
    v = v.replace(scale=float(k))
    lo, hi = bounds(lib(), model, v)
    return v.replace(offset=(float(xs.min() - lo[0]), float(ys.min() - lo[1])))


def _iou(view, model, mask):
    from booklet_mpd.solver.render import render
    _d, lab = render(lib(), model, view, mask.shape)
    m = lab >= 0
    return float((m & mask).sum() / max((m | mask).sum(), 1))


def fit_view(model: list, rgb, pts, flipped: bool | None = None):
    """Camera for a whole (teacher-built) model, from the picture's silhouette: upright (or flipped)
    orientations x yaw x pitch, scale and offset from the silhouette box, then a local refinement. The check
    image must show the teacher's model, not the camera the solver fitted to its own guess."""
    from booklet_mpd.solver.render import View
    from booklet_mpd.solver.picture import Picture
    from booklet_mpd.viewfit import BOOKLET_SCALE, ORIENTATIONS
    mask = _foreground(Picture.from_rgb(rgb, pts, BOOKLET_SCALE / pts if pts else None).rgb)   # the solver's working image
    up = []
    for i, o in enumerate(ORIENTATIONS):
        y = np.asarray(o, float) @ np.array([0.0, -1.0, 0.0])      # where LDraw "up" goes
        if (flipped is not True and y[1] < -0.99) or (flipped is not False and y[1] > 0.99):
            up.append(o)
    best = (-1.0, None)
    for o in up:
        for yaw in np.arange(0, 90, 7.5):
            for pitch in (20, 27.5, 35, 42.5, 50):
                v = _place(View(np.asarray(o, float), float(yaw), float(pitch)), model, mask)
                sc = _iou(v, model, mask)
                if sc > best[0]:
                    best = (sc, v)
    sc, v = best
    for step in (4.0, 2.0, 1.0, 0.5):
        improved = True
        while improved:
            improved = False
            for dy, dp in ((step, 0), (-step, 0), (0, step), (0, -step)):
                w = _place(v.replace(yaw=v.yaw + dy, pitch=v.pitch + dp), model, mask)
                for ds in (1.0, 0.97, 1.03):
                    u = w.replace(scale=w.scale * ds)
                    for ox in (-1, 0, 1):
                        for oy in (-1, 0, 1):
                            t = u.replace(offset=(u.offset[0] + ox, u.offset[1] + oy))
                            x = _iou(t, model, mask)
                            if x > sc + 1e-4:
                                sc, v, improved = x, t, True
    print(f"camera fit: silhouette IoU {sc:.3f}, yaw {v.yaw:.1f} pitch {v.pitch:.1f} scale {v.scale:.3f}")
    return v


def accept(s: str, book: int, number: int, alt: int | None, edit: dict | None, note: str = "",
           preview: bool = False) -> None:
    f = folder(s) / f"proposal-{book}-{number:04d}.pkl"
    if f.exists():
        rec = pickle.loads(f.read_bytes())
    else:          # teacher-built step: no solver proposal needed
        r = step_parts(s, book)[number - 1]
        rec = {"book": book, "number": number, "printed": r["number"], "page": r["page"], "repeat": r["repeat"],
               "placed": []}
    placed = as_parts(rec["alternatives"][alt] if alt is not None else rec.get("placed", []))
    if edit:
        placed = apply_edit(s, book, number, placed, edit)
    if edit and edit.get("only"):       # keep just the listed indices (after the other edits)
        placed = [placed[int(i)] for i in edit["only"]]
    base = model_before(s, book, number)
    from collections import Counter
    want = Counter((p.replace(".dat", ""), int(c)) for p, c in step_parts(s, book)[number - 1]["parts"])
    have = Counter((p.replace(".dat", ""), int(c)) for p, c, _m in placed)
    if want != have:
        print(f"WARNING parts differ from the step's list: missing {dict(want - have)} extra {dict(have - want)}")
    rgb, pts, _ = picture(s, book, number - 1)
    fitted = None
    if rgb is not None and placed:
        r = dict(rec)
        r.pop("alternatives", None)
        fitted = fit_view(base + placed, rgb, pts, flipped=(edit or {}).get("flipped"))
        r["view"] = fitted or rec.get("view")
        if r["view"] is not None:
            print(review(s, r, rgb, pts, base, placed=as_rows(placed),
                         path=folder(s) / f"check-{book}-{number:04d}.png"))
    if preview:
        return
    v = verified(s)
    v[key(book, number)] = {"parts": as_rows(placed), "note": note, "edit": edit or {}, "alt": alt,
                            "view": None if fitted is None else {"orientation": np.asarray(fitted.orientation).tolist(),
                                                                  "yaw": fitted.yaw, "pitch": fitted.pitch,
                                                                  "scale": fitted.scale, "offset": list(fitted.offset)}}
    save_verified(s, v)
    # proposals chained on the old guess for later steps are stale now
    for f in folder(s).glob(f"proposal-{book}-*.pkl"):
        if int(f.stem.split("-")[-1]) > number and key(book, int(f.stem.split("-")[-1])) not in v:
            f.unlink()
    print(f"verified book {book} step {number}: {len(placed)} parts; model {len(base) + len(placed)} parts")


def mpd(s: str) -> None:
    v = verified(s)
    lines = [f"0 FILE {s}.ldr", f"0 Name: {s}.ldr", "0 Teacher-verified reconstruction (BrickMotion teach_booklet)"]
    for k in sorted(v):
        lines.append(f"0 // book {k.split(':')[0]} step {int(k.split(':')[1])}" + (f": {v[k]['note']}" if v[k].get("note") else ""))
        for p, c, m in as_parts(v[k]["parts"]):
            vals = (*m[:3, 3], *m[:3, :3].ravel())
            lines.append(f"1 {c} " + " ".join(f"{x:.6g}" for x in vals) + f" {p if p.endswith('.dat') else p + '.dat'}")
        lines.append("0 STEP")
    lines.append("0 NOFILE")
    out = folder(s) / f"{s}-verified.mpd"
    out.write_text("\n".join(lines) + "\n")
    print(out, sum(len(v[k]["parts"]) for k in v), "parts in", len(v), "steps")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("init"); a.add_argument("set"); a.add_argument("pdfs", nargs="+", type=Path)
    a = sub.add_parser("propose"); a.add_argument("set"); a.add_argument("book", type=int); a.add_argument("step", type=int)
    a.add_argument("--chain", type=int, default=1); a.add_argument("--free", action="store_true")
    a.add_argument("--flip", choices=["up", "down"], help="model turned: fit the camera to the base, upright or upside down")
    a = sub.add_parser("cands"); a.add_argument("set"); a.add_argument("book", type=int); a.add_argument("step", type=int)
    a.add_argument("part", type=int); a.add_argument("--top", type=int, default=12)
    a = sub.add_parser("accept"); a.add_argument("set"); a.add_argument("book", type=int); a.add_argument("step", type=int)
    a.add_argument("--alt", type=int); a.add_argument("--edit", type=json.loads); a.add_argument("--note", default="")
    a.add_argument("--preview", action="store_true")
    a = sub.add_parser("setparts"); a.add_argument("set"); a.add_argument("book", type=int); a.add_argument("step", type=int)
    a.add_argument("spec")
    a = sub.add_parser("scale"); a.add_argument("set"); a.add_argument("book", type=int); a.add_argument("factor", type=float)
    a = sub.add_parser("mpd"); a.add_argument("set")
    x = ap.parse_args()
    try:
        if x.cmd == "init":
            init(x.set, x.pdfs)
        elif x.cmd == "propose":
            propose(x.set, x.book, x.step, x.chain, x.free, None if x.flip is None else x.flip == "down")
        elif x.cmd == "cands":
            cands(x.set, x.book, x.step, x.part, x.top)
        elif x.cmd == "accept":
            accept(x.set, x.book, x.step, x.alt, x.edit, x.note, x.preview)
        elif x.cmd == "scale":
            c = config(x.set)
            c.setdefault("scale", {})[str(x.book)] = x.factor
            (folder(x.set) / "config.json").write_text(json.dumps(c, indent=1))
        elif x.cmd == "setparts":
            set_parts(x.set, x.book, x.step, x.spec)
        else:
            mpd(x.set)
    finally:
        if "col" in _LIB:
            _LIB["col"].close()


if __name__ == "__main__":
    main()
