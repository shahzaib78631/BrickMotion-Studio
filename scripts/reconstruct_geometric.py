"""Benchmark the geometry-first solver against the OMR (no learning)."""
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python"))

from assembly_model.ldraw import load_library
from brickheadz.geometric_solver import score_against_truth, solve_step
from brickheadz.image_spec import ldconfig_rgb
from brickheadz.instruction_place import fit_camera, render_pieces, world_points
from brickheadz.reconstruct import steps_from_omr

SIZE = 256
YAW, PITCH = 30, 25


def main(n_steps=30):
    lib = load_library(os.path.join(HERE, "..", "public", "ldraw"))
    palette = ldconfig_rgb(os.path.join(HERE, "..", "public", "ldraw", "LDConfig.ldr"))
    steps = steps_from_omr(os.path.join(HERE, "..", ".cache", "aquaman", "omr", "aquaman-assembled.mpd"))
    cam = fit_camera(np.concatenate([world_points(lib, p, m) for s in steps for p, c, m in s]), YAW, PITCH, SIZE)

    occupied: set = set()
    H: dict = {}
    built: list = []
    ok = miss = fail = 0
    t0 = time.time()
    for si, step in enumerate(steps[:n_steps], 1):
        entries = [(p, palette.get(c, (128, 128, 128)), m, False) for p, c, m in built]
        entries += [(p, palette.get(c, (128, 128, 128)), m, True) for p, c, m in step]
        rgb, _ = render_pieces(lib, entries, cam, SIZE)
        parts = [(p, c) for p, c, m in step]
        rec = solve_step(lib, parts, cam, SIZE, rgb, palette, occupied, H)
        s_ok, _m, s_fail = score_against_truth(lib, rec, step)
        ok += s_ok
        fail += s_fail
        for (p, c, key, m, score) in rec:
            if m is not None:
                built.append((p, c, m))
        print(f"step {si:2d}: new={len(step):2d} ok={ok:3d} fail={fail:2d}  ({time.time()-t0:4.0f}s)")
    total = sum(len(s) for s in steps[:n_steps])
    print(f"\nGEOMETRIC: reconstructed {ok}/{total} ({100*ok/max(1,total):.1f}%) up to global translation  fail={fail}")


if __name__ == "__main__":
    pos = [a for a in sys.argv[1:] if not a.startswith("-")]
    main(int(pos[0]) if pos else 30)
