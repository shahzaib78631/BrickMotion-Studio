"""Read an LDraw model (.mpd/.ldr) into placed parts, for mining.

Every part comes out with its world matrix (LDU, y down), its real colour (colour 16
and 24 inherit from the submodel's placement, as LDraw says), the build step it is
added in (STEP lines, counted through submodels in walk order) and its kind from the
part library's description: brick, plate, tile, slope, window, door, wheel, minifig…

Files are read as text only; nothing in them is executed.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

LIB = Path(__file__).resolve().parents[2] / 'public' / 'ldraw'


@dataclass
class Part:
    part: str  # library id, lower case, no .dat
    color: int
    matrix: np.ndarray  # 4x4 part -> model, LDU, y down
    step: int
    submodel: str


def _sections(text: str) -> tuple[list[str], dict[str, list[str]]]:
    order: list[str] = []
    files: dict[str, list[str]] = {}
    cur = None
    for line in text.splitlines():
        s = line.strip()
        if s.startswith('0 FILE'):
            cur = s[6:].strip().lower()
            if cur not in files:
                order.append(cur)
                files[cur] = []
            continue
        if cur is None:
            cur = '!main'
            order.append(cur)
            files[cur] = []
        files[cur].append(s)
    return order, files


def _matrix(t: list[str]) -> np.ndarray:
    x, y, z, a, b, c, d, e, f, g, h, i = (float(v) for v in t[2:14])
    return np.array([[a, b, c, x], [d, e, f, y], [g, h, i, z], [0, 0, 0, 1]])


def _part_id(ref: str) -> str:
    n = ref.strip().lower().replace('\\', '/').rsplit('/', 1)[-1]
    if ' - ' in n:  # OMR embedded parts "<set> - <part>.dat"
        n = n.split(' - ', 1)[1]
    return re.sub(r'\.(dat|ldr|mpd)$', '', n)


def read_model(path: str | Path) -> list[Part]:
    order, files = _sections(Path(path).read_text(errors='ignore'))
    if not order:
        return []
    out: list[Part] = []
    step = [0]

    def walk(name: str, parent: np.ndarray, color: int, depth: int) -> None:
        if depth > 12:
            return
        for s in files.get(name, []):
            t = s.split()
            if not t:
                continue
            if t[0] == '0' and len(t) > 1 and t[1] in ('STEP', 'ROTSTEP'):
                step[0] += 1
                continue
            if t[0] != '1' or len(t) < 15:
                continue
            try:
                m = parent @ _matrix(t)
                c = int(t[1])
            except ValueError:
                continue
            if c in (16, 24):
                c = color
            ref = ' '.join(t[14:]).strip().lower()
            if ref in files and not ref.endswith('.dat'):
                walk(ref, m, c, depth + 1)
            else:
                out.append(Part(_part_id(ref), c, m, step[0], name))

    walk(order[0], np.eye(4), 7, 0)
    return out


@lru_cache(maxsize=None)
def description(part: str) -> str:
    """The part's library description ('Brick  2 x  4'), or '' when unknown."""
    for sub in ('parts', 'p', 'unofficial/parts'):
        f = LIB / sub / f'{part}.dat'
        if f.exists():
            with f.open(errors='ignore') as fh:
                first = fh.readline().strip()
            d = first[1:].strip() if first.startswith('0') else ''
            if d.startswith('~Moved to'):
                return description(d.split()[-1].lower())
            return re.sub(r'\s+', ' ', d.lstrip('~=_|'))
    return ''


KINDS = [
    ('window', r'^(Window|Glass for Window|Shutter)'),
    ('door', r'^(Door|Garage Roller Door)'),
    ('slope', r'^(Slope|Wedge|Roof)'),
    ('brick', r'^Brick'),
    ('plate', r'^Plate'),
    ('tile', r'^Tile'),
    ('wheel', r'^(Wheel|Tyre|Tire)'),
    ('minifig', r'^(Minifig|Torso|Legs|Hips|Arm|Hand|Head)'),
    ('fence', r'^(Fence|Bar|Support|Pillar|Column)'),
    ('plant', r'^(Plant|Tree|Flower)'),
]


def kind(part: str) -> str:
    d = description(part)
    for k, pat in KINDS:
        if re.match(pat, d):
            return k
    return 'other'
