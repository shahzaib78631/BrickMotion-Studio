/**
 * Suggestions built from named mechanisms (spec section E, Task 8): each one
 * is a whole function, driven at its input and proven over its whole travel.
 * The 42000 expectations follow Kinebrick's 42000 analysis
 * (erik-larsen/kinebrick, CC BY-SA 4.0), used only as an oracle.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Assembly } from '../../src/model/assemble';
import { inspectMechanisms, solveLabFrame, type LabReport } from '../../src/anim/motion/v4/mechanismLab';
import { MechanismSolver } from '../../src/anim/motion/v4/mechanismSolver';
import { validateMechanismProgram } from '../../src/anim/motion/v4/mechanismProgram';
import { playShiftTrack } from '../../src/anim/motion/gearbox/shiftPlayback';
import type { SuggestedMechanism } from '../../src/anim/motion/v4/autoMechanics';
import { loadRealModel, partDataInstalled } from '../diagnostics/loadRealModel';

const SAMPLES = join(__dirname, '..', '..', 'samples');
const M42000 = join(SAMPLES, '42000-1.mpd'), M5590 = join(SAMPLES, '5590_-_whirl_n_wheel_super_truck.mpd'), M8880 = join(SAMPLES, '8880-1.mpd');

function finder(asm: Assembly) {
  return (part: string, x: number, y: number, z: number) => {
    let best: { key: string; d: number } | null = null;
    for (const i of asm.instances) {
      if (i.part.replace(/\.dat$/, '') !== part) continue;
      const d = Math.hypot(i.world.elements[12] - x, i.world.elements[13] - y, i.world.elements[14] - z);
      if (d <= 12 && (!best || d < best.d)) best = { key: i.key, d };
    }
    if (!best) throw new Error(`no ${part} at ${x},${y},${z}`);
    return best.key;
  };
}
/** Bodies the suggestion's driver joint turns directly (its body and that body's followers). */
const drivenBy = (s: SuggestedMechanism) => {
  const p = s.program, j = p.joints.find(x => x.id === p.driver.joint)!;
  return new Set([j.body, ...(p.rigidFollowers ?? []).filter(f => f.leader === j.body).flatMap(f => f.bodies)]);
};
/** Largest travel of each part (LDU of its origin, or degrees turned) driving to both ends; plus every frame. */
function sweep(asm: Assembly, s: SuggestedMechanism, keys: readonly string[]) {
  const solver = new MechanismSolver(asm, s.program), most = new Map(keys.map(k => [k, { ldu: 0, deg: 0 }]));
  const frames: Map<string, THREE.Matrix4>[] = [];
  for (const end of [1, -1]) {
    solver.assembled();
    for (let i = 1; i <= 8; i++) {
      const poses = solveLabFrame(solver, end * s.program.driver.amplitude * i / 8);
      frames.push(poses);
      for (const k of keys) {
        const pose = poses.get(k), rest = solver.rest.get(k)!;
        if (!pose) continue;
        const delta = pose.clone().multiply(rest.clone().invert());
        const q = new THREE.Quaternion().setFromRotationMatrix(delta);
        const o = new THREE.Vector3().setFromMatrixPosition(rest), m = most.get(k)!;
        m.ldu = Math.max(m.ldu, o.clone().applyMatrix4(delta).distanceTo(o));
        m.deg = Math.max(m.deg, 2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180 / Math.PI);
      }
    }
  }
  return { most, frames, rest: solver.rest };
}
const moved = (m: { ldu: number; deg: number }) => m.ldu >= 0.5 || m.deg >= 1;

describe.skipIf(!partDataInstalled() || !existsSync(M5590))('5590 suggestions', () => {
  it('the top suggestion is still the measured rack steering', async () => {
    const { asm, metrics } = await loadRealModel(M5590);
    const s = inspectMechanisms(asm, metrics).detection.suggestions;
    expect(s[0].title).toMatch(/^Rack steering — 4143 → 3647 → 3743 on a four-bar tie rod/);
    expect(s[0].mechanism?.kind).toBe('rack-steering');
    expect(s.filter(x => x.mechanism?.kind === 'gearbox')).toEqual([]);
  }, 600_000);
});

describe.skipIf(!partDataInstalled() || !existsSync(M8880))('8880 suggestions', () => {
  it('offers a suggestion per gear that reaches the wheels, labelled with its ratio', async () => {
    const { asm, metrics } = await loadRealModel(M8880);
    const titles = inspectMechanisms(asm, metrics).detection.suggestions.filter(s => s.mechanism?.kind === 'gearbox').map(s => s.title);
    expect(titles.some(t => /\(2\.25:1\)/.test(t)), titles.join('\n')).toBe(true);
    expect(titles.some(t => /\(0\.75:1\)/.test(t)), titles.join('\n')).toBe(true);
    expect(new Set(titles).size).toBe(titles.length);
  }, 600_000);
  it('plays each gear through neutral into the next, the shift ring sliding', async () => {
    const { asm, metrics } = await loadRealModel(M8880);
    const boxes = inspectMechanisms(asm, metrics).detection.suggestions.filter(s => s.mechanism?.kind === 'gearbox');
    expect(boxes.length).toBeGreaterThan(0);
    for (const s of boxes) {
      const p = s.program!;
      expect(validateMechanismProgram(p)).toEqual([]);
      expect(p.shiftTrack!.map(m => m.at)).toEqual([0, 0.45, 0.55]);
      // One row per ring state, each named once: '1st', '1st + 3rd', … and two rings on one shaft lock up.
      const labels = s.gears!.map(r => r.label);
      expect(new Set(labels).size, labels.join(', ')).toBe(labels.length);
      expect(s.gears![0]).toMatchObject({ label: 'neutral', state: 'neutral' });
      const solver = new MechanismSolver(asm, p), modes: string[] = [];
      const rings = p.selectors!.map(x => x.ring), at = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);
      let slid = 0;
      for (let i = 0; i <= 120; i++) {
        const f = playShiftTrack(solver, i / 120);
        modes.push(f.mode);
        slid = Math.max(slid, ...rings.map(r => at(f.poses.get(r)!).distanceTo(at(solver.rest.get(r)!))));
      }
      expect(modes[0], s.title).toBe(p.shiftTrack![0].label);
      expect(modes.at(-1), s.title).toBe(p.shiftTrack![2].label);
      expect(slid, s.title).toBeGreaterThan(1);
    }
  }, 600_000);
});

describe.skipIf(!partDataInstalled() || !existsSync(M42000))('42000 suggestions', () => {
  let asm: Assembly, report: LabReport, at: ReturnType<typeof finder>, suggestions: SuggestedMechanism[];
  beforeAll(async () => {
    const m = await loadRealModel(M42000);
    asm = m.asm; report = inspectMechanisms(asm, m.metrics); at = finder(asm); suggestions = report.detection.suggestions;
  }, 600_000);
  const named = (kind: string) => suggestions.filter(s => s.mechanism?.kind === kind && s.evidence === 'classified');

  it('the rear axle drives the V8: crankshaft turns, pistons stay on their cylinder axes', () => {
    // The right rear hub is not joined to its CV axle (5 LDU off, see the tolerance ruling), so drive from the axle.
    const axle = at('92906', 60, -60, 640), crank = at('2853', 0, -100, 470);
    const pistons = asm.instances.filter(i => i.part.replace(/\.dat$/, '') === '2851').map(i => i.key);
    expect(pistons).toHaveLength(8);
    const drive = named('piston-engine').find(s => drivenBy(s).has(axle));
    expect(drive, suggestions.map(s => s.title).join('\n')).toBeDefined();
    const { most, frames, rest } = sweep(asm, drive!, [crank, at('62821', 0, -60, 640), ...pistons]);
    expect(most.get(crank)!.deg).toBeGreaterThan(30);
    expect(moved(most.get(at('62821', 0, -60, 640))!)).toBe(true);
    for (const p of pistons) {
      expect(moved(most.get(p)!), p).toBe(true);
      // Each piston only slides: its origin stays on the line it slides along.
      const o = new THREE.Vector3().setFromMatrixPosition(rest.get(p)!);
      const line = frames.map(f => new THREE.Vector3().setFromMatrixPosition(f.get(p)!)).find(x => x.distanceTo(o) > 1)!;
      const dir = line.clone().sub(o).normalize();
      for (const f of frames) {
        const x = new THREE.Vector3().setFromMatrixPosition(f.get(p)!).sub(o);
        expect(x.clone().sub(dir.clone().multiplyScalar(x.dot(dir))).length()).toBeLessThan(0.1);
      }
    }
  });

  it('the steering wheel turns both front hubs, the rear hubs stay', () => {
    const wheel = at('32138', 0, -100, 101);
    const s = named('rack-steering').find(x => drivenBy(x).has(wheel));
    expect(s, suggestions.map(x => x.title).join('\n')).toBeDefined();
    const front = [at('11949', -220, -60, -280), at('11949', 220, -60, -280), at('92909', 247, -60, -280), at('92909', -247, -60, -280)];
    const rear = [at('92909', 247, -60, 640), at('92909', -247, -60, 640)];
    const { most } = sweep(asm, s!, [...front, ...rear]);
    for (const k of front) expect(most.get(k)!.deg, k).toBeGreaterThan(5);
    for (const k of rear) expect(moved(most.get(k)!), k).toBe(false);
  });

  it('the left rear suspension sweeps: wishbone works the rocker and its shock', () => {
    const wishbone = at('32294', -140, -40, 685);
    const s = named('suspension').find(x => drivenBy(x).has(wishbone));
    expect(s, suggestions.map(x => x.title).join('\n')).toBeDefined();
    const { most } = sweep(asm, s!, [at('87083', -60, -110, 620), at('4254', -20, -120, 620)]);
    for (const [k, m] of most) expect(moved(m), k).toBe(true);
  });

  it('the function selector is not offered driving the wing and the engine cover together', () => {
    const wing = at('92693c01', 0, 0, 600), covers = [at('92693c01', 100, -40, 270), at('92693c01', -100, -40, 270)];
    for (const s of suggestions.filter(x => x.evidence === 'classified')) {
      const { most } = sweep(asm, s, [wing, ...covers]);
      expect(moved(most.get(wing)!) && covers.some(c => moved(most.get(c)!)), s.title).toBe(false);
    }
  });

  it('the selector knob turns the engine-cover gears in one gear and the wing drive in the other', () => {
    // The small linear actuators (92693c01) have no screw pair yet (a phase 3 gap), so the
    // check stops at the gears each clutch selects: 92695 for the covers, 3707 toward the wing.
    const knob = at('32270', -250, -40, 450), covers = [at('92695', 100, -65, 253), at('92695', -100, -65, 253)], wing = at('3707', -20, -40, 410);
    const gear = suggestions.filter(s => s.mechanism?.kind === 'gearbox');
    expect(gear.map(s => s.title)).toHaveLength(2);
    for (const s of gear) expect(drivenBy(s).has(knob), s.title).toBe(true);
    const moves = (s: SuggestedMechanism, k: string) => moved(sweep(asm, s, [k]).most.get(k)!);
    const c = gear.find(s => covers.every(k => moves(s, k))), w = gear.find(s => moves(s, wing));
    expect(c, gear.map(s => s.title).join('\n')).toBeDefined();
    expect(w, gear.map(s => s.title).join('\n')).toBeDefined();
    expect(w).not.toBe(c);
    expect(moves(c!, wing)).toBe(false);
    expect(covers.some(k => moves(w!, k))).toBe(false);
  });

  it('no mechanism is suggested twice', () => {
    const titles = suggestions.map(s => s.title);
    expect(new Set(titles).size).toBe(titles.length);
    // Each gear of a gearbox is offered on its own, from the same input.
    const drives = suggestions.filter(s => s.mechanism?.kind !== 'gearbox').map(s => [...drivenBy(s)].sort().join(','));
    expect(new Set(drives).size).toBe(drives.length);
  });

  it('whole functions come before single joints and hinges', () => {
    const rank = (s: SuggestedMechanism) => (!s.mechanism ? 2 : ['four-bar', 'parallelogram', 'turntable', 'slider-crank', 'worm-drive', 'watt-six-bar', 'stephenson-six-bar'].includes(s.mechanism.kind) ? 1 : 0);
    const ranks = suggestions.map(rank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(ranks[0]).toBe(0);
  });
});
