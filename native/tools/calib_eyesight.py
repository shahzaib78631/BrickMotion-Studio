"""Measures how far bmshot's picture is from EyeSight's on the calibration scene.

    python/.venv/bin/python native/tools/calib_eyesight.py [--out DIR] [--azimuths 0,90,180,270] [-- extra bmshot flags]

The scene (native/corpus/calib/calib.ldr) and the four EyeSight renders beside it come from
src/dev/calibScene.ts and scripts/render-eyesight-calib.ts: 960x540, a camera 25 studs from the
scene centre, 25 degrees up, a 30 degree vertical field of view, BUILD_FL lights, white world.

Prints, per azimuth and on average, the RMSE (sRGB 0-255) over the whole picture, over the
bricks, and over the floor around them, and the mean brightness of each; writes a side-by-side
of EyeSight, bmshot and their difference for each azimuth.
"""
import argparse, json, math, os, subprocess, sys
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
CALIB = os.path.join(REPO, 'native', 'corpus', 'calib')
BMSHOT = os.path.join(REPO, 'native', 'build', 'render', 'bmshot')
CENTRE = (-2.0, 0.6, 3.0)  # app world studs, +y up (calibScene.ts CALIB_CENTER)


def ldraw(p):  # app studs (+y up, z toward the viewer at az 0) to LDraw units
    return (p[0] * 20, -p[1] * 20, -p[2] * 20)


def camera(az_deg):
    az, el, d = math.radians(az_deg), math.radians(25), 25
    eye = (CENTRE[0] + d * math.cos(el) * math.sin(az), CENTRE[1] + d * math.sin(el), CENTRE[2] + d * math.cos(el) * math.cos(az))
    return ldraw(eye), ldraw(CENTRE)


def shot(out, az, extra):
    eye, target = camera(az)
    args = [BMSHOT, os.path.join(CALIB, 'calib.ldr'), '--out', out, '--size', '960x540', '--fov', '30',
            '--eye', '%g,%g,%g' % eye, '--target', '%g,%g,%g' % target] + extra
    env = dict(os.environ, BM_LDRAW_DIR=os.environ.get('BM_LDRAW_DIR', os.path.join(REPO, 'public', 'ldraw')))
    subprocess.run(args, check=True, env=env, stdout=subprocess.DEVNULL)
    return np.asarray(Image.open(out).convert('RGB')).astype(np.float64)


def rmse(a, b, mask):
    return float(np.sqrt(((a - b) ** 2)[mask].mean())) if mask.any() else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(REPO, 'native', 'build', 'calib'))
    ap.add_argument('--azimuths', default='0,90,180,270')
    ap.add_argument('extra', nargs='*', help='more bmshot flags, after --')
    o = ap.parse_args()
    os.makedirs(o.out, exist_ok=True)
    rows = []
    for az in [int(a) for a in o.azimuths.split(',')]:
        ref = np.asarray(Image.open(os.path.join(CALIB, 'calib_az%d.png' % az)).convert('RGB')).astype(np.float64)
        ours = shot(os.path.join(o.out, 'ours_az%d.png' % az), az, o.extra)
        # Where the bricks are: a plain picture with no floor, shadow or occlusion, against white.
        plain = shot(os.path.join(o.out, 'mask_az%d.png' % az), az, ['--no-floor', '--no-shadows', '--no-ao', '--no-edges'])
        bricks = np.abs(plain - 255).max(axis=2) > 3
        near = np.zeros_like(bricks)
        ys, xs = np.nonzero(bricks)
        if len(ys):  # the floor around them: the bricks' box, grown by a third
            h, w = ys.max() - ys.min(), xs.max() - xs.min()
            near[max(0, ys.min() - h // 3):ys.max() + h // 3, max(0, xs.min() - w // 3):xs.max() + w // 3] = True
        floor = near & ~bricks
        lum = lambda im, m: float(im[m].mean()) if m.any() else 0.0
        r = dict(az=az, all=rmse(ours, ref, np.ones_like(bricks)), bricks=rmse(ours, ref, bricks), floor=rmse(ours, ref, floor),
                 brickLum=(lum(ref, bricks), lum(ours, bricks)), floorLum=(lum(ref, floor), lum(ours, floor)))
        rows.append(r)
        diff = np.clip(128 + (ours - ref) * 2, 0, 255)
        Image.fromarray(np.concatenate([ref, ours, diff], axis=1).astype(np.uint8)).save(os.path.join(o.out, 'side_az%d.png' % az))
        print('az %3d  rmse all %5.2f  bricks %5.2f  floor %5.2f   brick lum ref %5.1f ours %5.1f   floor lum ref %5.1f ours %5.1f' %
              (az, r['all'], r['bricks'], r['floor'], *r['brickLum'], *r['floorLum']))
    mean = lambda k: sum(r[k] for r in rows) / len(rows)
    print('mean    rmse all %5.2f  bricks %5.2f  floor %5.2f' % (mean('all'), mean('bricks'), mean('floor')))
    json.dump(rows, open(os.path.join(o.out, 'scores.json'), 'w'), indent=1)


if __name__ == '__main__':
    sys.exit(main())
