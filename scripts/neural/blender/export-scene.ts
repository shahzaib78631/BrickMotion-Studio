/**
 * Exports neural-shader training scenes (data/neuralshade/scene_X/scene.json) for the Blender
 * Cycles teacher renderer (render.py next to this file).
 *
 *   npx tsx scripts/neural/blender/export-scene.ts <scene dir> [<scene dir> …] [--out <root>]
 *
 * Per scene it writes <root>/<id>/ (default root /private/tmp/claude-501/blender/geom):
 *   geom.bin   float32 triangle soup per part role: positions (studs-free LDU part space) then normals
 *   scene.json { parts: {part: [{role, off, n}]}, instances: [{part, m, mats}], materials, camera }
 *
 * The geometry is the very same the EyeSight .dae holds (buildPartGeometry, no bevel, creased
 * normals). Instance matrices `m` are row-major 4×4 into Blender's world: studs, +Z up
 * (app world (x, y, z) → Blender (x, −z, y)), i.e. C · S(1/20) · rotX(π) · piece.world.
 * Material colours are EyeSight's own linear RGB (EYESIGHT_COLORS by Studio material name).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as THREE from 'three';
import { PartLibrary } from '../../../src/ldraw/library';
import { buildPartGeometry, type PartGeometry } from '../../../src/ldraw/geometry';
import { parseLDConfig, materialName, type ColorDef } from '../../../src/ldraw/colors';
import { shadowLookupFrom } from '../../../src/ldraw/shadow';
import { EYESIGHT_COLORS } from '../../../src/data/eyesightColors.generated';

const ROOT = process.cwd();
const LDRAW = join(ROOT, 'public', 'ldraw');

const argv = process.argv.slice(2);
let outRoot = '/private/tmp/claude-501/blender/geom';
const dirs: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') outRoot = argv[++i];
  else dirs.push(argv[i]);
}
if (!dirs.length) { console.error('usage: export-scene.ts <scene dir>… [--out root]'); process.exit(1); }

const colors = parseLDConfig(readFileSync(join(LDRAW, 'LDConfig.ldr'), 'utf8'));
const shadowPath = join(ROOT, 'public', 'data', 'ldcad-shadow.json');
const shadow = existsSync(shadowPath) ? shadowLookupFrom(JSON.parse(readFileSync(shadowPath, 'utf8')).files) : undefined;
const lib = new PartLibrary(async (p) => { const f = join(LDRAW, p); return existsSync(f) ? readFileSync(f, 'utf8') : null; }, shadow);
const FALLBACK: ColorDef = { code: 71, name: 'Light_Bluish_Grey', hex: '#A0A5A9', edge: '#333333', alpha: 255, finish: 'solid' };

const geometryCache = new Map<string, PartGeometry | null>();
async function geometryOf(part: string): Promise<PartGeometry | null> {
  if (!geometryCache.has(part)) {
    const flat = await lib.loadPart(part);
    geometryCache.set(part, flat ? buildPartGeometry(flat) : null);
  }
  return geometryCache.get(part)!;
}

// EYESIGHT_COLORS holds the white 'RGB_White' node for TRANS-* materials; their tint is the 'RGB' node
const SETTINGS = '/Applications/Studio 2.0/PhotoRealisticRenderer/mac/settings_v1.xml';
const settingsXml = existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : '';
function transTint(name: string): [number, number, number] | null {
  const at = settingsXml.indexOf(`name="${name}"`);
  if (at < 0) return null;
  const end = settingsXml.indexOf('</material>', at);
  const m = /<color name="RGB" value="([^"]+)"/.exec(settingsXml.slice(at, end));
  return m ? (m[1].trim().split(/\s+/).map(Number) as [number, number, number]) : null;
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function materialOf(c: ColorDef) {
  const name = materialName(c);
  let rgb = EYESIGHT_COLORS[name] as readonly [number, number, number] | undefined;
  if (c.finish === 'trans') rgb = transTint(name) ?? rgb;
  if (!rgb) {
    const h = c.hex.replace('#', '');
    rgb = [0, 2, 4].map((i) => srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255)) as unknown as [number, number, number];
  }
  return { name, rgb: [...rgb], finish: c.finish, alpha: c.alpha };
}

/** Non-indexed float32 positions + normals of one BufferGeometry. */
function soup(geo: THREE.BufferGeometry): { p: Float32Array; n: Float32Array } {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const p = new Float32Array(pos.count * 3), n = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    p[i * 3] = pos.getX(i); p[i * 3 + 1] = pos.getY(i); p[i * 3 + 2] = pos.getZ(i);
    if (nrm) { n[i * 3] = nrm.getX(i); n[i * 3 + 1] = nrm.getY(i); n[i * 3 + 2] = nrm.getZ(i); }
  }
  // fill missing normals with the face normal
  for (let t = 0; t < pos.count; t += 3) {
    if (nrm && (n[t * 3] || n[t * 3 + 1] || n[t * 3 + 2])) continue;
    const a = new THREE.Vector3(p[t * 3], p[t * 3 + 1], p[t * 3 + 2]);
    const b = new THREE.Vector3(p[t * 3 + 3], p[t * 3 + 4], p[t * 3 + 5]);
    const c = new THREE.Vector3(p[t * 3 + 6], p[t * 3 + 7], p[t * 3 + 8]);
    const f = b.sub(a).cross(c.sub(a)).normalize();
    for (let k = 0; k < 3; k++) { n[(t + k) * 3] = f.x; n[(t + k) * 3 + 1] = f.y; n[(t + k) * 3 + 2] = f.z; }
  }
  return { p, n };
}

// world (studs, +Y up) → Blender (studs, +Z up)
const Y_TO_Z = new THREE.Matrix4().makeRotationX(Math.PI / 2);
const LDRAW_ROOT = new THREE.Matrix4().makeScale(1 / 20, 1 / 20, 1 / 20).multiply(new THREE.Matrix4().makeRotationX(Math.PI));
const toBlender = (v: number[]) => [v[0], -v[2], v[1]];

type SceneJson = {
  id: string; width: number; height: number;
  camera: { position: number[]; target: number[]; fov: number; near: number; far: number };
  pieces: { key: string; part: string; color: number; world: number[] }[];
};

async function exportScene(dir: string) {
  const scene = JSON.parse(readFileSync(join(dir, 'scene.json'), 'utf8')) as SceneJson;
  const id = scene.id ?? basename(dir).replace(/^scene_/, '');
  const out = join(outRoot, id);
  mkdirSync(out, { recursive: true });
  const binPath = join(out, 'geom.bin');
  const fd = openSync(binPath, 'w');
  let offset = 0; // in float32 units
  const parts: Record<string, { role: string; off: number; n: number; color: number | null }[]> = {};
  const materials: Record<string, ReturnType<typeof materialOf>> = {};
  const matFor = (code: number) => {
    const c = colors.get(code === 16 ? 71 : code) ?? FALLBACK;
    const m = materialOf(c);
    materials[m.name] = m;
    return m.name;
  };
  const instances: { part: string; m: number[]; mats: string[] }[] = [];
  let tris = 0;
  for (const piece of scene.pieces) {
    if (!(piece.part in parts)) {
      const geom = await geometryOf(piece.part);
      const roles: (typeof parts)[string] = [];
      if (geom) {
        const add = (role: string, color: number | null, g: THREE.BufferGeometry | null) => {
          if (!g || !g.getAttribute('position')?.count) return;
          const { p, n } = soup(g);
          writeSync(fd, Buffer.from(p.buffer)); writeSync(fd, Buffer.from(n.buffer));
          roles.push({ role, off: offset, n: p.length / 3, color });
          offset += p.length * 2;
        };
        add('main', null, geom.main);
        add('main_ds', null, geom.mainDoubleSided);
        geom.fixed.forEach((f, i) => add(`fixed_${i}`, f.color === 16 ? null : f.color, f.geometry));
      } else console.warn(`  missing part ${piece.part}`);
      parts[piece.part] = roles;
    }
    const roles = parts[piece.part];
    if (!roles.length) continue;
    const pieceMat = matFor(piece.color);
    const mats = roles.map((r) => (r.color === null ? pieceMat : matFor(r.color)));
    const m = Y_TO_Z.clone().multiply(LDRAW_ROOT).multiply(new THREE.Matrix4().fromArray(piece.world));
    const e = m.elements; // column-major → row-major
    instances.push({ part: piece.part, m: [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], e[3], e[7], e[11], e[15]], mats });
    tris += roles.reduce((s, r) => s + r.n / 3, 0);
  }
  closeSync(fd);
  const cam = scene.camera;
  writeFileSync(join(out, 'scene.json'), JSON.stringify({
    id, width: scene.width, height: scene.height,
    camera: { position: toBlender(cam.position), target: toBlender(cam.target), fov: cam.fov, near: cam.near, far: cam.far },
    parts, instances, materials,
  }));
  console.log(`✓ ${id}: ${instances.length} instances, ${Object.keys(parts).length} parts, ${(tris / 1e6).toFixed(2)} M tris → ${out}`);
}

async function main() {
  for (const d of dirs) await exportScene(resolve(d));
}
main().catch((e) => { console.error(e); process.exit(1); });
