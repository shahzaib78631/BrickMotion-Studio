"""
Compares Blender teacher renders with EyeSight's target.png.

  cd python/neuralshade && uv run python ../../scripts/neural/blender/compare.py \
      <scene dir>[:<render.png>] ... [--scale 0.25] [--crops out.png] [--json out.json]

Without ':<render.png>' the render is <scene dir>/target_blender.png. When the render is smaller
than the target, the target is box-downscaled to its size (tuning at low resolution).
Prints per scene RMSE / MAE (0-255, sRGB) over the whole image and over pixels that are not
backdrop in either image, plus mean colours of white / black / red / tan / backdrop regions
(regions picked from the target by colour), and optionally writes side-by-side crops.
"""
import json
import os
import sys

import numpy as np
from PIL import Image

REGIONS = {
    # target sRGB box → name (picked loosely: lit and shadowed faces of that colour)
    'white': lambda t: (t.min(-1) > 200) & (t.max(-1) - t.min(-1) < 25) & (t.max(-1) < 252),
    'black': lambda t: (t.max(-1) < 60),
    'red': lambda t: (t[..., 0] > 120) & (t[..., 1] < 60) & (t[..., 2] < 60),
    'tan': lambda t: (t[..., 0] > 170) & (t[..., 0] < 235) & (t[..., 1] > 150) & (t[..., 1] < 215) & (t[..., 2] > 100) & (t[..., 2] < 170) & (t[..., 0] - t[..., 2] > 40),
    'blue': lambda t: (t[..., 2] > 100) & (t[..., 0] < 60) & (t[..., 2] - t[..., 1] > 40),
    'backdrop': lambda t: t.min(-1) >= 250,
}


def load_pair(scene, render):
    t = Image.open(os.path.join(scene, 'target.png')).convert('RGB')
    r = Image.open(render).convert('RGB')
    if r.size != t.size:
        t = t.resize(r.size, Image.BOX)
    return np.asarray(t).astype(np.float64), np.asarray(r).astype(np.float64)


def stats(t, r):
    d = r - t
    fg = ~((t.min(-1) >= 250) & (r.min(-1) >= 250))
    out = {
        'rmse': float(np.sqrt((d ** 2).mean())),
        'mae': float(np.abs(d).mean()),
        'rmse_fg': float(np.sqrt((d[fg] ** 2).mean())) if fg.any() else 0.0,
        'bias': float(d.mean()),
        'fg_frac': float(fg.mean()),
    }
    for name, f in REGIONS.items():
        m = f(t)
        if m.sum() > 50:
            out[name] = {'n': int(m.sum()), 'target': t[m].mean(0).round(1).tolist(), 'blender': r[m].mean(0).round(1).tolist()}
    return out


def main():
    args = sys.argv[1:]
    crops = js = None
    pairs = []
    i = 0
    while i < len(args):
        if args[i] == '--crops':
            crops = args[i + 1]; i += 2
        elif args[i] == '--json':
            js = args[i + 1]; i += 2
        else:
            a = args[i]
            scene, _, render = a.partition(':')
            pairs.append((scene, render or os.path.join(scene, 'target_blender.png'))); i += 1
    results, tiles = {}, []
    for scene, render in pairs:
        if not os.path.exists(render):
            print(f'{scene}: no render {render}')
            continue
        t, r = load_pair(scene, render)
        s = stats(t, r)
        name = os.path.basename(os.path.normpath(scene))
        results[name] = s
        regions = '  '.join(f"{k}: T{tuple(int(x) for x in v['target'])} B{tuple(int(x) for x in v['blender'])}" for k, v in s.items() if isinstance(v, dict))
        print(f"{name}: RMSE {s['rmse']:.2f}  MAE {s['mae']:.2f}  RMSE_fg {s['rmse_fg']:.2f}  bias {s['bias']:+.2f}  | {regions}")
        if crops:
            # the busiest 512² window (most foreground) of the target, side by side
            h, w = t.shape[:2]
            cs = min(512, h, w)
            fgm = (t.min(-1) < 200).astype(np.float32)
            best, by, bx = -1, 0, 0
            for y in range(0, h - cs + 1, cs // 4):
                for x in range(0, w - cs + 1, cs // 4):
                    v = fgm[y:y + cs, x:x + cs].mean()
                    if v > best:
                        best, by, bx = v, y, x
            tc, rc = t[by:by + cs, bx:bx + cs], r[by:by + cs, bx:bx + cs]
            diff = np.clip(np.abs(rc - tc) * 4, 0, 255)
            tiles.append(np.concatenate([tc, rc, diff], 1))
    if results:
        m = np.mean([v['rmse'] for v in results.values()])
        mf = np.mean([v['rmse_fg'] for v in results.values()])
        print(f'MEAN over {len(results)}: RMSE {m:.2f}  RMSE_fg {mf:.2f}  MAE {np.mean([v["mae"] for v in results.values()]):.2f}')
    if crops and tiles:
        wmax = max(x.shape[1] for x in tiles)
        tiles = [np.pad(x, ((0, 0), (0, wmax - x.shape[1]), (0, 0)), constant_values=255) for x in tiles]
        Image.fromarray(np.concatenate(tiles, 0).astype(np.uint8)).save(crops)
    if js:
        json.dump(results, open(js, 'w'), indent=1)


if __name__ == '__main__':
    main()
