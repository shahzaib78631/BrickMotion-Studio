/** The gearbox mode table, from the gear network alone (spec §4.1). */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Metrics } from '../../../src/model/assemble';
import { inspectMechanisms } from '../../../src/anim/motion/v4/mechanismLab';
import { classify } from '../../../src/anim/motion/classify/patterns';
import { findShiftElements, type ShiftElement } from '../../../src/anim/motion/gearbox/shiftElements';
import { rateNetwork, shiftModes, type RateNetwork } from '../../../src/anim/motion/gearbox/shiftModes';
import { loadRealModel, partDataInstalled } from '../../diagnostics/loadRealModel';

// Synthetic two-speed box. Bodies: 0 input shaft, 1 low gear (30T, free on 0), 2 high gear (10T, free on 0),
// 3 output (10T pinion meshes 1; 30T gear meshes 2), 4 ring on 0.
const net: RateNetwork = { meshes: [{ a: 1, b: 3, teethA: 30, teethB: 10, pair: 'p1' }, { a: 2, b: 3, teethA: 10, teethB: 30, pair: 'p2' }], locks: [] };
const ring = { ring: 'r', ringBody: 4, shaftBody: 0, axis: [0, 0, 1], centre: [0, 0, 0], travel: [-12, 12], dogs: 4,
  couplings: [{ gear: 'g1', gearBody: 1, side: -1, engageAt: -2 }, { gear: 'g2', gearBody: 2, side: 1, engageAt: 2 }] } as ShiftElement;

describe('mode table', () => {
  it('neutral, then each gear with its ratio', () => {
    const m = shiftModes(net, [ring], 0, 3);
    expect(m[0]).toMatchObject({ state: 'neutral', engaged: [] });
    expect(m.filter(x => x.state === 'drive').map(x => x.ratio)).toEqual([3, 1 / 3].map(r => expect.closeTo(r, 9)));
  });
  it('two rings that disagree lock up', () => {
    const second = { ...ring, ring: 'r2', ringBody: 5, couplings: [{ ...ring.couplings[1], gear: 'g2b' }] } as ShiftElement;
    expect(shiftModes(net, [ring, second], 0, 3).find(x => x.engaged.length === 2 && x.engaged.some(e => e.gear === 'g1'))?.state).toBe('locked');
  });
  it('an output the gearbox never reaches is neutral in every row', () => {
    expect(shiftModes(net, [ring], 0, 99).every(x => x.state === 'neutral')).toBe(true);
  });
});

const M8880 = join(__dirname, '..', '..', '..', 'samples', '8880-1.mpd');
describe.skipIf(!partDataInstalled() || !existsSync(M8880))('8880 Super Car', () => {
  const setup = async () => {
    const { asm, metrics } = await loadRealModel(M8880);
    const report = inspectMechanisms(asm, metrics), rec = report.graph.recognition!;
    const bodyOf = (part: string, at: number[]) => rec.bodyOf.get(asm.instances.find(i => i.part.startsWith(part)
      && Math.hypot(...[0, 1, 2].map(n => (i.worldBox.min[n] + i.worldBox.max[n]) / 2 - at[n])) < 3)!.key)!;
    const named = classify(rec, report.higherPairs, [], asm, metrics as Metrics);
    return { net: rateNetwork(rec, report.higherPairs, named, asm), shifts: findShiftElements(asm, rec), bodyOf,
      input: bodyOf('4019', [20, -54, 390]), output: bodyOf('6573', [0, -54, 500]) };
  };
  const singleDrive = (modes: ReturnType<typeof shiftModes>) => modes.filter(m => m.engaged.length === 1 && m.state === 'drive').map(m => m.ratio);
  it('as modelled: 1st and 3rd match the manual; 2nd and 4th stop at the axle-less 3647', async () => {
    const s = await setup();
    expect(singleDrive(shiftModes(s.net, s.shifts, s.input, s.output))).toEqual([expect.closeTo(2.25, 3), expect.closeTo(0.75, 3)]);
  }, 600_000);
  it('with the missing axle supplied, all four ratios match the manual', async () => {
    const s = await setup();
    const fixed: RateNetwork = { ...s.net, locks: [...s.net.locks, [s.bodyOf('3647', [-60, -14, -70]), s.bodyOf('6538a', [-60, -14, 80])]] };
    expect(singleDrive(shiftModes(fixed, s.shifts, s.input, s.output))).toEqual([2.25, 1.5, 0.75, 0.5].map(r => expect.closeTo(r, 3)));
  }, 600_000);
});

// The same model with the missing Axle 8 under 3647 added (samples/8880-1-axle-fix.mpd).
const M8880_FIXED = join(__dirname, '..', '..', '..', 'samples', '8880-1-axle-fix.mpd');
describe.skipIf(!partDataInstalled() || !existsSync(M8880_FIXED))('8880 Super Car, axle fixed', () => {
  it('gives all four of the manual\'s ratios as modelled', async () => {
    const { asm, metrics } = await loadRealModel(M8880_FIXED);
    const report = inspectMechanisms(asm, metrics), rec = report.graph.recognition!;
    const bodyOf = (part: string, at: number[]) => rec.bodyOf.get(asm.instances.find(i => i.part.startsWith(part)
      && Math.hypot(...[0, 1, 2].map(n => (i.worldBox.min[n] + i.worldBox.max[n]) / 2 - at[n])) < 3)!.key)!;
    const net = rateNetwork(rec, report.higherPairs, classify(rec, report.higherPairs, [], asm, metrics as Metrics), asm);
    const modes = shiftModes(net, findShiftElements(asm, rec), bodyOf('4019', [20, -54, 390]), bodyOf('6573', [0, -54, 500]));
    expect(modes.filter(m => m.engaged.length === 1 && m.state === 'drive').map(m => m.ratio))
      .toEqual([2.25, 1.5, 0.75, 0.5].map(r => expect.closeTo(r, 3)));
    const titles = report.detection.suggestions.filter(s => s.mechanism?.kind === 'gearbox').map(s => s.title);
    expect(titles.filter(t => /\(\d\.\d\d:1\)/.test(t)), titles.join('\n')).toHaveLength(4);
  }, 600_000);
});

const M42000 = join(__dirname, '..', '..', '..', 'samples', '42000-1.mpd');
describe.skipIf(!partDataInstalled() || !existsSync(M42000))('42000 gear network', () => {
  it('leaves out a gear that does not turn on a bearing of its own body', async () => {
    const { asm, metrics } = await loadRealModel(M42000);
    const report = inspectMechanisms(asm, metrics), rec = report.graph.recognition!;
    const net = rateNetwork(rec, report.higherPairs, classify(rec, report.higherPairs, [], asm, metrics as Metrics), asm);
    // Bevel 6589 sits on a tilted axle whose body only hinges about x at z=479.
    const tilted = rec.bodyOf.get(asm.instances.find(i => i.part.startsWith('6589') && Math.abs(i.world.elements[14] - 433) < 2)!.key)!;
    expect(net.meshes.filter(m => m.a === tilted || m.b === tilted)).toEqual([]);
    // The selector's clutch gears still mesh.
    const clutch = rec.bodyOf.get(asm.instances.find(i => i.part.startsWith('6542b') && Math.abs(i.world.elements[12] + 70) < 2 && Math.abs(i.world.elements[14] - 450) < 2)!.key)!;
    expect(net.meshes.some(m => m.a === clutch || m.b === clutch)).toBe(true);
  }, 600_000);
});
