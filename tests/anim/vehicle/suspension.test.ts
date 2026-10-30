/** Shock stroke from the parts, and camber gain and bump steer from a sweep (spec §5.6), on the 42000. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectMechanisms } from '../../../src/anim/motion/v4/mechanismLab';
import { sweepSuspension } from '../../../src/anim/motion/vehicle/suspension';
import { loadRealModel, partDataInstalled } from '../../diagnostics/loadRealModel';

const M42000 = join(__dirname, '..', '..', '..', 'samples', '42000-1.mpd');

describe.skipIf(!partDataInstalled() || !existsSync(M42000))('42000 rear suspension', () => {
  it('each shock gets its stroke from its parts, and both rear wheels sweep with a measured bump steer', async () => {
    const { asm, metrics } = await loadRealModel(M42000);
    const rear = inspectMechanisms(asm, metrics).detection.suggestions.filter(s => s.mechanism?.kind === 'suspension' && s.wheel);
    expect(rear).toHaveLength(2);
    const sweeps = rear.map(s => {
      const slide = s.program.joints.find(j => j.kind === 'prismatic')!;
      expect(slide.limits?.source, s.title).toBe('verified');
      expect(slide.limits!.min).toBeLessThanOrEqual(0);
      expect(slide.limits!.max).toBeGreaterThanOrEqual(0);
      expect(slide.limits!.max - slide.limits!.min).toBeGreaterThan(0);
      const tyre = asm.instances.find(i => i.key === s.wheel)!;
      expect(Math.abs((tyre.worldBox.min[2] + tyre.worldBox.max[2]) / 2 - 640)).toBeLessThan(3);
      return sweepSuspension(asm, s.program, s.wheel!);
    });
    for (const w of sweeps) {
      expect(w.strokeMeasured).toBe(true);
      expect(w.travelLdu).toBeGreaterThan(5);
      expect(Number.isFinite(w.bumpSteerDeg) && w.bumpSteerDeg >= 0).toBe(true);
      expect(Number.isFinite(w.camberGainDegPerLdu)).toBe(true);
    }
    // A mirror pair: the same camber gain either side.
    const [a, b] = sweeps.map(w => Math.abs(w.camberGainDegPerLdu));
    expect(Math.abs(a - b)).toBeLessThanOrEqual(0.1 * Math.max(a, b) + 1e-4);
  }, 600_000);
});
