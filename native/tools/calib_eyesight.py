"""Measures how far bmshot's picture is from EyeSight's on the calibration scene.

    python/.venv/bin/python native/tools/calib_eyesight.py [--scene calib|glass] [--tool bmshot|bmexport] [--samples S] [--out DIR] [--azimuths 0,90,180,270] [-- extra flags]

The scene (native/corpus/calib/calib.ldr) and the four EyeSight renders beside it come from
src/dev/calibScene.ts and scripts/render-eyesight-calib.ts: 960x540, a camera 25 studs from the
scene centre, 25 degrees up, a 30 degree vertical field of view, BUILD_FL lights, white world.
The glass scene (glass.ldr, glass_az*.png) comes from native/tools/render_eyesight_glass.ts, with
the same cameras.

Prints, per azimuth and on average, the RMSE (sRGB 0-255) over the whole picture, over the
bricks, and over the floor around them, and the mean brightness of each (where there is glass,
the bricks split into glass and the solid pieces not behind it); writes a side-by-side
of EyeSight, ours and their difference for each azimuth. --tool bmexport scores the path tracer
(`bmexport still ... --samples S`, denoised) instead of the viewport; the masks are bmshot's either way.
"""
import argparse, json, math, os, subprocess, sys
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
CALIB = os.path.join(REPO, 'native', 'corpus', 'calib')
BMSHOT = os.path.join(REPO, 'native', 'build', 'render', 'bmshot')
BMEXPORT = os.path.join(REPO, 'native', 'build', 'render', 'bmexport')
CENTRE = (-2.0, 0.6, 3.0)  # app world studs, +y up (calibScene.ts CALIB_CENTER)


def ldraw(p):  # app studs (+y up, z toward the viewer at az 0) to LDraw units
    return (p[0] * 20, -p[1] * 20, -p[2] * 20)


def camera(az_deg):
    az, el, d = math.radians(az_deg), math.radians(25), 25
    eye = (CENTRE[0] + d * math.cos(el) * math.sin(az), CENTRE[1] + d * math.sin(el), CENTRE[2] + d * math.cos(el) * math.cos(az))
    return ldraw(eye), ldraw(CENTRE)


def shot(scene, out, az, extra, tool='bmshot', samples=512):
    """`scene`: a calibration scene's name, or an .ldr file's path."""
    eye, target = camera(az)
    path = scene if scene.endswith('.ldr') else os.path.join(CALIB, scene + '.ldr')
    head = [BMSHOT, path] if tool == 'bmshot' else [BMEXPORT, 'still', path, '--samples', str(samples)]
    args = head + ['--out', out, '--size', '960x540', '--fov', '30',
            '--eye', '%g,%g,%g' % eye, '--target', '%g,%g,%g' % target] + extra
    env = dict(os.environ, BM_LDRAW_DIR=os.environ.get('BM_LDRAW_DIR', os.path.join(REPO, 'public', 'ldraw')))
    subprocess.run(args, check=True, env=env, stdout=subprocess.DEVNULL)
    return np.asarray(Image.open(out).convert('RGB')).astype(np.float64)


def solid_only(scene, out):
    """The scene less its transparent pieces (LDConfig.ldr's colours with an ALPHA), written to `out`."""
    library = os.environ.get('BM_LDRAW_DIR', os.path.join(REPO, 'public', 'ldraw'))
    clear = set()
    for line in open(os.path.join(library, 'LDConfig.ldr'), encoding='utf-8', errors='replace'):
        words = line.split()
        if len(words) > 4 and words[1] == '!COLOUR' and 'ALPHA' in words and 'CODE' in words:
            clear.add(int(words[words.index('CODE') + 1]))
    kept = [line for line in open(os.path.join(CALIB, scene + '.ldr')) if not (line.startswith('1 ') and int(line.split()[1]) in clear)]
    open(out, 'w').writelines(kept)
    return out


def rmse(a, b, mask):
    return float(np.sqrt(((a - b) ** 2)[mask].mean())) if mask.any() else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scene', default='calib', choices=['calib', 'glass'])
    ap.add_argument('--out', default=os.path.join(REPO, 'native', 'build', 'calib'))
    ap.add_argument('--azimuths', default='0,90,180,270')
    ap.add_argument('--tool', default='bmshot', choices=['bmshot', 'bmexport'])
    ap.add_argument('--samples', type=int, default=512, help='bmexport: samples a pixel')
    ap.add_argument('extra', nargs='*', help='more flags for the tool scored, after --')
    o = ap.parse_args()
    os.makedirs(o.out, exist_ok=True)
    rows = []
    solidScene = solid_only(o.scene, os.path.join(o.out, '%s_solid.ldr' % o.scene))
    for az in [int(a) for a in o.azimuths.split(',')]:
        ref = np.asarray(Image.open(os.path.join(CALIB, '%s_az%d.png' % (o.scene, az))).convert('RGB')).astype(np.float64)
        ours = shot(o.scene, os.path.join(o.out, '%s_%s_az%d.png' % (o.scene, 'ours' if o.tool == 'bmshot' else 'path', az)), az, o.extra, o.tool, o.samples)
        # Where the bricks are: a plain picture with no floor, shadow or occlusion, against black
        # and against white (glass that lets the background through shows on one or the other).
        plainArgs = ['--no-floor', '--no-shadows', '--no-ao', '--no-edges', '--background']
        plain = shot(o.scene, os.path.join(o.out, '%s_mask_az%d.png' % (o.scene, az)), az, plainArgs + ['0,0,0'])
        white = shot(o.scene, os.path.join(o.out, '%s_maskw_az%d.png' % (o.scene, az)), az, plainArgs + ['255,255,255'])
        bricks = (plain.max(axis=2) > 3) | (white.min(axis=2) < 252)
        # Solid: the opaque pieces where nothing transparent is in front of them (the same drawn
        # alone); glass, the rest of the bricks.
        alone = shot(solidScene, os.path.join(o.out, '%s_solid_az%d.png' % (o.scene, az)), az, plainArgs + ['0,0,0'])
        solid = bricks & (alone.max(axis=2) > 3) & (np.abs(alone - plain).max(axis=2) <= 3)
        glass = bricks & ~solid
        near = np.zeros_like(bricks)
        ys, xs = np.nonzero(bricks)
        if len(ys):  # the floor around them: the bricks' box, grown by a third
            h, w = ys.max() - ys.min(), xs.max() - xs.min()
            near[max(0, ys.min() - h // 3):ys.max() + h // 3, max(0, xs.min() - w // 3):xs.max() + w // 3] = True
        floor = near & ~bricks
        lum = lambda im, m: float(im[m].mean()) if m.any() else 0.0
        r = dict(az=az, all=rmse(ours, ref, np.ones_like(bricks)), bricks=rmse(ours, ref, bricks), floor=rmse(ours, ref, floor), glass=rmse(ours, ref, glass), solid=rmse(ours, ref, solid),
                 glassLum=(lum(ref, glass), lum(ours, glass)), solidLum=(lum(ref, solid), lum(ours, solid)),
                 brickLum=(lum(ref, bricks), lum(ours, bricks)), floorLum=(lum(ref, floor), lum(ours, floor)), pixels=(int(bricks.sum()), int(floor.sum()), int(bricks.size)))
        # How much of the whole picture's squared error each part holds.
        r['share'] = tuple(float(m.sum() * r[k] ** 2 / max(bricks.size * r['all'] ** 2, 1e-9)) for k, m in (('bricks', bricks), ('floor', floor)))
        rows.append(r)
        diff = np.clip(128 + (ours - ref) * 2, 0, 255)
        Image.fromarray(np.concatenate([ref, ours, diff], axis=1).astype(np.uint8)).save(os.path.join(o.out, '%s_%s_az%d.png' % (o.scene, 'side' if o.tool == 'bmshot' else 'pathside', az)))
        print('az %3d  rmse all %5.2f  bricks %5.2f  floor %5.2f   brick lum ref %5.1f ours %5.1f   floor lum ref %5.1f ours %5.1f   error share bricks %.2f floor %.2f' %
              (az, r['all'], r['bricks'], r['floor'], *r['brickLum'], *r['floorLum'], *r['share']))
        if glass.any():
            print('        glass %5.2f (lum ref %5.1f ours %5.1f)  solid %5.2f (lum ref %5.1f ours %5.1f)' % (r['glass'], *r['glassLum'], r['solid'], *r['solidLum']))
    mean = lambda k: sum(r[k] for r in rows) / len(rows)
    print('mean    rmse all %5.2f  bricks %5.2f  floor %5.2f' % (mean('all'), mean('bricks'), mean('floor')) +
          ('   glass %5.2f  solid %5.2f' % (mean('glass'), mean('solid')) if any(r['glass'] for r in rows) else ''))
    json.dump(rows, open(os.path.join(o.out, '%s_%sscores.json' % (o.scene, '' if o.tool == 'bmshot' else 'path_')), 'w'), indent=1)


if __name__ == '__main__':
    sys.exit(main())
