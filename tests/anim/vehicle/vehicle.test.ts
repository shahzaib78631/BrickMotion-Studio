/** Vehicle recognition (spec §5.1): ground wheels, axles, chassis, steering, towed units. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Assembly } from '../../../src/model/assemble';
import { inspectMechanisms } from '../../../src/anim/motion/v4/mechanismLab';
import type { Vehicle } from '../../../src/anim/motion/vehicle/vehicle';
import { loadRealModel, partDataInstalled } from '../../diagnostics/loadRealModel';

const SAMPLES = join(__dirname, '..', '..', '..', 'samples');
const M5590 = join(SAMPLES, '5590_-_whirl_n_wheel_super_truck.mpd'), M42000 = join(SAMPLES, '42000-1.mpd'), M8880 = join(SAMPLES, '8880-1-axle-fix.mpd');
const load = async (file: string): Promise<{ asm: Assembly; v: Vehicle }> => {
  const { asm, metrics } = await loadRealModel(file);
  return { asm, v: inspectMechanisms(asm, metrics).vehicle! };
};
const partOf = (asm: Assembly, key: string) => asm.instances.find(i => i.key === key)!.part.replace(/\.dat$/i, '');

describe.skipIf(!partDataInstalled() || !existsSync(M5590))('5590 vehicle', () => {
  it('ten truck wheels on three axles, the trailer towed and the knob tyre left out', async () => {
    const { v } = await load(M5590);
    expect(v.wheels).toHaveLength(10);
    expect(v.axles).toHaveLength(3);
    expect(v.axles.filter(a => a.steered)).toHaveLength(1);
    expect(v.towed).toHaveLength(8);
    expect(v.wheels.every(w => Math.abs(w.radius - 54) < 0.5)).toBe(true);
    expect(v.wheels.some(w => w.centre[1] < -100)).toBe(false);
    expect(v.forward[2]).toBeLessThan(-0.99);
    expect(v.warnings.join('\n')).toMatch(/8 trailer wheels are towed/);
  }, 600_000);
});

describe.skipIf(!partDataInstalled() || !existsSync(M42000))('42000 vehicle', () => {
  it('four wheels, two axles, the front pair steered', async () => {
    const { v } = await load(M42000);
    expect(v.wheels).toHaveLength(4);
    expect(v.axles).toHaveLength(2);
    const steered = v.wheels.filter(w => w.steered);
    expect(steered).toHaveLength(2);
    expect(steered.every(w => Math.abs(w.centre[2] + 280) < 3)).toBe(true);
    expect(v.steering).toMatch(/steering/i);
  }, 600_000);
});

describe.skipIf(!partDataInstalled() || !existsSync(M8880))('8880 vehicle', () => {
  it('four wheels on two axles, tyres not rims', async () => {
    const { asm, v } = await load(M8880);
    expect(v.wheels).toHaveLength(4);
    expect(v.axles).toHaveLength(2);
    expect(v.wheels.every(w => partOf(asm, w.tyre) === '2997')).toBe(true);
  }, 600_000);
});
