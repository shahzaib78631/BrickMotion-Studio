import { describe, expect, it } from 'vitest';
import { namedColour, withoutColours } from '../../src/ai/promptToModel';
import { parseRemixIndex, recolour, rootAt, search, type RemixSample } from '../../src/ai/remix';
import type { Plan } from '../../src/plan/types';

const sample = (name: string): RemixSample => ({ set: '1', name, theme: 'Town', file: 'x.mpd', sub: '', pieces: 1, size: [1, 1, 1], author: '' });

/** An index in the file layout: text captions own samples, images are per sample and view. */
function indexBuffer(text: number[][], owner: number[], image: number[][][]): ArrayBuffer {
  const n = image.length, views = image[0].length, nText = text.length;
  const buf = new ArrayBuffer(16 + nText * 8 + n * views * 4 + nText * 512 + n * views * 512);
  new Uint32Array(buf, 0, 4).set([n, nText, views, 512]);
  let o = 16;
  new Int32Array(buf, o, nText).set(owner); o += nText * 4;
  new Float32Array(buf, o, nText).fill(1 / 127); o += nText * 4;
  new Float32Array(buf, o, n * views).fill(1 / 127); o += n * views * 4;
  const t = new Int8Array(buf, o, nText * 512); o += nText * 512;
  text.forEach((v, c) => v.forEach((x, k) => (t[c * 512 + k] = x)));
  const im = new Int8Array(buf, o, n * views * 512);
  image.forEach((vs, i) => vs.forEach((v, j) => v.forEach((x, k) => (im[(i * views + j) * 512 + k] = x))));
  return buf;
}

const unit = (k: number) => { const e = new Float32Array(512); e[k] = 1; return e; };

describe('remix index', () => {
  const samples = [sample('car'), sample('ship'), sample('tower')];
  // sample 0 has two captions; each sample points along its own axis
  const buf = indexBuffer([[127], [0, 0, 0, 127], [0, 127], [0, 0, 127]], [0, 0, 1, 2], [[[127]], [[0, 127]], [[0, 0, 127]]]);

  it('reads the layout back', () => {
    const ix = parseRemixIndex(samples, buf);
    expect(ix.views).toBe(1);
    expect([...ix.textOwner]).toEqual([0, 0, 1, 2]);
    expect(ix.text[3 * 512 + 2]).toBe(127);
    expect(ix.image[2 * 512 + 2]).toBe(127);
  });

  it('rejects an index that does not match its samples', () => {
    expect(() => parseRemixIndex(samples.slice(0, 2), buf)).toThrow();
  });

  it('finds the closest sample, by any of its captions', () => {
    const ix = parseRemixIndex(samples, buf);
    expect(search(ix, unit(1), 1)[0].sample.name).toBe('ship');
    expect(search(ix, unit(3), 1)[0].sample.name).toBe('car'); // its second caption
    expect(search(ix, unit(2), 3).map((r) => r.sample.name)[0]).toBe('tower');
  });

  it('searches an index without renders next to one with them', () => {
    const omr = parseRemixIndex(samples, buf);
    // two BrickNet-style samples: one caption each, no views
    const bn = [{ ...sample('robot'), source: 'bricknet' as const }, { ...sample('boat'), source: 'bricknet' as const }];
    const n = 2;
    const b2 = new ArrayBuffer(16 + n * 8 + n * 512);
    new Uint32Array(b2, 0, 4).set([n, n, 0, 512]);
    new Int32Array(b2, 16, n).set([0, 1]);
    new Float32Array(b2, 16 + n * 4, n).fill(1 / 127);
    const t = new Int8Array(b2, 16 + n * 8, n * 512);
    t[5] = 127; t[512 + 1] = 100; // robot along axis 5; boat close to the ship's axis 1
    const both = [omr, parseRemixIndex(bn, b2)];
    expect(search(both, unit(5), 1)[0].sample.name).toBe('robot');
    expect(search(both, unit(1), 2).map((r) => r.sample.name)).toEqual(['ship', 'boat']);
  });
});

const brick = (id: string, color: number) => ({ id, part: '3001.dat', color, x: 0, y: 0, z: 0 });

function plan(): Plan {
  return {
    format: 'brickmotion-plan', version: 1, name: 'm',
    steps: [{ pieces: [{ id: 's1', submodel: 'Car.ldr' }] }],
    submodels: {
      'Car.ldr': { steps: [{ pieces: [brick('a', 4), brick('b', 4), brick('c', 0), { id: 's2', submodel: 'wheel.ldr' }] }] },
      'wheel.ldr': { steps: [{ pieces: [brick('d', 4)] }] },
      'Unused.ldr': { steps: [{ pieces: [brick('e', 1)] }] },
    },
  } as unknown as Plan;
}

describe('rootAt', () => {
  it('puts the submodel at the top and keeps only what it uses', () => {
    const p = rootAt(plan(), 'car.ldr');
    expect(p.steps[0].pieces.map((i) => i.id)).toEqual(['a', 'b', 'c', 's2']);
    expect(Object.keys(p.submodels ?? {})).toEqual(['wheel.ldr']);
  });

  it('leaves the plan alone for the whole model, and fails for a missing submodel', () => {
    const p = plan();
    expect(rootAt(p, '')).toBe(p);
    expect(() => rootAt(p, 'nope')).toThrow();
  });
});

describe('recolour', () => {
  const colours = (p: Plan) => [p.steps, ...Object.values(p.submodels ?? {}).map((m) => m.steps)]
    .flatMap((s) => s.flatMap((x) => x.pieces)).filter((i) => 'part' in i).map((i) => Number((i as { color: number }).color));

  it('swaps the body colour everywhere and keeps the trim', () => {
    const p = rootAt(plan(), 'Car.ldr');
    expect(recolour(p, 1)).toBe(4);
    expect(colours(p).sort()).toEqual([0, 1, 1, 1]);
  });

  it('does nothing when the body already has that colour', () => {
    expect(recolour(rootAt(plan(), 'Car.ldr'), 4)).toBeNull();
  });
});

describe('colour words', () => {
  it('names the colour and strips it from the search', () => {
    expect(namedColour('a dark red fire truck')).toBe(320);
    expect(withoutColours('a Red police car')).toBe('a police car');
    expect(withoutColours('dark blue spaceship')).toBe('spaceship');
    expect(withoutColours('castle tower')).toBe('castle tower');
  });
});
