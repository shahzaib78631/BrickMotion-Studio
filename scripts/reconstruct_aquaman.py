"""Driver: reconstruct the Aquaman model from synthetic instruction step images.

This exercises the full pipeline (render instruction step -> segment new parts ->
inverse-render pose search -> assemble -> benchmark vs the OMR ground truth).
Run: uv run python scripts/reconstruct_aquaman.py [n_steps]
"""
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python"))

from assembly_model.ldraw import load_library
from brickheadz.image_spec import ldconfig_rgb
from brickheadz.instruction_place import (
    Camera,
    colour_mask,
    fit_camera,
    reconstruct_step,
    render_pieces,
    world_points,
)

SIZE = 160
YAW, PITCH = 30, 25


def parse_steps(path):
    steps, cur = [], []
    for ln in open(path, errors="ignore"):
        if ln.startswith("0 STEP"):
            steps.append(cur); cur = []
        elif ln.startswith("1 "):
            f = ln.split()
            color = int(f[1])
            vals = list(map(float, f[2:14]))
            m = np.eye(4); m[:3, :3] = np.array(vals[3:12]).reshape(3, 3); m[:3, 3] = vals[:3]
            cur.append((f[14].lower().replace(".dat", ""), color, m))
    if cur:
        steps.append(cur)
    return steps


def main(n_steps=30, use_learn=False, use_net=False):
    lib = load_library(os.path.join(HERE, "..", "public", "ldraw"))
    palette = ldconfig_rgb(os.path.join(HERE, "..", "public", "ldraw", "LDConfig.ldr"))
    steps = parse_steps(os.path.join(HERE, "..", ".cache", "aquaman", "omr", "aquaman-assembled.mpd"))

    from brickheadz import place_learn as PL

    model_path = os.path.join(HERE, "..", ".cache", "brickheadz", "placement-model.json")
    learn = PL.load(model_path) if (use_learn and os.path.exists(model_path)) else None
    net = None
    if use_net:
        from brickheadz import verify_learn as VL

        vp = os.path.join(HERE, "..", ".cache", "brickheadz", "verifier.pt")
        if os.path.exists(vp):
            net = VL.load(vp)
    print("learned scorer:", "on" if learn else "off", "| CNN verifier:", "on" if net else "off")

    allpts = np.concatenate([world_points(lib, p, m) for s in steps for p, c, m in s])
    cam = fit_camera(allpts, YAW, PITCH, SIZE)

    y_cands = list(range(0, 40))
    occupied: set = set()
    built: list = []
    ok = miss = fail = 0
    t0 = time.time()
    for si, step in enumerate(steps[:n_steps], 1):
        entries = [(p, palette.get(c, (128, 128, 128)), m, False) for p, c, m in built]
        entries += [(p, palette.get(c, (128, 128, 128)), m, True) for p, c, m in step]
        rgb, _ = render_pieces(lib, entries, cam, SIZE)
        builtm = np.zeros((SIZE, SIZE), bool)
        if built:
            builtm = render_pieces(lib, [(p, (150, 150, 150), m, False) for p, c, m in built], cam, SIZE)[1]
        gray = rgb.mean(2) / 255.0
        step_new = [(p, c, m, None) for p, c, m in step]
        rec = reconstruct_step(lib, step_new, cam, SIZE, occupied, y_cands, rgb, palette,
                               learn=learn, builtm=builtm, net=net, gray=gray)
        for (p, c, grid, m, score, _gt), (gp, gc, gm) in zip(rec, step):
            if m is None:
                fail += 1
                continue
            dt = float(np.linalg.norm(m[:3, 3] - gm[:3, 3]))
            dr = float(np.abs(m[:3, :3] - gm[:3, :3]).max())
            if dt < 4.5 and dr < 1e-3:
                ok += 1
            else:
                miss += 1
            built.append((p, c, m))
        print(f"step {si:2d}: new={len(step):2d} ok={ok:3d} miss={miss:2d} fail={fail:2d}  ({time.time()-t0:5.0f}s)")
    total = ok + miss + fail
    print(f"\nreconstructed exactly {ok}/{total} pieces ({100*ok/max(1,total):.1f}%)  miss={miss} fail={fail}")


if __name__ == "__main__":
    pos = [a for a in sys.argv[1:] if not a.startswith("-")]
    main(int(pos[0]) if pos else 30, "--learn" in sys.argv, "--net" in sys.argv)
