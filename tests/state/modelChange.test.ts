import { describe, expect, it } from 'vitest';
import { setSubmodelBuildSpot } from '../../src/plan/pieceActions';
import { sameGeometry } from '../../src/state/modelChange';
import type { Plan } from '../../src/plan/types';

const plan = (): Plan => ({
  format: 'brickmotion-plan', version: 1, name: 'Geometry cache',
  steps: [{ pieces: [
    { id: 'base', part: '3020', color: 4, x: 0, y: 0, z: 0, rot: 0 },
    { id: 'truck', submodel: 'body', x: 0, y: 0, z: 0, rot: 0 },
  ] }],
  submodels: { body: { steps: [{ pieces: [
    { id: 'wheel', part: '3020', color: 4, x: 0, y: 0, z: 0, rot: 0 },
    { id: 'nested', submodel: 'seat', x: 1, y: 0, z: 0, rot: 90 },
  ] }] }, seat: { steps: [{ pieces: [
    { id: 'p', part: '3020', color: 4, x: 0, y: 0, z: 0, rot: 0 },
  ] }] } },
});

describe('reuse assembled geometry during spot-only edits', () => {
  it('keeps the existing model ready when moving a root submodel bay', () => {
    const before = plan();
    const after = setSubmodelBuildSpot(before, '', 'truck', { x: 16, z: 2, angle: 45 });
    expect(sameGeometry(before, after)).toBe(true);
    expect(sameGeometry(after, setSubmodelBuildSpot(after, '', 'truck', null))).toBe(true);
  });
  it('also reuses geometry for nested submodel definitions and main spot changes', () => {
    const before = plan();
    const after = setSubmodelBuildSpot(before, 'body', 'nested', { x: -4, z: 9, angle: 90 });
    expect(sameGeometry(before, after)).toBe(true);
    expect(sameGeometry(before, { ...before, assemblySpot: { x: 12, z: 5, angle: 30 } })).toBe(true);
    expect(sameGeometry(before, { ...before, showModelAtSpot: true })).toBe(true);
    expect(sameGeometry(before, { ...before, animation: { fps: 24, startFrame: 1, endFrame: 250, tracks: [] } })).toBe(true);
  });
  it('still invalidates on real geometry, connector or step edits', () => {
    const before = plan();
    const bad = structuredClone(before);
    const root = bad.steps[0].pieces[1];
    if ('x' in root) root.x = 12;
    expect(sameGeometry(before, bad)).toBe(false);
    const changedHints = structuredClone(before);
    changedHints.steps[0].pieces[1].assembly = { attachTo: 'base' };
    expect(sameGeometry(before, changedHints)).toBe(false);
    const changedSteps = { ...before, steps: [{ ...before.steps[0], pauseAfter: 1 }] };
    expect(sameGeometry(before, changedSteps)).toBe(false);
    const changedParts = { ...before, parts: { 'custom.dat': '0 FILE custom.dat' } };
    expect(sameGeometry(before, changedParts)).toBe(false);
  });
});
