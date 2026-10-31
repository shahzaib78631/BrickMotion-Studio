import { describe, expect, it } from 'vitest';
import { parsePlan } from '../../src/plan/schema';
import { DEFAULT_TRANSITION } from '../../src/anim/cameraTrack/presets';
import type { Plan } from '../../src/plan/types';

const withTrack = (): Plan => ({
  format: 'brickmotion-plan', version: 1, name: 'x', steps: [],
  cameraTracks: { '': { build: {
    keys: [
      { id: 'a', t: 0, target: { kind: 'model' }, offset: [0, 0, 0], azimuth: 10, elevation: 60, distance: { fit: true, margin: 1.1 }, roll: 0, lensMm: 50, focus: 'target', blur: 0, origin: 'auto' },
      { id: 'b', t: 4, target: { kind: 'point', at: [1, 2, 3] }, offset: [0, 1, 0], azimuth: 180, elevation: 15, distance: { fit: false, value: 30 }, roll: 5, lensMm: 85, focus: 0.3, blur: 0.4, origin: 'user' },
    ],
    transitions: [{ from: 'a', to: 'b', preset: 'swoop', settings: { ...DEFAULT_TRANSITION, turnLast: 0.5 }, origin: 'user' }],
    shutter: 0.5, style: 'reference',
  } } },
});

describe('camera tracks in the project file', () => {
  it('a plan without camera tracks still loads', () => {
    expect(parsePlan({ format: 'brickmotion-plan', version: 1, name: 'x', steps: [] }).ok).toBe(true);
  });
  it('a camera track survives save and load unchanged', () => {
    const p = withTrack();
    const r = parsePlan(JSON.parse(JSON.stringify(p)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.cameraTracks).toEqual(p.cameraTracks);
  });
  it('rejects a malformed key with a path to it', () => {
    const p = withTrack() as unknown as { cameraTracks: Record<string, { build: { keys: Record<string, unknown>[] } }> };
    p.cameraTracks[''].build.keys[1].elevation = 'x';
    const r = parsePlan(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('cameraTracks..build.keys.1.elevation');
  });
});
