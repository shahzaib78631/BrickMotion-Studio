/**
 * Renders the calibration scene (src/dev/calibScene.ts) through EyeSight from several camera
 * azimuths, into public/_calib/calib_az<deg>.png, for fitting the viewport to it.
 *
 *   npx tsx scripts/render-eyesight-calib.ts 0 90 180 270
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { PartLibrary } from '../src/ldraw/library';
import { buildPartGeometry, type PartGeometry } from '../src/ldraw/geometry';
import { parseLDConfig } from '../src/ldraw/colors';
import { buildCollada, type ColladaPiece } from '../src/export/collada';
import { CALIB_PIECES, calibCamera } from '../src/dev/calibScene';
import { DEFAULT_RENDER, LDRAW, ROOT, runEyesight } from './lib/eyesight';

async function main() {
  const azimuths = process.argv.slice(2).map(Number).filter(Number.isFinite);
  if (!azimuths.length) azimuths.push(0, 90);
  const colors = parseLDConfig(readFileSync(join(LDRAW, 'LDConfig.ldr'), 'utf8'));
  const lib = new PartLibrary(async (p) => (existsSync(join(LDRAW, p)) ? readFileSync(join(LDRAW, p), 'utf8') : null));
  const geometry = new Map<string, PartGeometry | null>();
  for (const id of new Set(CALIB_PIECES.map((p) => p.part))) {
    const flat = await lib.loadPart(id);
    geometry.set(id, flat ? buildPartGeometry(flat) : null);
  }
  const pieces: ColladaPiece[] = CALIB_PIECES.map((p) => ({
    key: p.key, part: p.part, color: p.color,
    world: new THREE.Matrix4().makeTranslation(p.x, p.y, p.z).multiply(new THREE.Matrix4().makeRotationY(((p.rotY ?? 0) * Math.PI) / 180)),
  }));
  const out = join(ROOT, 'public', '_calib');
  mkdirSync(out, { recursive: true });
  const render = { ...DEFAULT_RENDER, width: 960, height: 540, samples: 128 };
  for (const az of azimuths) {
    const cam = calibCamera(az);
    const dae = join(out, `calib_az${az}.dae`);
    writeFileSync(dae, buildCollada({
      name: `calib ${az}`, pieces, geometryOf: (id) => geometry.get(id) ?? null, colors,
      camera: { position: new THREE.Vector3(...cam.position), target: new THREE.Vector3(...cam.target), fov: cam.fov, near: 0.05, far: 5000, width: render.width, height: render.height },
      matrixOrder: 'row',
    }));
    console.log(`… az ${az}`);
    await runEyesight(render, dae, join(out, `calib_az${az}.png`), true);
    console.log(`✓ calib_az${az}.png`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
