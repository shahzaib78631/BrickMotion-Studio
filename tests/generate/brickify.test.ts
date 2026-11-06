import { describe, expect, it } from 'vitest';
import { brickify, BRICKS, PLATES, type Built } from '../../src/generate/brickify';
import { Voxels, sphere } from '../../src/generate/voxels';
import { assemble } from '../../src/model/assemble';
import { validate } from '../../src/model/validate';
import type { Plan } from '../../src/plan/types';
import { getColors, metricsOf } from '../../src/state/partService';
import { appPartsReady as ready, useAppParts } from '../helpers/appParts';

const hiddenIn = (v: Voxels, x: number, y: number, z: number) =>
  [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].every(([a, b, c]) => v.get(x + a, y + b, z + c) >= 0);

/** Every shape cell is covered by exactly one piece, of its own colour wherever it shows, and nothing else is. */
function coversExactly(v: Voxels, b: Built): void {
  const seen = new Map<string, number>();
  for (const p of b.pieces) {
    for (let y = p.y; y < p.y + p.h; y++)
      for (let x = p.x; x < p.x + p.w; x++)
        for (let z = p.z; z < p.z + p.d; z++) {
          const k = `${x},${y},${z}`;
          expect(seen.has(k), `cell ${k} covered twice`).toBe(false);
          seen.set(k, p.color);
        }
  }
  let filled = 0;
  v.forEach((x, y, z, c) => {
    filled++;
    const got = seen.get(`${x},${y},${z}`);
    expect(got, `cell ${x},${y},${z}`).toBeDefined();
    if (!hiddenIn(v, x, y, z)) expect(got, `cell ${x},${y},${z}`).toBe(c);
  });
  expect(seen.size).toBe(filled);
}

const wall = () => Voxels.from(12, 1, 18, () => 4);

function head(): Voxels {
  // 6x6 studs, 6 bricks tall, eyes and a mouth in black on the front face (z = 0)
  return Voxels.from(6, 6, 18, (x, y, z) => {
    if (z === 0 && y >= 10 && y < 13 && (x === 1 || x === 4)) return 0;
    if (z === 0 && y >= 4 && y < 6 && x >= 1 && x <= 4) return 0;
    return 14;
  });
}

describe('brickify', () => {
  it('fills a sphere exactly, in one connected piece', () => {
    const v = sphere(10, 4);
    const b = brickify(v);
    coversExactly(v, b);
    expect(b.components).toBe(1);
  });

  it('lays a wall in running bond: no joint runs straight through two courses', () => {
    const v = wall();
    const b = brickify(v);
    coversExactly(v, b);
    expect(b.components).toBe(1);
    // vertical joints (x where a piece starts) of neighbouring brick courses never line up
    const joints = (y: number) => new Set(b.pieces.filter((p) => p.y === y && p.x > 0).map((p) => p.x));
    for (let y = 3; y < 18; y += 3) {
      const shared = [...joints(y)].filter((x) => joints(y - 3).has(x));
      expect(shared, `course at plate ${y}`).toEqual([]);
    }
  });

  it('keeps the face colours of a head and holds it together', () => {
    const v = head();
    const b = brickify(v);
    coversExactly(v, b);
    expect(b.components).toBe(1);
    expect(b.pieces.length).toBeLessThan(v.count() / 2);
  });

  it('says so when colours alone split a model it cannot join', () => {
    // one stud thick, every column its own colour: no piece may cross a visible colour edge
    const b = brickify(Voxels.from(4, 1, 6, (x) => (x % 2 ? 4 : 15)));
    expect(b.components).toBe(4);
  });

  it('bonds a striped block through its hidden core', () => {
    const v = Voxels.from(5, 5, 9, (x) => (x % 2 ? 4 : 15));
    const b = brickify(v);
    coversExactly(v, b);
    expect(b.components).toBe(1);
  });

  it('turns a cell list into plan items on the stud grid', () => {
    const b = brickify(Voxels.from(2, 4, 3, () => 1));
    expect(b.items).toEqual([{ part: '3001', color: 1, x: 0, y: 0, z: 0, rot: 90 }]);
  });
});

describe.skipIf(!ready)('brickify with real parts', () => {
  it('knows the true footprint and height of every part it uses', async () => {
    const all = [...BRICKS, ...PLATES];
    await useAppParts(all.map((s) => s.part));
    const wrong = all.filter((s) => {
      const m = metricsOf(s.part);
      return m.placeholder || m.footprint.w !== s.w || m.footprint.d !== s.d || m.heightPlates !== s.plates;
    }).map((s) => s.part);
    expect(wrong).toEqual([]);
  }, 60000);

  it.each([['sphere', () => sphere(10, 4)], ['wall', wall], ['head', head]] as const)('the editor finds nothing floating or overlapping in the %s', async (_, shape) => {
    const b = brickify(shape());
    await useAppParts([...new Set(b.items.map((i) => i.part))]);
    const plan: Plan = { format: 'brickmotion-plan', version: 1, name: 'gen', steps: [{ pieces: b.items.map((it, i) => ({ ...it, id: `p${i}` })) }] };
    const asm = assemble(plan, metricsOf, getColors());
    const problems = validate(asm, (p) => p, (p) => metricsOf(p).snaps).filter((w) => w.kind === 'floating' || w.kind === 'overlap');
    expect(problems.map((w) => w.message)).toEqual([]);
  });
});
