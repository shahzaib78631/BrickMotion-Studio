"""Offline thumbnail matching against a cached, rendered LDraw catalogue."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

import numpy as np

from booklet_mpd.solver.parts import describe, rendered_descriptors
from booklet_mpd.solver.picture import ldraw_colours

ROOT = Path(__file__).resolve().parents[2]
PART_ID = re.compile(r"[A-Za-z0-9_-]+")


def candidates(root, limit=256, selected=None):
    folder = Path(root) / "parts"
    if selected:
        ids = list(dict.fromkeys(str(p).removesuffix(".dat").lower() for p in selected))
        if any(not PART_ID.fullmatch(p) or not (folder / f"{p}.dat").is_file() for p in ids):
            raise ValueError("Candidate part IDs must name files in the local LDraw parts library.")
        return ids
    catalog_path = Path(root).parent / "data/catalog.json"
    ids = ([r["id"] for r in json.loads(catalog_path.read_text())] if catalog_path.exists()
           else [p.stem for p in sorted(folder.glob("*.dat"))])
    ids = [p for p in ids if PART_ID.fullmatch(p) and (folder / f"{p}.dat").exists()]
    usage_path = Path(root).parent / "data/part-usage.json"
    usage = json.loads(usage_path.read_text()).get("parts", []) if usage_path.exists() else []
    order = {row[0]: i for i, row in enumerate(usage)}
    ids.sort(key=lambda p:(order.get(p, len(order)), p))
    return ids[:limit] if limit else ids


class Catalog:
    def __init__(self, lib, ids, cache, log=lambda _: None):
        self.ids = ids
        self.rows = []
        cache = Path(cache)
        cache.mkdir(parents=True, exist_ok=True)
        # Include dependency changes in the shared revision, not only a part's
        # top-level stub. No pickle or executable cache formats are used.
        identity = hashlib.sha256(b"studio-descriptors-v1")
        for folder in (Path(lib.root)/"parts", Path(lib.root)/"p"):
            for path in sorted(folder.rglob("*.dat")):
                stat = path.stat()
                identity.update(f"{path.relative_to(lib.root)}:{stat.st_size}:{stat.st_mtime_ns}".encode())
        revision = identity.hexdigest()[:16]
        for i, part in enumerate(ids):
            path = cache / f"{revision}-{part}.npz"
            if path.exists():
                with np.load(path, allow_pickle=False) as data:
                    masks, aspects = data["masks"], data["aspects"]
            else:
                descriptors = rendered_descriptors(lib, part, 4) or []
                masks = np.array([d.mask for d in descriptors], dtype=bool).reshape(-1,32,32)
                aspects = np.array([d.aspect for d in descriptors])
                np.savez_compressed(path, masks=masks, aspects=aspects)
            for mask, aspect in zip(masks, aspects):
                self.rows.append((part, mask, float(aspect)))
            # Recognition no longer needs the high-resolution mesh. Avoid retaining
            # all meshes when a full-library scan is selected.
            from booklet_mpd.solver.render import _MESHES
            _MESHES.pop((id(lib), part), None)
            if i % 10 == 0 or i+1 == len(ids):
                log({"stage":"catalog", "done":i+1, "total":len(ids)})
        if not self.rows:
            raise ValueError("The selected parts library produced no renderable parts.")
        self.masks = np.array([r[1] for r in self.rows], bool)
        self.aspects = np.array([r[2] for r in self.rows])

    def match(self, rgb, top=5):
        desc = describe(rgb)
        if desc is None:
            return []
        inter = (self.masks & desc.mask).sum(axis=(1,2))
        union = (self.masks | desc.mask).sum(axis=(1,2))
        scores = .8*inter/np.maximum(union,1) + .2*np.exp(-2*np.abs(np.log(self.aspects/max(desc.aspect,1e-6))))
        best = {}
        for row, score in zip(self.rows, scores):
            best[row[0]] = max(best.get(row[0],0), float(score))
        palette = [(c,v) for c,v in ldraw_colours().items() if c not in (16,24) and c < 256]
        color_distance = sorted((float(np.linalg.norm(desc.colour-np.array(v))), c) for c,v in palette)
        color = color_distance[0][1]
        color_score = float(np.exp(-color_distance[0][0]/60))
        ranked = sorted(best.items(), key=lambda r:(-r[1],r[0]))[:top]
        return [{"part":part,"color":color,"shapeScore":round(score,4),
                 "colorScore":round(color_score,4),
                 "score":round(score*color_score,4),
                 "colorCandidates":[{"color":c,"distance":round(d,2)} for d,c in color_distance[:4]]}
                for part,score in ranked]
