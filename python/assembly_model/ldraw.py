"""Minimal recursive LDraw loader + LDCad snap metadata resolution."""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from .geometry import transform_points


@dataclass(frozen=True)
class Snap:
    gender: str
    pos: tuple[float, float, float]
    axis: tuple[float, float, float]
    kind: str
    group: str | None
    grid: bool
    id: str | None = None
    sections: tuple[tuple[str, float, float], ...] = ()
    length: float = 0.
    radius: float = 0.
    caps: str = "none"
    center: bool = False
    slide: bool = False
    bounding: str | None = None
    placement: str | None = None


class LDrawLibrary:
    def __init__(self, root: str):
        self.root = root
        # models/ also holds the unofficial parts OMR files embed (scripts/extract_omr_embedded_parts.py)
        self.dirs = [os.path.join(root, d) for d in ("parts", "p", "models")] + [root]
        shadow_path = os.path.join(os.path.dirname(root), "data", "ldcad-shadow.json")
        self.shadow: dict[str, list[dict]] = {}
        self.snap_diagnostics: list[str] = []
        if os.path.exists(shadow_path):
            raw = json.load(open(shadow_path))["files"]
            self.shadow = {k.lower().replace('\\', '/'): _parse_ldcad_meta(v) for k, v in raw.items()}

    @lru_cache(maxsize=None)
    def find(self, name: str) -> str | None:
        rel = name.replace("\\", "/")
        base = rel.split("/")[-1]
        candidates = [rel] if rel.lower().startswith("s/") else [rel, f"s/{base}"]
        for d in self.dirs:
            for c in candidates:
                p = os.path.join(d, c)
                if os.path.isfile(p):
                    return p
        return None

    @lru_cache(maxsize=None)
    def triangles(self, name: str) -> np.ndarray:
        chunks = self._tri_walk(name.lower(), np.eye(4))
        if not chunks:
            return np.zeros((0, 3))
        return np.concatenate(chunks, axis=0)

    def _tri_walk(self, name: str, mat: np.ndarray) -> list[np.ndarray]:
        path = self.find(name)
        if path is None:
            return []
        tris, refs = _parse_file(path)
        chunks = [transform_points(pts, mat) for pts in tris]
        for ref, sub in refs:
            chunks.extend(self._tri_walk(ref, mat @ sub))
        return chunks

    @lru_cache(maxsize=None)
    def snaps(self, name: str) -> tuple[Snap, ...]:
        # Resolve inherited metadata before applying the parent's SNAP_CLEAR.
        # Includes add shadow definitions, not the referenced file's geometry.
        values = self._resolved_snaps(name.lower(), np.eye(4), (), False)
        return tuple(dict.fromkeys(values))

    def _resolved_snaps(self, name, mat, ancestors, shadow_only):
        name = name.lower().replace('\\', '/')
        if name in ancestors or len(ancestors) > 24:
            return []
        records = self.shadow.get(name, ())
        own = []
        for rec in records:
            command = rec['type']
            if command == 'SNAP_CLEAR':
                continue
            if command == 'SNAP_INCL':
                ref = rec.get('ref')
                if not ref:
                    continue
                try:
                    frames = _meta_frames(rec, include=True)
                except ValueError as error:
                    self.snap_diagnostics.append(f'{name}: {error}')
                    continue
                for frame in frames:
                    own.extend(self._resolved_snaps(ref.lower(), mat @ frame, (*ancestors, name), True))
            else:
                try:
                    own.extend(_placed_snaps(rec, mat))
                except ValueError as error:
                    self.snap_diagnostics.append(f'{name}: {error}')
        if shadow_only:
            return own
        clears = [r for r in records if r['type'] == 'SNAP_CLEAR']
        clear_all = any(not r.get('id') for r in clears)
        clear_ids = {r['id'].casefold() for r in clears if r.get('id')}
        if clear_all:
            return own
        path = self.find(name)
        if path is not None:
            for ref, sub in _parse_file(path)[1]:
                inherited = self._resolved_snaps(ref, mat @ sub, (*ancestors, name), False)
                own.extend(s for s in inherited if not s.id or s.id.casefold() not in clear_ids)
        return own


def _grid(spec: str) -> list[np.ndarray]:
    """LDCad Xcnt Zcnt Xstep Zstep; either count may be prefixed by C."""
    if not spec.strip():
        return [np.zeros(3)]
    tokens = spec.split(); cursor = 0
    counts = []; centered = []
    try:
        for _ in range(2):
            centre = tokens[cursor].upper() == 'C'
            cursor += int(centre)
            count = int(tokens[cursor]); cursor += 1
            if count < 1 or count > 4096:
                raise ValueError('Invalid snap grid count')
            counts.append(count); centered.append(centre)
        if len(tokens) - cursor != 2:
            raise ValueError('Unsupported snap grid spacing layout')
        dx, dz = map(float, tokens[cursor:])
        if not np.isfinite([dx, dz]).all():
            raise ValueError('Invalid snap grid spacing')
    except (IndexError, TypeError) as error:
        raise ValueError('Invalid snap grid') from error
    return [np.array([(x-(counts[0]-1)/2 if centered[0] else x)*dx, 0.,
                       (z-(counts[1]-1)/2 if centered[1] else z)*dz])
            for x in range(counts[0]) for z in range(counts[1])]


def _meta_frames(rec, include=False):
    def values(key, count, default):
        if key not in rec:
            return np.asarray(default, float)
        data = np.array([float(v) for v in rec[key].split()])
        if len(data) != count or not np.isfinite(data).all():
            raise ValueError(f'Invalid snap {key}')
        return data
    pos = values('pos', 3, [0, 0, 0]); ori = values('ori', 9, np.eye(3).ravel()).reshape(3, 3)
    scale = values('scale', 3, [1, 1, 1]) if include and 'scale' in rec else np.ones(3)
    frames = []
    for offset in _grid(rec.get('grid', '')):
        frame = np.eye(4); frame[:3, :3] = ori @ np.diag(scale)
        frame[:3, 3] = pos + ori @ offset
        frames.append(frame)
    return frames


def _placed_snaps(rec, parent):
    kind = rec['type'].removeprefix('SNAP_').lower()
    if kind not in ('cyl', 'clp', 'fgr', 'gen'):
        return []
    gender = rec.get('gender', rec.get('genderofs', 'F' if kind == 'clp' else '')).upper()
    if gender not in ('M', 'F'):
        return []
    sections = []
    if kind == 'cyl':
        tokens = rec.get('secs', '').split()
        if not tokens or len(tokens) % 3:
            raise ValueError('Invalid cylinder section profile')
        sections = [(tokens[i].upper(), float(tokens[i+1]), float(tokens[i+2])) for i in range(0, len(tokens), 3)]
    elif kind == 'clp':
        sections = [('CLP', float(rec.get('radius', 0)), float(rec.get('length', 0)))]
    elif kind == 'fgr':
        sections = [('FGR', float(rec.get('radius', 4)), float(v)) for v in rec.get('seq', '').split()]
    if any(not np.isfinite([r, length]).all() or r < 0 or length < 0 for _, r, length in sections):
        raise ValueError('Invalid snap section dimensions')
    result = []
    frames = _meta_frames(rec)
    for frame in frames:
        combined = parent @ frame
        raw_axis = combined[:3, :3] @ np.array([0., -1., 0.]); axial_scale = np.linalg.norm(raw_axis)
        if axial_scale < 1e-8:
            continue
        axis = raw_axis / axial_scale
        radial_scale = max(np.linalg.norm(combined[:3, 0]), np.linalg.norm(combined[:3, 2]))
        transformed = tuple((shape, float(radius*radial_scale), float(length*axial_scale)) for shape, radius, length in sections)
        length = sum(s[2] for s in transformed); radius = max((s[1] for s in transformed), default=0.)
        result.append(Snap(gender, tuple(map(float,np.round(combined[:3, 3], 4))), tuple(map(float,np.round(axis, 6))), kind,
                           rec.get('group'), len(frames)>1, rec.get('id'), transformed, length, radius,
                           rec.get('caps', 'one' if kind == 'cyl' else 'none').lower(),
                           rec.get('center', '').lower() == 'true', rec.get('slide', '').lower() == 'true',
                           rec.get('bounding'), rec.get('placement')))
    return result


def _snap_axis(rec: dict, mat: np.ndarray) -> np.ndarray:
    frame = _meta_frames({k:v for k,v in rec.items() if k != 'grid'})[0]
    axis = (mat @ frame)[:3, :3] @ np.array([0., -1., 0.])
    norm = np.linalg.norm(axis)
    return axis/norm if norm else axis


def _parse_ldcad_meta(text: str) -> list[dict]:
    out = []
    for line in text.splitlines():
        match = re.match(r'^\s*0\s+!LDCAD\s+(SNAP_[A-Z]+)\b(.*)$', line, re.I)
        if not match:
            continue
        rec = {'type': match[1].upper()}
        for key, value in re.findall(r'\[\s*([A-Za-z]+)\s*=([^\]]*)\]', match[2]):
            rec[key.lower()] = value.strip()
        out.append(rec)
    return out


@lru_cache(maxsize=None)
def _parse_file(path: str):
    tris: list[np.ndarray] = []
    refs: list[tuple[str, np.ndarray]] = []
    for line in open(path, errors="ignore").read().splitlines():
        if not line or line[0] == "0":
            continue
        toks = line.split()
        if toks[0] == "1":
            mat, ref = _type1(toks)
            if ref is not None:
                refs.append((ref.lower(), mat))
        elif toks[0] in ("3", "4"):
            vals = [float(v) for v in toks[2:] if _is_float(v)]
            n = 3 if toks[0] == "3" else 4
            if len(vals) >= 3 * n:
                tris.append(np.array(vals[: 3 * n], dtype=np.float64).reshape(n, 3))
    return (tuple(tris), tuple(refs))


def _type1(toks: list[str]):
    """1 colour x y z a b c d e f g h i file (row-major 3x3, LDU)."""
    if len(toks) < 15:
        return None, None
    try:
        x, y, z, a, b, c, d, e, f, g, h, i = (float(v) for v in toks[2:14])
    except ValueError:
        return None, None
    mat = np.array([[a, b, c, x], [d, e, f, y], [g, h, i, z], [0.0, 0.0, 0.0, 1.0]])
    ref = toks[14] if len(toks) == 15 else " ".join(toks[14:])
    return mat, ref


def _is_float(v: str) -> bool:
    try:
        float(v)
        return True
    except ValueError:
        return False


def matrix_from_type1(toks: list[str]) -> np.ndarray:
    mat, _ = _type1(toks)
    return mat if mat is not None else np.eye(4)


def load_library(ldraw_root: str) -> LDrawLibrary:
    return LDrawLibrary(ldraw_root)
