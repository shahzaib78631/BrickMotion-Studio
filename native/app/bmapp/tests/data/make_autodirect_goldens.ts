// Writes autodirect_goldens.json: the web app's Auto-direct (src/anim/cameraTrack/autoDirect.ts)
// on two synthetic builds, for every style, plus a merge with a hand-made key. The native port
// (camera_track.cpp autoDirect) is tested against it. Run from the repository root:
//   npx tsx native/app/bmapp/tests/data/make_autodirect_goldens.ts
import { writeFileSync } from 'node:fs';
import { autoDirect, mergeAuto } from '../../../../../src/anim/cameraTrack/autoDirect';
import type { CameraTrack, DirectorStyle } from '../../../../../src/anim/cameraTrack/types';

type Box = { min: [number, number, number]; max: [number, number, number] };
type Unit = { start: number; dur: number; land: Box };

/** A build in LDU (y up is negative): a base, sides that fill one way then the other, a tall part. */
function build(pieces: number, intro: number): { units: Unit[]; modelBox: Box; intro: number; buildEnd: number; duration: number } {
  const units: Unit[] = [];
  for (let i = 0; i < pieces; i++) {
    const layer = Math.floor(i / 6);
    const side = Math.floor(i / 3) % 2 === 0 ? 1 : -1;
    const x = side * (20 + (i % 3) * 20);
    const y0 = -24 * (layer + 1);
    const tall = i === Math.floor(pieces * 0.7);
    const land: Box = tall ? { min: [-10, -200, -10], max: [10, y0 + 24, 10] } : { min: [x - 20, y0, -20], max: [x + 20, y0 + 24, 20] };
    units.push({ start: intro + i * 0.55, dur: 0.5, land });
  }
  const modelBox = units.reduce<Box>((b, u) => ({
    min: [0, 1, 2].map((k) => Math.min(b.min[k], u.land.min[k])) as Box['min'],
    max: [0, 1, 2].map((k) => Math.max(b.max[k], u.land.max[k])) as Box['max'],
  }), { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  const buildEnd = Math.max(...units.map((u) => u.start + u.dur));
  return { units, modelBox, intro, buildEnd, duration: buildEnd + 3 };
}

const styles: DirectorStyle[] = ['reference', 'showcase', 'turntable', 'calm', 'energetic', 'overhead'];
const cases = [{ name: 'short', ...build(24, 1) }, { name: 'long', ...build(70, 1) }].map((tl) => ({
  ...tl,
  tracks: Object.fromEntries(styles.map((style) => [style, autoDirect(tl as never, { style, swings: 0.5, lensMm: 50, shutter: 0.5 })])),
}));
// a hand-made key at 5 s and an edited move: kept; automatic keys near it make way
const mine: CameraTrack = {
  keys: [{ id: 'mine', t: 5, target: { kind: 'model' }, offset: [0, 0, 0], azimuth: 90, elevation: 30, distance: { fit: true, margin: 1.3 }, roll: 0, lensMm: 35, focus: 'target', blur: 0, origin: 'user' },
    { id: 'auto-1', t: 2, target: { kind: 'build' }, offset: [0, 0, 0], azimuth: 10, elevation: 40, distance: { fit: true, margin: 1.15 }, roll: 0, lensMm: 50, focus: 'target', blur: 0, origin: 'user' }],
  transitions: [{ from: 'auto-1', to: 'mine', preset: 'orbit', settings: cases[0].tracks.reference.transitions[0].settings, origin: 'user' }],
  shutter: 0.25,
};
const merged = mergeAuto(mine, cases[0].tracks.reference, cases[0].duration);
writeFileSync(new URL('./autodirect_goldens.json', import.meta.url), JSON.stringify({ cases, merge: { existing: mine, merged } }, null, 1));
