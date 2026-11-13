/**
 * Superman (40859-1, booklet 6668730) reconstructed by hand from the instruction booklet,
 * exactly the way 40859-batman-build.py was built for its figure. Parts, colours, counts and
 * the official step order come from the booklet extraction (steps.json); every position is
 * the author's hand placement.
 *
 * Run:   npx tsx 40859-superman-build.ts [out.mpd]
 * Pieces are placed on the stud grid (x/z studs, y plates) the way the editor does, then the
 * script reports the studio's own floating/connection result plus an AABB overlap scan.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportLDraw } from './src/io/ldrawExport';
import { parseLDConfig } from './src/ldraw/colors';
import { flattenPart } from './src/ldraw/flatten';
import { measurePart, type PartMetrics } from './src/ldraw/metrics';
import { parseLDraw, type LDrawFile, type Mat3 } from './src/ldraw/parse';
import { assemble, type Metrics } from './src/model/assemble';
import { validate } from './src/model/validate';
import { gridToPlacement } from './src/plan/placement';
import type { PieceItem, Plan, Rot, Step } from './src/plan/types';

type M3 = Mat3;

// ---- colours ------------------------------------------------------------------
const BLACK = 0, BLUE = 1, GREEN = 2, RED = 4, YELLOW = 14, PINK = 29;
const TRANSGREEN = 35, DBG = 72, NOUGAT = 78, AZURE = 322;

// ---- matrices for SNOT pieces (part space -> model space), as in the Batman build ----
const I: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const R180: M3 = [-1, 0, 0, 0, 1, 0, 0, 0, -1];
const RZ: M3 = [0, 0, 1, 0, 1, 0, -1, 0, 0];
const RZR: M3 = [0, 0, -1, 0, 1, 0, 1, 0, 0];
const FRONT: M3 = [1, 0, 0, 0, 0, 1, 0, -1, 0];
const LEFT: M3 = [0, 1, 0, 0, 0, 1, 1, 0, 0];
const LEFT_CLIPDOWN: M3 = [0, 1, 0, 0, 0, -1, -1, 0, 0];
const RIGHT: M3 = [0, -1, 0, 0, 0, -1, 1, 0, 0];
const RIGHT_CLIPDOWN: M3 = [0, -1, 0, 0, 0, -1, 1, 0, 0];

// ---- part metrics --------------------------------------------------------------
const LDRAW = join(process.cwd(), 'public', 'ldraw');
const files = new Map<string, LDrawFile | null>();
const lookup = (ref: string) => {
  const id = ref.replace(/\\/g, '/').toLowerCase();
  if (!files.has(id)) {
    const path = [join(LDRAW, 'parts', id), join(LDRAW, 'p', id)].find((p) => existsSync(p));
    files.set(id, path ? parseLDraw(readFileSync(path, 'utf8'), id) : null);
  }
  return files.get(id) ?? null;
};
const cache = new Map<string, PartMetrics>();
const metrics: Metrics = (part) => {
  let m = cache.get(part);
  if (!m) {
    const root = lookup(`${part}.dat`);
    m = measurePart(root ? flattenPart(part, root, lookup, () => {}) : null, part);
    cache.set(part, m);
  }
  return m;
};
const colors = parseLDConfig(readFileSync(join(LDRAW, 'LDConfig.ldr'), 'utf8'));

// ---- placement helpers ---------------------------------------------------------
/** a studs-up piece: x/z in studs, y in plates (bottom of the piece) */
const g = (part: string, color: number, x: number, y: number, z: number, rot: Rot = 0): PieceItem => {
  const p = gridToPlacement({ x, y, z, rot }, metrics(part).body);
  return { part, color, ldu: p.pos, matrix: p.m };
};
/** a SNOT piece at an exact pose in the Batman build's frame */
const r = (part: string, color: number, ldu: [number, number, number], m: M3): PieceItem => ({ part, color, ldu, matrix: m });

// LDraw frames of this model: +Z is the figure's front, -Z its back, +X its right.
// Stud columns x = 10,30,50,70; rows z = 10,30,50,70; y is down (up = -y).

const steps: Step[] = [
  // ===== hips / belt (booklet steps 1-4) =====
  { pieces: [g('3031', RED, 0, 0, 0), g('3710', RED, 0, 1, 0)] },
  { pieces: [g('3020', YELLOW, 0, 1, 1)] },
  { pieces: [g('1126', YELLOW, 1, 1, 3)] },
  { pieces: [g('3070b', YELLOW, 0, 1, 3), g('3070b', YELLOW, 3, 1, 3)] },

  // ===== torso (5-12) =====
  { pieces: [g('3941', TRANSGREEN, 1, 2, 1), g('4032a', DBG, 1, 5, 1)] },
  {
    pieces: [
      r('22885', DBG, [10, -56, 40], RZ), r('22885', DBG, [70, -56, 40], RZR), r('22885', DBG, [40, -56, 10], R180),
      g('28653', GREEN, 1, 6, 1),
    ],
  },
  { pieces: [r('32952', AZURE, [10, -56, 10], RZ), r('32952', AZURE, [70, -56, 10], RZR)] },
  {
    pieces: [
      r('3022', BLUE, [-8, -36, 40], LEFT), r('3069b', BLUE, [-16, -46, 40], LEFT), r('11476', NOUGAT, [-16, -26, 40], LEFT_CLIPDOWN),
      r('3022', BLUE, [88, -36, 40], RIGHT), r('3069b', BLUE, [96, -46, 40], RIGHT), r('11476', NOUGAT, [96, -26, 40], RIGHT_CLIPDOWN),
    ],
  },
  { pieces: [r('93274', BLUE, [40, -56, 70], I)] },
  { pieces: [r('3020', BLUE, [40, -34, 88], FRONT), r('87079', BLUE, [40, -14, 88], FRONT)] },
  { pieces: [g('3710', RED, 0, 7, 0)] },
  { pieces: [g('3623', RED, 0, 7, 1), g('3623', RED, 3, 7, 1, 90), g('3021', NOUGAT, 0, 7, 2)] },

  // ===== head core (13-16), same coordinates as the Batman build =====
  { pieces: [r('3003', GREEN, [40, -88, 40], I), r('3003', GREEN, [40, -112, 40], I)] },
  {
    pieces: [
      r('22885', DBG, [20, -104, 10], I), r('22885', DBG, [60, -104, 10], I),
      r('22885', DBG, [20, -104, 70], R180), r('22885', DBG, [60, -104, 70], R180),
      r('22885', DBG, [10, -104, 40], RZ), r('22885', DBG, [70, -104, 40], RZR),
    ],
  },
  { pieces: [r('4032a', DBG, [40, -120, 40], I), r('3003', PINK, [40, -144, 40], I)] },
  {
    pieces: [
      r('22885', DBG, [40, -144, 70], R180), r('22885', DBG, [40, -144, 10], I),
      r('22885', DBG, [10, -144, 20], RZ), r('22885', DBG, [10, -144, 60], RZ),
      r('22885', DBG, [70, -144, 20], RZR), r('22885', DBG, [70, -144, 60], RZR),
    ],
  },

  // ===== tan face on the head front (17-20) =====
  { pieces: [r('3020', NOUGAT, [20, -104, 88], FRONT), r('3020', NOUGAT, [60, -104, 88], FRONT)] },
  { pieces: [r('3069b', NOUGAT, [10, -94, 96], FRONT), r('3024', NOUGAT, [10, -114, 96], FRONT), r('3070b', NOUGAT, [70, -114, 96], FRONT)] },
  { pieces: [r('2431', NOUGAT, [40, -74, 96], FRONT), r('2431', NOUGAT, [40, -134, 96], FRONT), r('41740', NOUGAT, [40, -114, 96], FRONT)] },
  { pieces: [r('98138pz0', BLACK, [30, -104, 104], FRONT), r('98138pz0', BLACK, [50, -104, 104], FRONT)] },

  // ===== head sides (21-26) =====
  { pieces: [r('2420', BLACK, [-8, -124, 20], LEFT), r('27263', BLACK, [-8, -104, 40], LEFT), r('33909', BLACK, [-8, -84, 20], LEFT)] },
  { pieces: [r('3069b', BLACK, [-8, -74, 40], LEFT), r('28653', NOUGAT, [-8, -94, 20], LEFT), r('3070b', NOUGAT, [-8, -94, 10], LEFT), r('5091', NOUGAT, [-8, -114, 10], LEFT)] },
  { pieces: [r('85984', NOUGAT, [-8, -64, 40], LEFT)] },
  { pieces: [r('2420', BLACK, [88, -124, 20], RIGHT), r('27263', BLACK, [88, -104, 40], RIGHT), r('33909', BLACK, [88, -84, 20], RIGHT)] },
  { pieces: [r('3069b', BLACK, [88, -74, 40], RIGHT), r('28653', NOUGAT, [88, -94, 20], RIGHT), r('3070b', NOUGAT, [88, -94, 10], RIGHT), r('5092', NOUGAT, [88, -114, 10], RIGHT)] },
  { pieces: [r('85984', NOUGAT, [88, -64, 40], RIGHT)] },

  // ===== black hair (27-34) =====
  { pieces: [r('3020', BLACK, [40, -152, 10], I)] },
  { pieces: [r('7827', BLACK, [10, -152, 10], I), r('3024', BLACK, [30, -152, 10], I)] },
  { pieces: [r('2420', BLACK, [10, -152, 70], R180), r('28653', BLACK, [30, -152, 70], R180)] },
  { pieces: [r('11477', BLACK, [10, -144, 30], I), r('11477', BLACK, [30, -144, 30], I), r('25269', BLACK, [50, -152, 30], I), r('25269', BLACK, [70, -152, 30], I)] },
  { pieces: [r('3024', BLACK, [10, -144, 40], I), r('15397', BLACK, [40, -144, 40], I), r('25269', BLACK, [50, -152, 40], I), r('29120', BLACK, [70, -152, 40], I)] },
  { pieces: [r('11477', BLACK, [10, -144, 60], I), r('25269', BLACK, [30, -152, 60], I), r('25269', BLACK, [50, -152, 60], I)] },
  { pieces: [r('25269', BLACK, [10, -152, 70], R180), r('29119', BLACK, [30, -152, 70], R180)] },
  { pieces: [r('3031', BLACK, [40, -160, 40], I), r('87079', BLACK, [40, -168, 20], I), r('87079', BLACK, [40, -168, 50], I)] },

  { pieces: [] }, // 35: attach/turn step (no new parts)

  // ===== red skirt / lower body (36-44) =====
  { pieces: [g('3022', RED, 0, -1, 0), g('28653', BLUE, 2, -1, 0, 90), g('28653', BLUE, 2, -1, 2, 90)] },
  { pieces: [g('28653', RED, 0, -2, 0, 90), g('28653', RED, 1, -2, 0, 90), g('28653', RED, 0, -2, 2, 90), g('28653', RED, 1, -2, 2, 90), g('28653', BLUE, 2, -2, 0, 90), g('28653', BLUE, 2, -2, 2, 90)] },
  { pieces: [g('3020', RED, 0, -3, 0), g('7302', RED, 0, -3, 2, 90)] },
  { pieces: [g('7302', RED, 0, -4, 0, 90), g('7302', RED, 0, -4, 1, 90), g('7302', RED, 0, -4, 2, 90)] },
  { pieces: [g('25269', RED, 0, -4, 3), g('25269', RED, 1, -4, 3)] },
  { pieces: [g('54200', RED, 2, -4, 3), g('54200', RED, 3, -4, 3)] },
  { pieces: [] },
  { pieces: [g('32028', RED, 2, -5, 2, 90), g('25269', RED, 2, -4, 1), g('7302', RED, 1, -5, 3, 90)] },
  { pieces: [g('32028', RED, 2, -5, 3, 270), g('25269', RED, 2, -4, 2), g('7302', RED, 1, -5, 2, 90)] },

  // ===== 45: stand (6x6 plate with tiles on top; the figure rests on it) =====
  { pieces: [r('3958', BLACK, [40, 56, 40], I), r('87079', BLACK, [40, 48, 20], I), r('41740', BLACK, [40, 48, 50], I), r('2431', BLACK, [40, 48, 70], I)] },
];

// ---- build, check, export ------------------------------------------------------
const plan: Plan = { format: 'brickmotion-plan', version: 1, name: '40859-superman', steps };
const asm = assemble(plan, metrics, colors);

for (const w of validate(asm)) console.log(`! ${w.kind}: ${w.message}${w.detail ? ` (${w.detail})` : ''}`);

let overlaps = 0;
const inst = asm.instances;
for (let i = 0; i < inst.length; i++) for (let j = i + 1; j < inst.length; j++) {
  const a = inst[i].worldBox, b = inst[j].worldBox;
  const o = [0, 1, 2].map((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]));
  if (o.every((v) => v > 2)) {
    overlaps++;
    console.log(`~ overlap ${inst[i].part} / ${inst[j].part}  ${o.map(Math.round).join('x')} LDU`);
  }
}
console.log(`${plan.steps.length} steps, ${inst.length} pieces, ${overlaps} AABB overlaps`);

const out = process.argv[2] ?? '40859-superman.mpd';
writeFileSync(out, exportLDraw(plan, metrics, colors));
console.log(`wrote ${out}`);
