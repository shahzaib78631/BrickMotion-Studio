import { expect, test } from 'vitest';
import { attachAssemblyArtifact, planToJson, readPlanFile } from '../../src/io/planFile';
import { parseAssemblyArtifact } from '../../src/anim/assemblyPlan/artifact';
import { emptyPlan } from '../../src/plan/types';

test('reads plan json', () => {
  const r = readPlanFile(planToJson(emptyPlan('x')), 'x.json');
  expect(r.ok).toBe(true);
});

test('reads mpd', () => {
  const r = readPlanFile('1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n', 'set.mpd');
  expect(r.ok && r.plan.steps[0].pieces.length).toBe(1);
});

test('rejects unsupported files and bad json', () => {
  expect(readPlanFile('hello', 'notes.txt').ok).toBe(false);
  expect(readPlanFile('{oops', 'x.json').ok).toBe(false);
});

const artifact = {
  format: 'brickmotion-assembly-plan',
  version: 1,
  model: 'mini.mpd',
  units: 'ldu',
  jointsCertain: 1,
  pieces: [{ key: 'mini/0', part: '3005.dat', color: 16, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
  joints: [],
  steps: [{ id: 's1', pieces: ['mini/0'], order: 0, dependsOn: [], insertion: { axis: [0, -1, 0], distance: 48, origin: [0, -24, 0], priority: '0', tier: 'snap' }, certificate: { kind: 'swept-aabb', frames: 32, margin: 1.5, clear: true, blockers: [] }, uncertified: false, reason: null }],
  stats: { pieces: 1, certified: 1, ms: 0.4 },
};

test('rejects a bare artifact: attach to an open model instead', () => {
  const r = readPlanFile(JSON.stringify(artifact), 'x.assembly.json');
  expect(r.ok).toBe(false);
  expect((r as { errors: string[] }).errors[0]).toMatch(/assembly plan artifact/i);
});

test('opens an artifact that carries its model plan inside', () => {
  const wrapped = { ...artifact, appPlan: emptyPlan('mini') };
  const r = readPlanFile(JSON.stringify(wrapped), 'x.assembly.json');
  expect(r.ok).toBe(true);
  expect((r as { ok: true; plan: { assemblyPlan?: unknown } }).plan.assemblyPlan).toEqual(wrapped);
});

test('appPlan of the wrong shape fails loudly', () => {
  const r = readPlanFile(JSON.stringify({ ...artifact, appPlan: { format: 'brickmotion-plan', version: 1 } }), 'x.assembly.json');
  expect(r.ok).toBe(false);
});

test('attachAssemblyArtifact keeps an open plan and stores the artifact', () => {
  const r = attachAssemblyArtifact(emptyPlan('x'), artifact);
  expect(r.ok).toBe(true);
  const parse = parseAssemblyArtifact((r as { ok: true; plan: { assemblyPlan?: unknown } }).plan.assemblyPlan);
  expect(parse.ok).toBe(true);
});
