"""Learn what real LEGO buildings look like, from the OMR, for the building generator.

Reads every downloaded model, keeps the ones that are buildings by their contents (not
their theme: Town also has trucks), and writes src/data/buildingPriors.generated.ts:

* colour schemes: wall, second wall colour, roof, window frame, door, trim, as real sets
  combine them, weighted by how many buildings use each;
* which window frames sets use (mapped onto the generator's window kinds);
* sloped or flat roofs, and 45° or 33° slopes;
* footprint sizes and floor counts;
* a fingerprint of each building (its share of each part and colour), so a generated
  model can say how close it comes to any real set: its originality.

    python -I priors.py MODELS_DIR PRIORS.ts FINGERPRINTS.ts [--min-windows 2]
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from omr.reader import LIB, description, kind, read_model  # noqa: E402


def trans_colours() -> set[int]:
    out = set()
    for line in (LIB / 'LDConfig.ldr').read_text(errors='ignore').splitlines():
        if '!COLOUR' in line and 'ALPHA' in line:
            m = re.search(r'CODE\s+(\d+)', line)
            if m:
                out.add(int(m.group(1)))
    return out


TRANS = trans_colours()


def studs(desc: str) -> tuple[int, int, int] | None:
    """'Window 1 x 2 x 3 ...' -> (1, 2, 3)."""
    m = re.search(r'(\d+)\s*x\s*(\d+)(?:\s*x\s*(\d+))?', desc)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)


def window_kind(part: str) -> str | None:
    d = description(part)
    if not d.startswith('Window') or 'Glass' in d or 'Pane' in d or 'Shutter' in d:
        return None
    s = studs(d)
    if not s:
        return None
    _, w, h = s
    if w >= 4:
        return 'window4x3'
    return 'window2x3' if h >= 3 else 'window2x2'


def top(counter: collections.Counter, skip=()) -> int | None:
    for c, _ in counter.most_common():
        if c not in skip and c not in TRANS:
            return c
    return None


def analyse(parts) -> dict | None:
    if len(parts) < 60:
        return None
    kinds = collections.Counter(kind(p.part) for p in parts)
    n = len(parts)
    windows = [p for p in parts if window_kind(p.part)]
    doors = [p for p in parts if kind(p.part) == 'door' and 'Frame' in description(p.part)]
    structural = kinds['brick'] + kinds['plate'] + kinds['tile'] + kinds['slope'] + kinds['window'] + kinds['door']
    if len(windows) < ARGS.min_windows or kinds['wheel'] > 0.03 * n or structural < 0.55 * n or kinds['other'] > 0.35 * n:
        return None

    bricks = [p for p in parts if kind(p.part) == 'brick']
    wall_c = collections.Counter(p.color for p in bricks)
    wall = top(wall_c)
    if wall is None:
        return None
    second = top(wall_c, skip={wall})
    second_share = wall_c[second] / max(1, len(bricks)) if second is not None else 0
    slopes = [p for p in parts if kind(p.part) == 'slope']
    roof = top(collections.Counter(p.color for p in slopes)) if len(slopes) >= 6 else None
    frame = top(collections.Counter(p.color for p in windows))
    door = top(collections.Counter(p.color for p in parts if kind(p.part) == 'door'))
    trim = top(collections.Counter(p.color for p in parts if kind(p.part) in ('plate', 'tile')), skip={wall})

    # size from the bricks' positions (LDU; studs are 20, bricks 24 high)
    xs = [p.matrix[0, 3] for p in bricks]
    zs = [p.matrix[2, 3] for p in bricks]
    ys = [p.matrix[1, 3] for p in bricks]
    w = round((max(xs) - min(xs)) / 20) + 1
    d = round((max(zs) - min(zs)) / 20) + 1
    h = round((max(ys) - min(ys)) / 24) + 1
    # floors: window rows by sill height, rows closer than 3 bricks are one floor
    sills = sorted({round(p.matrix[1, 3] / 24) for p in windows})
    floors = 0
    last = None
    for s in sills:
        if last is None or abs(s - last) >= 3:
            floors += 1
            last = s

    hist = collections.Counter(f'{p.part}:{p.color}' for p in parts)
    return {
        'scheme': {'wall': wall, 'stripe': second if second_share >= 0.2 else None, 'roof': roof, 'frame': frame, 'door': door, 'trim': trim},
        'windows': collections.Counter(window_kind(p.part) for p in windows),
        'doors': len(doors),
        'slopes': len(slopes),
        'slope33': sum('33' in description(p.part) for p in slopes),
        'size': [w, d, h],
        'floors': max(1, floors),
        'pieces': n,
        'hist': [[k, round(v / n, 4)] for k, v in hist.most_common(40)],
    }


def main() -> None:
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument('models')
    ap.add_argument('out')
    ap.add_argument('fingerprints')
    ap.add_argument('--min-windows', type=int, default=2)
    ARGS = ap.parse_args()
    root = Path(ARGS.models)
    manifest = {m['file']: m for m in json.loads((root / 'manifest.json').read_text())} if (root / 'manifest.json').exists() else {}
    files = sorted([*root.glob('*/*.mpd'), *root.glob('*/*.ldr')])
    found = []
    for i, f in enumerate(files, 1):
        print(f'::progress {i}/{len(files)}', flush=True)
        try:
            a = analyse(read_model(f))
        except Exception as e:  # a broken file is skipped, not fatal
            print(f'skip {f.name}: {e}', flush=True)
            continue
        if a:
            rel = str(f.relative_to(root))
            m = manifest.get(rel, {})
            a.update({'set': f.parent.name, 'name': m.get('name', f.stem), 'theme': m.get('theme', ''), 'file': rel})
            found.append(a)

    # schemes: identical role tuples merge, weighted by how many buildings use them
    schemes = collections.Counter(json.dumps(b['scheme'], sort_keys=True) for b in found)
    windows = collections.Counter()
    for b in found:
        windows.update({k: v for k, v in b['windows'].items() if k})
    sloped = sum(1 for b in found if b['slopes'] >= 6)
    s33 = sum(b['slope33'] for b in found)
    sall = sum(b['slopes'] for b in found)
    footprints = collections.Counter((min(b['size'][0], 32), min(b['size'][1], 32)) for b in found)
    floors = collections.Counter(min(b['floors'], 6) for b in found)

    data = {
        'buildings': len(found),
        'schemes': [{**json.loads(k), 'weight': v} for k, v in schemes.most_common()],
        'windows': dict(windows),
        'roof': {'sloped': sloped, 'flat': len(found) - sloped, 'slope33Share': round(s33 / max(1, sall), 3)},
        'footprints': [[w, d, c] for (w, d), c in footprints.most_common()],
        'floors': {str(k): v for k, v in sorted(floors.items())},
    }
    prints = [{'set': b['set'], 'name': b['name'], 'theme': b['theme'], 'pieces': b['pieces'], 'hist': b['hist']} for b in found]
    head = ('// Generated by python/omr/priors.py from the LDraw Official Model Repository\n'
            '// (library.ldraw.org/omr, CC BY 2.0/4.0: models by their OMR authors). Do not edit.\n')
    Path(ARGS.out).write_text(head + "import type { BuildingPriors } from '../generate/priors';\n\n"
                              f"export const BUILDING_PRIORS: BuildingPriors = {json.dumps(data, separators=(',', ':'))};\n")
    Path(ARGS.fingerprints).write_text(head + "import type { SetFingerprint } from '../generate/priors';\n\n"
                                       f"export const SET_FINGERPRINTS: SetFingerprint[] = {json.dumps(prints, separators=(',', ':'))};\n")
    out = Path(ARGS.out)
    print(f'{len(found)} buildings from {len(files)} files -> {out}', flush=True)


if __name__ == '__main__':
    main()
