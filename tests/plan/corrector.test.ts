import { describe, expect, test } from 'vitest';
import { ensureIds } from '../../src/plan/ids';
import { modelSteps } from '../../src/plan/ops';
import { correctorMark, groupsFromCorrectedMpd, summariseDiagnosis, withCorrectorSteps, withoutCorrectorSteps } from '../../src/plan/corrector';
import type { Plan } from '../../src/plan/types';

const place = (color: number, x: number, y: number, part: string) => `1 ${color} ${x} ${y} 0 1 0 0 0 1 0 0 0 1 ${part}`;

const sent = [
  '0 FILE t.ldr',
  '0 test',
  '0 Name: t.ldr',
  place(4, 0, 0, '3001.dat'),
  place(4, 40, 0, '3001.dat'),
  '0 STEP',
  place(1, 0, 24, '3020.dat'),
  place(4, 0, 0, '3001.dat'), // same line as the first piece: matched in order
  '0 NOFILE',
  '0 FILE sub.ldr',
  place(4, 0, 0, '3001.dat'), // a submodel block: never part of the target model
  '0 NOFILE',
].join('\n');

describe('mapping the corrected document back onto our items', () => {
  test('follows the engine step boundaries and keeps duplicate lines in order', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const corrected = [
      '0 FILE t.ldr',
      place(1, 0, 24, '3020.dat'), // the support first
      place(4, 0, 0, '3001.dat'), // the first of the two identical lines
      '0 STEP',
      place(4, 40, 0, '3001.dat'),
      place(4, 0, 0, '3001.dat'), // the second one
      '0 NOFILE',
    ].join('\n');
    const { groups, unmatched } = groupsFromCorrectedMpd(corrected, sent, ids);
    expect(groups).toEqual([['c', 'a'], ['b', 'd']]);
    expect(unmatched).toBe(0);
  });

  test('falls back to the part name when a line was rewritten, and reports what it cannot place', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const corrected = [
      '0 FILE t.ldr',
      `${place(4, 0, 0, '3001.dat')} `, // trailing space: not the same string any more
      '1 99 0 24 0 1 0 0 0 1 0 0 0 1 9999.dat', // a placement we never sent
      '0 NOFILE',
    ].join('\n');
    const { groups, unmatched } = groupsFromCorrectedMpd(corrected, sent, ids);
    expect(groups).toEqual([['a']]);
    expect(unmatched).toBe(1);
  });

  test('refuses to map when the engine did not see the same number of placements', () => {
    const { groups, unmatched } = groupsFromCorrectedMpd('0 FILE t.ldr\n0 NOFILE', sent, ['a', 'b']);
    expect(groups).toEqual([]);
    expect(unmatched).toBe(2);
  });
});

const plan = (): Plan =>
  ensureIds({
    format: 'brickmotion-plan',
    version: 1,
    name: 't',
    submodels: { wing: { steps: [{ pieces: [{ part: '3001', color: 1, x: 0, y: 0, z: 0, rot: 0 }] }] } },
    steps: [
      { pieces: [{ part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 }, { part: '3001', color: 4, x: 4, y: 0, z: 0, rot: 0 }], title: 'Base', pauseAfter: 1.5 },
      { pieces: [{ part: '3020', color: 1, x: 0, y: 1, z: 0, rot: 0 }] },
      { pieces: [{ part: '3003', color: 14, x: 0, y: 2, z: 0, rot: 0 }] },
    ],
  });

const idsOf = (p: Plan, model = '') => modelSteps(p, model).map((step) => step.pieces.map((piece) => piece.id));

describe('applying the corrected grouping', () => {
  test('regroups the model in the engine order and keeps the step fields it can', () => {
    const before = plan();
    const [a, b, c, d] = modelSteps(before, '').flatMap((step) => step.pieces.map((piece) => piece.id!));
    const after = withCorrectorSteps(before, '', [[c, a], [b, d]]);
    expect(idsOf(after)).toEqual([[c, a], [b, d]]);
    expect(modelSteps(after, '')[0].title).toBe('Base');
    expect(modelSteps(after, '')[0].pauseAfter).toBe(1.5);
    // the pieces themselves are the same objects: nothing was rebuilt or dropped
    expect(modelSteps(after, '').flatMap((step) => step.pieces)).toHaveLength(4);
  });

  test('never drops a piece the grouping forgot: it stays on the last step', () => {
    const before = plan();
    const all = modelSteps(before, '').flatMap((step) => step.pieces.map((piece) => piece.id!));
    const after = withCorrectorSteps(before, '', [[all[3]]]);
    // the corrected piece leads the step the engine made; everything it did not place
    // is kept after it rather than dropped
    expect(idsOf(after)[0][0]).toBe(all[3]);
    expect(idsOf(after).flat().sort()).toEqual([...all].sort());
  });

  test('rewrites a submodel when that is the model being corrected, and leaves the rest alone', () => {
    const before = plan();
    const wingId = modelSteps(before, 'wing')[0].pieces[0].id!;
    const main = modelSteps(before, '');
    const after = withCorrectorSteps(before, 'wing', [[wingId]]);
    expect(idsOf(after, 'wing')).toEqual([[wingId]]);
    expect(idsOf(after, '').flat()).toHaveLength(4);
    expect(idsOf(after)).toEqual(main.map((step) => step.pieces.map((piece) => piece.id)));
  });

  test('disabling puts the remembered order back', () => {
    const before = plan();
    const mark = correctorMark(before, '', { units: 4, steps: 2, floating: 0, unsupported: 0, missingGeometry: 0, dropped: 0, snapLinks: 0, fallbackLinks: 0, issues: [] });
    const [a, b, c, d] = modelSteps(before, '').flatMap((step) => step.pieces.map((piece) => piece.id!));
    const corrected = withCorrectorSteps(before, '', [[d, c], [b, a]]);
    const restored = withoutCorrectorSteps(corrected, '', mark)!;
    expect(idsOf(restored)).toEqual(idsOf(before));
    expect(modelSteps(restored, '')[0].title).toBe('Base');
    expect(mark.steps).toBe(3);
    expect(mark.units).toBe(4);
  });
});

test('summariseDiagnosis flattens the engine report', () => {
  const summary = summariseDiagnosis([
    {
      units: 151, steps: 47, floating: [1, 2], unsupported: 1, missing_geometry: 0, dropped: 2,
      snap_links: 88, fallback_links: 4,
      issues: [{ code: 'floating_unit', message: 'unit 12 is not supported' }, { code: 'missing_part' }],
    },
  ]);
  expect(summary).toMatchObject({ units: 151, steps: 47, floating: 2, unsupported: 1, dropped: 2, snapLinks: 88, fallbackLinks: 4 });
  expect(summary!.issues).toEqual(['floating_unit: unit 12 is not supported', 'missing_part']);
  expect(summariseDiagnosis(null)).toBeNull();
});
