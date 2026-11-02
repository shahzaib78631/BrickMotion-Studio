import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isBrickHeadzRecord,
  parseBrickHeadzGrammar,
  parseBrickHeadzRecord,
} from '../../src/anim/brickheadz/artifact';

const DIMS = { wStuds: 4, dStuds: 4, hPlates: 3 };
const V3 = [0, 0, 0];

const RECORD = {
  schema: 'brickheadz.record.v1',
  version: 1,
  units: 'ldu',
  id: '41585',
  name: 'Batman',
  source: { file: 'x.mpd', sha256: 'abc' },
  frame: { up: [0, 1, 0], front: [0, 0, -1], ground: 0 },
  bbox: { ldu: [V3, [80, 240, 80]], dims: { wStuds: 4, dStuds: 4, hPlates: 30 } },
  figures: [{ index: 0, pieces: 1, bbox: { ldu: [V3, V3] }, roles: { head: 1 }, face: {}, headCube: DIMS }],
  pieces: [
    {
      key: 'm/0',
      part: '22885.dat',
      basePart: '22885',
      color: 71,
      decorated: false,
      submodel: 'm.ldr',
      figure: 0,
      component: 'head',
      snot: true,
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      aabb: [V3, [20, 24, 20]],
    },
  ],
  components: [{ figure: 0, label: 'head', pieces: 1, bbox: { ldu: [V3, V3] }, dims: DIMS }],
  connections: [{ a: 'm/0', b: 'm/1', kind: 'interlock', confidence: 'interlock', axis: [0, 1, 0] }],
  face: { side: '-z', tiles: 2 },
  dna: { construction: { pieces: 1 } },
  warnings: [],
};

const GRAMMAR = {
  schema: 'brickheadz.grammar.v1',
  version: 1,
  source: 'corpus',
  models: 78,
  coverage: { headDetected: 78, headRate: 1, faceDetected: 77, faceRate: 0.987, warningCount: 4 },
  template: { head: { n: 78, median: [6, 5, 18] } },
  roles: { head: [['22885', 944], ['3023', 511]] },
  connections: { kinds: [['interlock', 100]], pairs: [['head | torso', 5]] },
  colors: [[0, 2331], [71, 1799]],
  face: { meanTiles: 11.2, frontSides: [['-z', 38]] },
  warnings: [],
};

describe('brickheadz artifact contract', () => {
  it('parses a record and is recognisable by schema string', () => {
    const r = parseBrickHeadzRecord(RECORD);
    expect(r.ok).toBe(true);
    expect(isBrickHeadzRecord(RECORD)).toBe(true);
    expect(isBrickHeadzRecord({ schema: 'other' })).toBe(false);
  });

  it('rejects a record with a bad matrix/units', () => {
    const bad = { ...RECORD, units: 'meters' };
    expect(parseBrickHeadzRecord(bad).ok).toBe(false);
  });

  it('parses the grammar', () => {
    expect(parseBrickHeadzGrammar(GRAMMAR).ok).toBe(true);
  });

  it('parses the real generated artifacts when present', () => {
    const records = resolve(__dirname, '../../../.cache/brickheadz/records.jsonl');
    const grammar = resolve(__dirname, '../../../.cache/brickheadz/grammar.json');
    if (!existsSync(records) || !existsSync(grammar)) return; // corpus not built
    const first = JSON.parse(readFileSync(records, 'utf8').split('\n')[0]);
    const record = parseBrickHeadzRecord(first);
    expect(record.ok, record.ok ? '' : JSON.stringify((record as { errors: string[] }).errors)).toBe(true);
    const g = parseBrickHeadzGrammar(JSON.parse(readFileSync(grammar, 'utf8')));
    expect(g.ok, g.ok ? '' : JSON.stringify((g as { errors: string[] }).errors)).toBe(true);
  });
});
