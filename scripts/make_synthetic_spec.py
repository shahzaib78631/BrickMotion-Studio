"""Build a synthetic instruction spec (images + parts) from the OMR, for testing
the image-mode reconstruction. Writes PNG step images + a spec JSON."""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python"))

from assembly_model.ldraw import load_library
from brickheadz.image_spec import ldconfig_rgb
from brickheadz.instruction_place import Camera, fit_camera, render_pieces, world_points
from brickheadz.reconstruct import steps_from_omr

OUT = os.path.join(HERE, "..", ".cache", "aquaman", "synthetic")
SIZE = 256


def save_png(rgb, path):
    import pymupdf

    arr = np.clip(rgb, 0, 255).astype(np.uint8)
    h, w = arr.shape[:2]
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, w, h), False)
    pix.samples_mv[:] = arr.tobytes()
    pix.save(path)


def main(n_steps=3):
    lib = load_library(os.path.join(HERE, "..", "public", "ldraw"))
    palette = ldconfig_rgb(os.path.join(HERE, "..", "public", "ldraw", "LDConfig.ldr"))
    steps = steps_from_omr(os.path.join(HERE, "..", ".cache", "aquaman", "omr", "aquaman-assembled.mpd"))
    allpts = np.concatenate([world_points(lib, p, m) for s in steps for p, c, m in s])
    cam = fit_camera(allpts, 30, 25, SIZE)
    os.makedirs(OUT, exist_ok=True)
    spec_steps = []
    for k in range(n_steps):
        built = [pc for s in steps[:k] for pc in s]
        new = steps[k]
        entries = [(p, palette.get(c, (128, 128, 128)), m, False) for p, c, m in built]
        entries += [(p, palette.get(c, (128, 128, 128)), m, True) for p, c, m in new]
        rgb, _ = render_pieces(lib, entries, cam, SIZE)
        path = os.path.join(OUT, f"step{k+1}.png")
        save_png(rgb, path)
        spec_steps.append({"image": path, "parts": [[p, c] for p, c, m in new]})
    spec = {"cam": {"yaw": cam.yaw, "pitch": cam.pitch, "scale": cam.scale, "ox": cam.ox, "oy": cam.oy}, "steps": spec_steps}
    import json

    with open(os.path.join(OUT, "spec.json"), "w") as f:
        json.dump(spec, f, indent=1)
    print("wrote", os.path.join(OUT, "spec.json"), "with", len(spec_steps), "steps")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 3)
