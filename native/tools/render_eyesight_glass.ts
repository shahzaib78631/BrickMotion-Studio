/**
 * Renders a glass calibration scene through EyeSight from several camera azimuths, the same
 * cameras as the opaque calibration (src/dev/calibScene.ts calibCamera), and writes the scene
 * as LDraw beside them, for fitting the native viewport's glass:
 *
 *   npx tsx native/tools/render_eyesight_glass.ts 0 90 180 270
 *
 * Out: native/corpus/calib/glass.ldr and glass_az<deg>.png (960x540, 128 samples, BUILD_FL,
 * white world, shadow-catching ground: what scripts/render-eyesight-calib.ts uses).
 *
 * The scene: five 2x2 bricks in Studio's glass colours (clear, red, light blue, yellow,
 * green); a clear brick in front of an opaque red one (what shows through); a clear round
 * brick (curved glass); a light blue brick standing on an opaque white one; a dark blue tile
 * floating a plate above the ground (its shadow). Positions are LDraw units, Y down, part
 * origins at the top of the part.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { PartLibrary } from '../../src/ldraw/library';
import { buildPartGeometry, type PartGeometry } from '../../src/ldraw/geometry';
import { parseLDConfig } from '../../src/ldraw/colors';
import { buildCollada, type ColladaPiece } from '../../src/export/collada';
import { calibCamera, type CalibPiece } from '../../src/dev/calibScene';
import { DEFAULT_RENDER, LDRAW, ROOT, runEyesight } from '../../scripts/lib/eyesight';

const GLASS = [47, 36, 43, 46, 34]; // Trans-Clear, Trans-Red, Trans-Light Blue, Trans-Yellow, Trans-Green
const PIECES: CalibPiece[] = [
  ...GLASS.map((color, i): CalibPiece => ({ key: `glass${i}`, part: '3003', color, x: -160 + i * 60, y: 0, z: 0 })),
  { key: 'behind', part: '3003', color: 4, x: -160, y: 0, z: -110 },
  { key: 'front', part: '3003', color: 47, x: -160, y: 0, z: -170 },
  { key: 'round', part: '3941', color: 47, x: -40, y: 0, z: -120 },
  { key: 'base', part: '3003', color: 15, x: 80, y: 0, z: -120 },
  { key: 'onTop', part: '3003', color: 43, x: 80, y: -24, z: -120 },
  { key: 'floating', part: '3068b', color: 33, x: 20, y: -8, z: -120 },
];

function ldrawText(): string {
  const lines = ['0 EyeSight glass calibration scene (native/tools/render_eyesight_glass.ts)', '0 Name: glass.ldr'];
  for (const p of PIECES) lines.push(`1 ${p.color} ${p.x} ${p.y} ${p.z} 1 0 0 0 1 0 0 0 1 ${p.part}.dat`);
  return lines.join('\n') + '\n';
}

async function main() {
  const azimuths = process.argv.slice(2).map(Number).filter(Number.isFinite);
  if (!azimuths.length) azimuths.push(0, 90, 180, 270);
  const colors = parseLDConfig(readFileSync(join(LDRAW, 'LDConfig.ldr'), 'utf8'));
  const lib = new PartLibrary(async (p) => (existsSync(join(LDRAW, p)) ? readFileSync(join(LDRAW, p), 'utf8') : null));
  const geometry = new Map<string, PartGeometry | null>();
  for (const id of new Set(PIECES.map((p) => p.part))) {
    const flat = await lib.loadPart(id);
    geometry.set(id, flat ? buildPartGeometry(flat) : null);
  }
  const pieces: ColladaPiece[] = PIECES.map((p) => ({ key: p.key, part: p.part, color: p.color, world: new THREE.Matrix4().makeTranslation(p.x, p.y, p.z) }));
  const corpus = join(ROOT, 'native', 'corpus', 'calib');
  const work = join(ROOT, 'native', 'build', 'calib');
  mkdirSync(corpus, { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(corpus, 'glass.ldr'), ldrawText());
  const render = { ...DEFAULT_RENDER, width: 960, height: 540, samples: 128 };
  let done = 0;
  for (const az of azimuths) {
    const cam = calibCamera(az);
    const dae = join(work, `glass_az${az}.dae`);
    writeFileSync(dae, buildCollada({
      name: `glass ${az}`, pieces, geometryOf: (id) => geometry.get(id) ?? null, colors,
      camera: { position: new THREE.Vector3(...cam.position), target: new THREE.Vector3(...cam.target), fov: cam.fov, near: 0.05, far: 5000, width: render.width, height: render.height },
      matrixOrder: 'row',
    }));
    console.log(`::progress ${done}/${azimuths.length} rendering az ${az}`);
    await runEyesight(render, dae, join(corpus, `glass_az${az}.png`), true);
    done++;
    console.log(`::progress ${done}/${azimuths.length} glass_az${az}.png`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
