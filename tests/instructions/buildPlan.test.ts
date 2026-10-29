import { beforeAll, expect, test } from 'vitest';
import { exportLDraw } from '../../src/io/ldrawExport';
import { importLDraw } from '../../src/io/ldrawImport';
import type { Metrics } from '../../src/model/assemble';
import { planFromBooklets } from '../../src/instructions/buildPlan';
import { instructionsReport } from '../../src/instructions/report';
import type { Resolved } from '../../src/instructions/rebrickable';
import type { Booklet, Matches } from '../../src/instructions/types';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let metrics: Metrics;
beforeAll(async () => {
  metrics = await fixtureMetrics();
});

const part = (count: number) => ({ crop: 'c.png', count, countFound: true, box: [0, 0, 1, 1] as [number, number, number, number] });
const booklet: Booklet = {
  id: '6668730', textHash: 'h', pages: 40, inventory: [],
  steps: [
    { page: 4, number: 1, section: 1, picture: null, callout: [part(2)], substeps: [] },
    { page: 5, number: 2, picture: null, callout: [part(1)], substeps: [] },
    { page: 5, number: 3, picture: null, callout: [part(1), part(1)], substeps: [1, 2], repeat: 2 },
  ],
};
const matches: Matches = {
  matches: [
    { booklet: '6668730', step: 1, index: 0, element: '300121', score: 0.98, alternatives: [] },
    { booklet: '6668730', step: 2, index: 0, element: null, score: 0.4, alternatives: [{ element: '302328', score: 0.4 }] },
    { booklet: '6668730', step: 3, index: 0, element: '302328', score: 0.95, alternatives: [] },
    { booklet: '6668730', step: 3, index: 1, element: 'nocolour', score: 0.9, alternatives: [] },
  ],
  overUse: [{ element: '302328', used: 3, inventory: 2 }],
  unused: [{ element: '4243814', left: 1 }],
};
const resolve = (element: string): Resolved =>
  element === '300121' ? { part: '3001', color: 4, flags: [] }
    : element === '302328' ? { part: '3020', color: 2, flags: [] }
      : element === 'nocolour' ? { part: '3020', color: null, flags: ['colour Mystery has no LDraw id'] }
        : { part: '', color: null, flags: [`element ${element} not in Rebrickable inventory for 40859-1`] };

const one = () => planFromBooklets('superman', [[booklet]], matches, resolve);

test('steps follow booklet order and titles', () => {
  const { plan } = one();
  expect(plan.name).toBe('superman');
  expect(plan.steps).toHaveLength(3);
  expect(plan.steps[0].title).toBe('Section 1');
  expect(plan.steps[1].title).toBeUndefined();
  expect(plan.steps[0].notes).toBe('booklet 6668730 page 4');
});

test('count expands to pieces at the step row', () => {
  const pieces = one().plan.steps[0].pieces;
  expect(pieces).toEqual([
    { part: '3001', color: 4, x: 0, y: 0, z: -8, rot: 0 },
    { part: '3001', color: 4, x: 8, y: 0, z: -8, rot: 0 },
  ]);
  expect(one().plan.steps[2].pieces.map((p) => 'z' in p && p.z)).toEqual([-16, -16]);
});

test('unmatched part becomes flagged placeholder', () => {
  const { plan, flags } = one();
  expect(plan.steps[1].pieces[0]).toMatchObject({ part: '3001', color: 16 });
  expect(flags).toContainEqual({ step: 2, message: 'step 2: callout part 1 not identified (closest 302328 at 0.4); placeholder 3001' });
});

test('known part without an LDraw colour keeps its shape in the default colour, flagged', () => {
  const { plan, flags } = one();
  expect(plan.steps[2].pieces[1]).toMatchObject({ part: '3020', color: 16 });
  expect(flags).toContainEqual({ step: 3, message: 'step 3: colour Mystery has no LDraw id' });
});

test('sub-builds are kept inline and flagged', () => {
  expect(one().flags).toContainEqual({ step: 3, message: 'step 3 has a sub-build (sub-steps 1, 2, built 2×) kept inline' });
});

test('two figures become submodels placed side by side', () => {
  const b2: Booklet = { ...booklet, id: '6668732', steps: [{ ...booklet.steps[0], section: 4 }] };
  const m: Matches = { ...matches, matches: [...matches.matches, { ...matches.matches[0], booklet: '6668732' }] };
  const { plan } = planFromBooklets('40859', [[booklet], [b2]], m, resolve);
  expect(Object.keys(plan.submodels ?? {})).toEqual(['40859 1', '40859 2']);
  expect(plan.submodels!['40859 2'].steps[0].title).toBe('Section 4');
  expect(plan.steps).toEqual([
    { pieces: [{ submodel: '40859 1', x: 0, y: 0, z: 0, rot: 0 }] },
    { pieces: [{ submodel: '40859 2', x: 24, y: 0, z: 0, rot: 0 }] },
  ]);
});

test('exports through exportLDraw', () => {
  const text = exportLDraw(one().plan, metrics, fixtureColors);
  expect(text.match(/^0 STEP$/gm)).toHaveLength(3);
  expect(importLDraw(text, 'superman.mpd').steps).toHaveLength(3);
});

test('report lists flags and over-use', () => {
  const { plan, flags } = one();
  const md = instructionsReport('superman', plan, flags, matches);
  expect(md).toContain('| 302328 | 3 | 2 |');
  expect(md).toContain('| 4243814 | 1 |');
  expect(md).toContain('step 2: callout part 1 not identified');
  expect(md).toMatch(/Steps: 3 · Pieces: 5 · Flags: \d+/);
});

test('a step with no new parts is flagged, since BrickMotion merges empty steps', () => {
  const b: Booklet = { ...booklet, steps: [...booklet.steps, { page: 30, number: 4, picture: null, callout: [], substeps: [] }] };
  const { flags } = planFromBooklets('superman', [[b]], matches, resolve);
  expect(flags).toContainEqual({ step: 4, message: 'step 4 adds no new parts (attaches a sub-build or turns the model); BrickMotion merges it into the next step until Phase 2 places sub-builds' });
});

test('report says plainly when no inventory page was available', () => {
  const { plan, flags } = one();
  const md = instructionsReport('superman', plan, flags, { matches: [], overUse: [], unused: [] }, { inventoryPage: false });
  expect(md).toContain('No inventory page in these booklets: part counts were checked against Rebrickable instead (see Flags).');
  expect(md).not.toContain('Every inventory part is used exactly');
});
