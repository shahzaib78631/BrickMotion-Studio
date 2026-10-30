/**
 * Playing a gearbox through its shift track (spec §4.3-4.5). Each frame the
 * clutches are set to the track's latest mark at the present pose, so the
 * output changes speed but never jumps; a clutch whose dogs are out of line
 * waits in neutral and engages once the shafts turn into line. Shift rings
 * slide toward their gear as they engage.
 */
import * as THREE from 'three';
import type { MechanismSolver } from '../v4/mechanismSolver';
import { solveLabFrame } from '../v4/mechanismLab';

export type ShiftFrame = {
  poses: Map<string, THREE.Matrix4>;
  /** The label of the mark in force; 'neutral' while a clutch waits for its dogs, 'locks' on lock-up. */
  mode: string;
  /** Clutches asked for but not yet engaged (dogs out of line). */
  stalled: string[];
};
export type ShiftOverride = { label: string; engagements: Readonly<Record<string, boolean>> };

/** A ring slides at most this far per frame, LDU. */
const SLIDE_STEP = 1;

/** The driver moves at most this far per solve (radians or LDU), so a long jump is walked, not leapt. */
const DRIVE_STEP = 0.25;
/** A step back in `t` larger than this is a new cycle: playback starts over. */
const WRAP = 0.5;

type State = { t: number; driver: number; engaged: Map<string, boolean>; slide: Map<string, number> };
const states = new WeakMap<MechanismSolver, State>();

/** Engage or release toward `want`; releases first, so a ring leaves one gear before taking the next. */
function setClutches(solver: MechanismSolver, s: State, want: Readonly<Record<string, boolean>>): { stalled: string[]; locked: boolean } {
  const release = Object.fromEntries(Object.entries(want).filter(([id, v]) => !v && s.engaged.get(id) !== false).map(([id]) => [id, false]));
  if (Object.keys(release).length) { solver.shift(release); for (const id of Object.keys(release)) s.engaged.set(id, false); }
  const engage = Object.fromEntries(Object.entries(want).filter(([id, v]) => v && !s.engaged.get(id)).map(([id]) => [id, true]));
  if (!Object.keys(engage).length) return { stalled: [], locked: false };
  try {
    const r = solver.shift(engage);
    for (const id of r.engaged) s.engaged.set(id, true);
    return { stalled: r.stalled, locked: false };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Gear lock-up')) return { stalled: Object.keys(engage), locked: true };
    throw e;
  }
}

/**
 * The frame at cycle fraction `t` (0..1): driver at amplitude·(2t − 1), the
 * Lab's position range. The first call, and a jump back of more than half a
 * cycle (playback wrapping), start over from the assembled pose with every
 * clutch out. Scrubbing back a little keeps the gears as they are.
 * `override` holds a gear chosen by hand in place of the track; `amplitude`
 * replaces the program's driver amplitude (the Lab's motion range).
 */
export function playShiftTrack(solver: MechanismSolver, t: number, override?: ShiftOverride,
  amplitude = solver.program.driver.amplitude): ShiftFrame {
  const program = solver.program, track = program.shiftTrack ?? [];
  const clutches = (program.transmissions ?? []).filter(x => x.kind === 'clutch').map(x => x.id);
  let s = states.get(solver);
  if (!s || t < s.t - WRAP) {
    solver.assembled();
    s = { t, driver: 0, engaged: new Map(), slide: new Map() };
    const all = Object.fromEntries(clutches.map(id => [id, false]));
    solver.shift(all);
    for (const id of clutches) s.engaged.set(id, false);
    states.set(solver, s);
  }
  s.t = t;
  const mark = override ?? [...track].reverse().find(m => m.at <= t) ?? track[0];
  const want = { ...Object.fromEntries(clutches.map(id => [id, false])), ...(mark?.engagements ?? {}) };
  const { stalled, locked } = setClutches(solver, s, want);
  const target = amplitude * (2 * t - 1);
  while (Math.abs(target - s.driver) > DRIVE_STEP) solver.solve(s.driver += Math.sign(target - s.driver) * DRIVE_STEP);
  const poses = solveLabFrame(solver, target);
  s.driver = target;
  for (const sel of program.selectors ?? []) {
    const engagedAt = Object.entries(sel.at).find(([id]) => s!.engaged.get(id));
    const waitingAt = Object.entries(sel.at).find(([id]) => stalled.includes(id));
    const goal = engagedAt ? engagedAt[1].engaged : waitingAt ? waitingAt[1].waiting : sel.neutral ?? 0;
    const now = s.slide.get(sel.ring) ?? goal;
    const next = now + Math.max(-SLIDE_STEP, Math.min(SLIDE_STEP, goal - now));
    s.slide.set(sel.ring, next);
    const pose = poses.get(sel.ring);
    if (!pose) continue;
    const n = Math.hypot(...sel.axis);
    const move = new THREE.Matrix4().makeTranslation(...sel.axis.map(x => (x / n) * next) as [number, number, number]);
    poses.set(sel.ring, move.multiply(pose));
  }
  const mode = locked ? 'locks' : stalled.length ? 'neutral' : mark?.label ?? 'neutral';
  return { poses, mode, stalled };
}
