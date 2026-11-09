import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { colourFor, gridToVoxels, shapeToPlan } from '../../src/ai/promptToModel';
import { conditionalLogits, decodeCodes, sampleCodes, ShapeWeights } from '../../src/ai/shapeModel';

const DIR = process.env.SHAPE_MODEL_DIR ?? 'public/data/ai';
const BIN = `${DIR}/shape.bin`;
const REF = `${DIR}/shape.reference.json`;
const trained = existsSync(BIN) && existsSync(REF);

describe('shape model, against PyTorch', () => {
  it.skipIf(!trained)('decodes codes to the same grid and predicts the same next codes', async () => {
    const buf = readFileSync(BIN);
    const m = ShapeWeights.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const ref = JSON.parse(readFileSync(REF, 'utf8')) as { clip: number[]; codes: number[]; logits: number[][]; occ: string };

    const occ = decodeCodes(m, Int32Array.from(ref.codes));
    let same = 0;
    for (let i = 0; i < occ.length; i++) if (String(occ[i]) === ref.occ[i]) same++;
    expect(same / occ.length).toBeGreaterThan(0.999);

    const logits = conditionalLogits(m, Float32Array.from(ref.clip), ref.codes.slice(0, 3));
    for (let p = 0; p < 4; p++) {
      let worst = 0;
      for (let k = 0; k < ref.logits[p].length; k++) worst = Math.max(worst, Math.abs(logits[p][k] - ref.logits[p][k]));
      expect(worst).toBeLessThan(1e-2);
    }

    let i = 0;
    const codes = await sampleCodes(m, Float32Array.from(ref.clip), { random: () => 0.5, progress: () => { i++; } });
    expect(i).toBe(125);
    expect(Math.max(...codes)).toBeLessThan(m.config.K);
  }, 120_000);
});

describe('prompt → model plumbing', () => {
  it('reads a colour from the prompt, or picks one by seed', () => {
    expect(colourFor('a red chair', 1)).toBe(4);
    expect(colourFor('Dark blue car', 1)).toBe(272);
    expect(colourFor('a wooden table', 1)).toBe(70);
    expect(colourFor('a chair', 0)).toBe(colourFor('a chair', 0));
  });

  it('keeps the largest piece, crops it, and stacks 3 plates per brick', () => {
    const G = 20;
    const occ = new Uint8Array(G * G * G);
    const set = (x: number, y: number, z: number) => { occ[(x * G + y) * G + z] = 1; };
    for (let x = 4; x < 8; x++) for (let y = 2; y < 4; y++) for (let z = 0; z < 2; z++) set(x, y, z); // 4×2×2 block
    set(15, 15, 5); // a stray cell
    const v = gridToVoxels(occ, { A: G, B: G, C: G }, 3, () => 4);
    expect([v.w, v.d, v.h]).toEqual([4, 2, 6]);
    expect(v.count()).toBe(4 * 2 * 6);
  });

  it('lays a shape in bricks that hold together', () => {
    const G = 20;
    const occ = new Uint8Array(G * G * G);
    for (let x = 0; x < 6; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) occ[(x * G + y) * G + z] = 1;
    const { built, plan } = shapeToPlan('a red box', 3, gridToVoxels(occ, { A: G, B: G, C: G }, 3, () => 4));
    expect(built.components).toBe(1);
    expect(plan.steps.length).toBeGreaterThan(1);
    expect(plan.name).toBe('A red box #3');
  });
});
