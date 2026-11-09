import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gridToVoxels } from '../../src/ai/promptToModel';
import { conditionalLogits, decodeCodes, sampleCodes, ShapeWeights } from '../../src/ai/shapeModel';

// The detailed (v2) model: 32×32×64 plates with colour. Written by python/shape/shape2.py export.
const DIR = process.env.SHAPE_MODEL_DIR ?? 'public/data/ai';
const BIN = `${DIR}/shape2.bin`;
const REF = `${DIR}/shape2.reference.json`;
const trained = existsSync(BIN) && existsSync(REF);

describe('detailed shape model, against PyTorch', () => {
  it.skipIf(!trained)('decodes codes to the same coloured grid and predicts the same next codes', async () => {
    const buf = readFileSync(BIN);
    const m = ShapeWeights.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const ref = JSON.parse(readFileSync(REF, 'utf8')) as { clip: number[]; codes: number[]; logits: number[][]; classes: number[] };
    expect(m.config.version).toBe(2);
    expect(m.grid.A * m.grid.B * m.grid.C).toBe(ref.classes.length);

    const grid = decodeCodes(m, Int32Array.from(ref.codes));
    let same = 0, filled = 0, sameFilled = 0;
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] === ref.classes[i]) same++;
      if (ref.classes[i]) { filled++; if (grid[i] === ref.classes[i]) sameFilled++; }
    }
    expect(same / grid.length).toBeGreaterThan(0.999);
    expect(sameFilled / Math.max(1, filled)).toBeGreaterThan(0.99);

    const logits = conditionalLogits(m, Float32Array.from(ref.clip), ref.codes.slice(0, 3));
    for (let p = 0; p < 4; p++) {
      let worst = 0;
      for (let k = 0; k < ref.logits[p].length; k++) worst = Math.max(worst, Math.abs(logits[p][k] - ref.logits[p][k]));
      expect(worst).toBeLessThan(2e-2);
    }

    const codes = await sampleCodes(m, Float32Array.from(ref.clip), { random: () => 0.5 });
    expect(codes.length).toBe(m.grid.seq);
    const v = gridToVoxels(decodeCodes(m, codes), m.grid, 1, (c) => m.config.colours?.[c - 1] ?? 71);
    expect(v.count()).toBeGreaterThan(0);
  }, 300_000);
});
