/**
 * Builds training scenes for the learned shader (python/neuralshade): each scene packs a
 * grid of different models, each turned a random way, under one camera. One EyeSight render
 * of the scene is then the teacher image for all of them, which hides EyeSight's ~45 s start-up
 * cost behind 16 models at once. scene.json is also what the browser exporter draws G-buffers from.
 *
 *   npx tsx scripts/neural/gen-scenes.ts --count 12 --seed 1 [--out data/neuralshade]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { assemble, type Instance, type Metrics } from '../../src/model/assemble';
import { PartLibrary } from '../../src/ldraw/library';
import { buildPartGeometry, type PartGeometry } from '../../src/ldraw/geometry';
import { parseLDConfig } from '../../src/ldraw/colors';
import { shadowLookupFrom } from '../../src/ldraw/shadow';
import { measurePart } from '../../src/ldraw/metrics';
import { importLDraw } from '../../src/io/ldrawImport';
import { readProjectFile } from '../../src/io/projectFile';
import { buildCollada, type ColladaPiece } from '../../src/export/collada';
import type { Plan } from '../../src/plan/types';
import { LDRAW, ROOT } from '../lib/eyesight';

const argv = process.argv.slice(2);
const opt = (name: string, d: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : d; };
const COUNT = Number(opt('count', '12')), SEED = Number(opt('seed', '1')), OUT = join(ROOT, opt('out', 'data/neuralshade'));
const GRID = Number(opt('grid', '4')), CELL_STUDS = Number(opt('cell', '16')), W = Number(opt('width', '2560')), H = Number(opt('height', '1920'));
const LDU = 20;

// small deterministic RNG
let state = SEED * 2654435761 >>> 0;
const rnd = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];

const colors = parseLDConfig(readFileSync(join(LDRAW, 'LDConfig.ldr'), 'utf8'));
const shadowPath = join(ROOT, 'public', 'data', 'ldcad-shadow.json');
const shadow = existsSync(shadowPath) ? shadowLookupFrom(JSON.parse(readFileSync(shadowPath, 'utf8')).files) : undefined;
const lib = new PartLibrary(async (p) => { const f = join(LDRAW, p); return existsSync(f) ? readFileSync(f, 'utf8') : null; }, shadow);
const metricsCache = new Map<string, ReturnType<typeof measurePart>>();
const geometry = new Map<string, PartGeometry | null>();
const metrics = (part: string) => metricsCache.get(part) ?? measurePart(null, part);

async function ensure(parts: Iterable<string>) {
  for (const id of parts) {
    if (geometry.has(id)) continue;
    const flat = await lib.loadPart(id);
    if (!flat) { geometry.set(id, null); continue; }
    metricsCache.set(id, measurePart(flat, id));
    geometry.set(id, buildPartGeometry(flat));
  }
}
function partsOf(plan: Plan): Set<string> {
  const s = new Set<string>();
  const collect = (steps: { pieces: unknown[] }[]) => { for (const st of steps) for (const raw of st.pieces) { const p = raw as { part?: string }; if (p.part) s.add(p.part); } };
  collect(plan.steps);
  for (const sub of Object.values(plan.submodels ?? {})) collect(sub.steps);
  return s;
}

// --- the model pool --------------------------------------------------------------------------
type Source = { path: string; kind: string };
const sources: Source[] = [];
const bn = join(ROOT, 'public/data/bricknet');
for (const f of readdirSync(bn)) if (f.endsWith('.ldr')) sources.push({ path: join(bn, f), kind: 'bricknet' });
const omr = join(ROOT, 'public/data/omr');
for (const d of readdirSync(omr)) {
  const dir = join(omr, d);
  if (!statSync(dir).isDirectory()) continue;
  for (const f of readdirSync(dir)) if (/^[^_]+\.mpd$/i.test(f)) sources.push({ path: join(dir, f), kind: 'omr' });
}
// the character sets this app is for (Hellboy stays out: it is the held-out real-world test)
const dataRoot = '/Users/mac/Projects/BrickMotion-Data';
if (existsSync(dataRoot)) for (const d of readdirSync(dataRoot)) {
  const dir = join(dataRoot, d);
  if (!statSync(dir).isDirectory() || /hellboy/i.test(d)) continue;
  for (const f of readdirSync(dir)) if (f.endsWith('.brickmotion')) sources.push({ path: join(dir, f), kind: 'project' });
}
console.log(`… ${sources.length} candidate models (${sources.filter((x) => x.kind === 'project').length} character projects)`);

type Placed = { name: string; kind: string; instances: Instance[]; box: THREE.Box3 };
async function tryModel(src: Source): Promise<Placed | null> {
  let plan: Plan;
  try {
    if (src.kind === 'project') {
      const read = readProjectFile(readFileSync(src.path, 'utf8'));
      if (!read.ok) return null;
      plan = read.plan;
    } else plan = importLDraw(readFileSync(src.path, 'utf8'), src.path);
  } catch { return null; }
  const need = partsOf(plan);
  if (need.size === 0 || need.size > (src.kind === 'project' ? 120 : 60)) return null;
  await ensure(need);
  for (const id of need) if (!geometry.get(id)) return null;
  let asm;
  try { asm = assemble(plan, metrics as Metrics, colors); } catch { return null; }
  const instances = asm.instances.filter((i) => !i.placeholder && geometry.get(i.part));
  if (instances.length < 12 || instances.length > (src.kind === 'project' ? 900 : 400) || !asm.bounds) return null;
  const b = asm.bounds;
  const size = [(b.max[0] - b.min[0]) / LDU, (b.max[1] - b.min[1]) / LDU, (b.max[2] - b.min[2]) / LDU];
  const wide = src.kind === 'project' ? 0.75 : 0.62, tall = src.kind === 'project' ? 1.1 : 0.8;
  if (Math.max(size[0], size[2]) > CELL_STUDS * wide || size[1] > CELL_STUDS * tall || Math.max(...size) < 5) return null;
  return { name: src.path.split('/').pop()!, kind: src.kind, instances, box: new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)) };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const cellLdu = CELL_STUDS * LDU;
  for (let s = 0; s < COUNT; s++) {
    const id = String(SEED * 1000 + s).padStart(5, '0');
    const dir = join(OUT, `scene_${id}`);
    if (existsSync(join(dir, 'scene.json'))) { console.log(`skip ${id}`); continue; }
    mkdirSync(dir, { recursive: true });
    const pieces: { key: string; part: string; color: number; world: number[] }[] = [];
    const models: { name: string; kind: string; cell: number; yaw: number; parts: number }[] = [];
    // a different zoom per scene: a 2×2 grid fills the frame (large), a 5×5 grid is small
    const grid = pick([2, 3, 3, 4, 4, 5]);
    for (let cell = 0; cell < grid * grid; cell++) {
      let m: Placed | null = null;
      // half big sets, half BrickNet's small ones, so the net sees dense and sparse alike
      const r0 = rnd(), kind = r0 < 0.3 ? 'project' : r0 < 0.65 ? 'omr' : 'bricknet';
      const pool = sources.filter((x) => x.kind === kind);
      for (let tries = 0; tries < 400 && !m; tries++) m = await tryModel(pick(pool));
      if (!m) { console.warn(`  cell ${cell}: no model found`); continue; }
      const yaw = rnd() * Math.PI * 2;
      const gx = cell % grid, gz = Math.floor(cell / grid);
      const cx = (gx - (grid - 1) / 2) * cellLdu, cz = (gz - (grid - 1) / 2) * cellLdu;
      const c = m.box.getCenter(new THREE.Vector3());
      // centre on the cell, turn about the vertical, stand the lowest point on y = 0 (LDraw is Y-down)
      const place = new THREE.Matrix4().makeTranslation(cx, 0, cz)
        .multiply(new THREE.Matrix4().makeRotationY(yaw))
        .multiply(new THREE.Matrix4().makeTranslation(-c.x, -m.box.max.y, -c.z));
      for (const inst of m.instances) {
        const w = place.clone().multiply(inst.world);
        pieces.push({ key: `c${cell}_${inst.key}`, part: inst.part, color: inst.color, world: w.toArray() });
      }
      models.push({ name: m.name, kind: m.kind, cell, yaw, parts: m.instances.length });
    }
    // camera: orbit the grid centre, a random heading and elevation, wide enough for the whole grid
    const az = rnd() * Math.PI * 2, el = (8 + rnd() * 50) * Math.PI / 180, fov = 14 + rnd() * 18;
    const half = (grid * CELL_STUDS) / 2 * 0.78;
    const dist = (half / Math.tan((fov * Math.PI) / 360)) * 1.12;
    const target: [number, number, number] = [0, 2, 0];
    const position: [number, number, number] = [target[0] + dist * Math.cos(el) * Math.sin(az), target[1] + dist * Math.sin(el), target[2] + dist * Math.cos(el) * Math.cos(az)];
    const scene = { id, width: W, height: H, grid, camera: { position, target, fov, near: 1, far: 2000 }, models, pieces };
    writeFileSync(join(dir, 'scene.json'), JSON.stringify(scene));
    const colladaPieces: ColladaPiece[] = pieces.map((p) => ({ key: p.key, part: p.part, color: p.color, world: new THREE.Matrix4().fromArray(p.world) }));
    writeFileSync(join(dir, 'scene.dae'), buildCollada({
      name: `neural ${id}`, pieces: colladaPieces, geometryOf: (pid) => geometry.get(pid) ?? null, colors,
      camera: { position: new THREE.Vector3(...position), target: new THREE.Vector3(...target), fov, near: 1, far: 2000, width: W, height: H },
      matrixOrder: 'row',
    }));
    console.log(`✓ scene_${id}: grid ${grid}, ${models.length} models, ${pieces.length} pieces`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
