import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { autoDirect, frontAzimuth, mergeAuto, type DirectorOptions } from '../../../src/anim/cameraTrack/autoDirect';
import { cameraTrackAt } from '../../../src/anim/cameraTrack/sample';
import { DEFAULT_TRANSITION } from '../../../src/anim/cameraTrack/presets';
import { worldBox3 } from '../../../src/anim/camera';
import type { CameraContext, CameraKey, CameraTrack } from '../../../src/anim/cameraTrack/types';
import type { Timeline } from '../../../src/anim/timeline';
import type { Box } from '../../../src/ldraw/flatten';

/**
 * A 20-piece build, 0.6 s per piece from t=1: a 4×4-stud tower growing upward (LDU −Y is up).
 * The first half lands spread over the whole footprint, the second half on the back
 * (LDU +Z, world −Z). Piece 15 is tall (a head): built height jumps.
 */
function fixture(): Timeline {
  const units = Array.from({ length: 20 }, (_, i) => {
    const y0 = -24 * i - (i >= 15 ? 60 : 0);
    const h = i === 15 ? 84 : 24;
    const back = i >= 10;
    const land: Box = back
      ? { min: [-40, y0 - h, 10], max: [40, y0, 40] }
      : { min: [-40, y0 - h, -40], max: [40, y0, 40] };
    return { kind: 'piece', keys: [`p${i}`], start: 1 + i * 0.6, dur: 0.5, step: i, land, box: land };
  });
  const top = Math.min(...units.map((u) => u.land.min[1]));
  const modelBox: Box = { min: [-40, top, -40], max: [40, 0, 40] };
  return { intro: 1, buildEnd: 13.5, duration: 16, heroOrbit: true, camKeys: [], subBuilds: [], units, modelBox, sceneBox: modelBox, buildBox: modelBox } as unknown as Timeline;
}

const opts = (over: Partial<DirectorOptions> = {}): DirectorOptions => ({ style: 'reference', swings: 0.6, lensMm: 70, shutter: 0.5, ...over });
const landT = (u: Timeline['units'][number]) => u.start + u.dur;
function ctxFor(tl: Timeline): CameraContext {
  const built = (t: number) => {
    const b = new THREE.Box3();
    for (const u of tl.units) if (u.start <= t + 0.8) b.union(worldBox3(u.land!));
    return b.isEmpty() ? worldBox3(tl.units[0].land!) : b;
  };
  return { aspect: 9 / 16, sensorMm: 36, duration: tl.duration, modelBox: worldBox3(tl.modelBox), buildBox: built, pieceBox: () => null };
}
const inFrame = (track: CameraTrack, ctx: CameraContext, t: number, box: THREE.Box3) => {
  const s = cameraTrackAt(track, t, ctx)!;
  const cam = new THREE.PerspectiveCamera(s.fov, ctx.aspect, 0.01, 5000);
  cam.position.copy(s.position); cam.lookAt(s.target); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const p = new THREE.Vector3(x, y, z).project(cam);
    if (Math.abs(p.x) > 1.02 || Math.abs(p.y) > 1.02) return false;
  }
  return true;
};
const angleGap = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

describe('autoDirect', () => {
  it('opens high and ends near eye level', () => {
    const tr = autoDirect(fixture(), opts());
    expect(tr.keys[0].elevation).toBeGreaterThanOrEqual(55);
    expect(tr.keys[0].elevation).toBeLessThanOrEqual(65);
    expect(tr.keys.at(-1)!.elevation).toBeGreaterThanOrEqual(10);
    expect(tr.keys.at(-1)!.elevation).toBeLessThanOrEqual(20);
  });
  it('only ever lowers the camera as the build grows', () => {
    const els = autoDirect(fixture(), opts()).keys.map((k) => k.elevation);
    for (let i = 1; i < els.length; i++) expect(els[i]).toBeLessThanOrEqual(els[i - 1] + 1e-9);
  });
  it('swings round to the side being built', () => {
    const tr = autoDirect(fixture(), opts({ front: 0 }));
    expect(angleGap(tr.keys[0].azimuth, 180)).toBeGreaterThan(90);
    const late = tr.keys.filter((k) => k.t > 7 && k.t < 13.5);
    expect(late.some((k) => angleGap(k.azimuth, 180) <= 45)).toBe(true);
  });
  it('ends facing the front, which can be overridden', () => {
    const tl = fixture();
    expect(angleGap(autoDirect(tl, opts()).keys.at(-1)!.azimuth, frontAzimuth(tl))).toBeLessThanOrEqual(1);
    expect(angleGap(autoDirect(tl, opts({ front: 90 })).keys.at(-1)!.azimuth, 90)).toBeLessThanOrEqual(1);
  });
  it('pulls back before the tall piece arrives', () => {
    const tl = fixture();
    const tr = autoDirect(tl, opts());
    const head = landT(tl.units[15]);
    expect(tr.transitions.some((x) => x.preset === 'pull-back' && tr.keys.find((k) => k.id === x.to)!.t <= head - 0.6 + 1e-9 && tr.keys.find((k) => k.id === x.to)!.t > head - 3)).toBe(true);
  });
  it('keeps every landing piece in frame as it lands', () => {
    const tl = fixture();
    const ctx = ctxFor(tl);
    for (const o of [opts(), opts({ front: 0 }), opts({ style: 'energetic', front: 90 })]) {
      const tr = autoDirect(tl, o);
      for (const u of tl.units) expect(inFrame(tr, ctx, landT(u), worldBox3(u.land!))).toBe(true);
    }
  });
  it('calm never swoops; overhead stays high', () => {
    const calm = autoDirect(fixture(), opts({ style: 'calm' }));
    expect(calm.transitions.every((x) => x.preset !== 'swoop' && x.preset !== 'whip-pan')).toBe(true);
    const over = autoDirect(fixture(), opts({ style: 'overhead' }));
    expect(over.keys.every((k) => k.elevation >= 70)).toBe(true);
  });
  it('everything it makes is marked automatic, sorted and linked', () => {
    const tr = autoDirect(fixture(), opts());
    expect(tr.keys.every((k) => k.origin === 'auto')).toBe(true);
    expect(tr.transitions.every((x) => x.origin === 'auto')).toBe(true);
    expect(tr.transitions).toHaveLength(tr.keys.length - 1);
    for (let i = 1; i < tr.keys.length; i++) expect(tr.keys[i].t).toBeGreaterThan(tr.keys[i - 1].t);
    expect(tr.style).toBe('reference');
  });
});

describe('frontAzimuth', () => {
  it('a model with most of its pieces on the back (a cape) still faces the LDraw front', () => {
    // the fixture's second half lands on the back (world −Z): a cape, not a face
    expect(frontAzimuth(fixture())).toBe(0);
  });
});

describe('mergeAuto', () => {
  const user = (id: string, t: number): CameraKey => ({ id, t, target: { kind: 'model' }, offset: [0, 0, 0], azimuth: 5, elevation: 30,
    distance: { fit: true, margin: 1.1 }, roll: 0, lensMm: 50, focus: 0.5, blur: 0, origin: 'user' });
  it('keeps keys you edited and clears automatic ones next to them', () => {
    const tl = fixture();
    const auto = autoDirect(tl, opts());
    const existing: CameraTrack = { ...auto, keys: [...auto.keys.filter((k) => Math.abs(k.t - 3) > 0.01), user('mine', 3)] };
    const merged = mergeAuto(existing, autoDirect(tl, opts()), 16);
    expect(merged.keys.find((k) => k.id === 'mine')).toEqual(user('mine', 3));
    expect(merged.keys.filter((k) => k.origin === 'auto' && Math.abs(k.t - 3) < 0.4)).toHaveLength(0);
    expect(merged.transitions).toHaveLength(merged.keys.length - 1);
  });
  it('keeps a move you edited that leaves your key', () => {
    const tl = fixture();
    const existing: CameraTrack = { keys: [user('mine', 3)], transitions: [], shutter: 0.5 };
    const auto = autoDirect(tl, opts());
    const after = auto.keys.find((k) => k.t > 3.4)!;
    existing.keys.push({ ...after, id: 'next' });
    existing.transitions = [{ from: 'mine', to: 'next', preset: 'cut', settings: { ...DEFAULT_TRANSITION, cut: true }, origin: 'user' }];
    const merged = mergeAuto(existing, auto, 16);
    expect(merged.transitions.find((x) => x.from === 'mine')!.preset).toBe('cut');
  });
  it('an automatic key you edited keeps its place when Auto-direct runs again: no two keys share an id', () => {
    const tl = fixture();
    const first = autoDirect(tl, opts());
    const edited = { ...first.keys[3], t: (first.keys[1].t + first.keys[2].t) / 2, azimuth: 77, origin: 'user' as const };
    const existing: CameraTrack = { ...first, keys: first.keys.map((k, i) => (i === 3 ? edited : k)) };
    const merged = mergeAuto(existing, autoDirect(tl, opts()), 16);
    const ids = merged.keys.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(merged.keys.filter((k) => k.azimuth === 77)).toHaveLength(1);
    expect(merged.keys.filter((k) => k.origin === 'auto' && Math.abs(k.t - edited.t) < 0.4)).toHaveLength(0);
    for (const x of merged.transitions) expect(ids).toContain(x.from);
    expect(merged.transitions).toHaveLength(merged.keys.length - 1);
  });
  it('moves a key of yours past the new end back to the end', () => {
    const merged = mergeAuto({ keys: [user('late', 50)], transitions: [], shutter: 0.5 }, autoDirect(fixture(), opts()), 16);
    expect(merged.keys.find((k) => k.id === 'late')!.t).toBe(16);
  });
});

/** Total azimuth the camera turns through between keys i..j, following each move's orbit direction. */
function turned(tr: CameraTrack, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) {
    const a = tr.keys[i].azimuth, b = tr.keys[i + 1].azimuth;
    const s = tr.transitions[i].settings;
    const pos = (((b - a) % 360) + 360) % 360;
    sum += s.orbit === 'cw' ? pos + 360 * s.extraTurns : s.orbit === 'ccw' ? -(pos === 0 ? 0 : 360 - pos) : pos > 180 ? pos - 360 : pos;
  }
  return sum;
}
const stretched = (k: number): Timeline => {
  const tl = fixture();
  for (const u of tl.units) { u.start = 1 + (u.start - 1) * k; u.dur *= k; }
  return { ...tl, buildEnd: 1 + (tl.buildEnd - 1) * k, duration: 1 + (tl.buildEnd - 1) * k + 2.5 } as Timeline;
};

describe('reference video styles', () => {
  it('Speed build (Megatron): swoops between sides, then a hard cut to a low front view for the last details', () => {
    const tl = fixture();
    const tr = autoDirect(tl, opts({ front: 0 }));
    const cutAt = tr.transitions.findIndex((x) => x.preset === 'cut');
    expect(cutAt).toBeGreaterThan(0);
    const after = tr.keys[cutAt + 1];
    expect(after.t).toBeGreaterThan(tl.intro + 0.7 * (tl.buildEnd - tl.intro));
    expect(after.t).toBeLessThan(tl.buildEnd);
    expect(angleGap(after.azimuth, 0)).toBeLessThanOrEqual(1);
    expect(after.elevation).toBeLessThanOrEqual(12);
    expect(tr.transitions.slice(0, cutAt).some((x) => x.preset === 'swoop')).toBe(true);
  });
  it('a big swing is always a quick move, never a slow one', () => {
    for (const style of ['reference', 'energetic'] as const) {
      const tr = autoDirect(stretched(3), opts({ style, front: 0 }));
      tr.transitions.forEach((x, i) => {
        const gap = angleGap(tr.keys[i].azimuth, tr.keys[i + 1].azimuth);
        const dt = tr.keys[i + 1].t - tr.keys[i].t;
        const moving = x.settings.turnLast ? Math.min(dt, x.settings.turnLast) : dt;
        if (gap > 60 && moving < 1.5 && !x.settings.cut) expect(['swoop', 'whip-pan', 'arc-reveal']).toContain(x.preset);
      });
    }
  });
  it('a long build gets swings all the way through, not one long glide', () => {
    const tr = autoDirect(stretched(20), opts({ front: 0 }));
    const quick = tr.transitions.filter((x) => x.preset === 'swoop').length;
    expect(quick).toBeGreaterThanOrEqual(7);
    const lastSwoop = tr.keys[tr.transitions.map((x) => x.preset).lastIndexOf('swoop')].t;
    expect(lastSwoop).toBeGreaterThan(1 + 0.6 * (stretched(20).buildEnd - 1));
    for (let i = 1; i < tr.keys.length; i++) expect(tr.keys[i].t - tr.keys[i - 1].t).toBeLessThan(30);
  });
  it('Turntable (KenBrick): turns most of the way round while building, faster towards the end, whips to the front and holds', () => {
    const tl = fixture();
    const tr = autoDirect(tl, opts({ style: 'turntable', front: 0 }));
    const whip = tr.transitions.findIndex((x) => x.preset === 'swoop');
    expect(whip).toBeGreaterThan(1);
    // the reference videos turn about 225° before the whip, not a full circle
    const total = turned(tr, 0, whip);
    expect(total).toBeGreaterThanOrEqual(180);
    expect(total).toBeLessThanOrEqual(300);
    // the turn speeds up: the last move of the turn covers far more than the first
    const first = tr.keys.findIndex((k) => k.t >= tl.intro - 1e-6);
    const speed = (i: number) => turned(tr, i, i + 1) / (tr.keys[i + 1].t - tr.keys[i].t);
    expect(speed(whip - 1)).toBeGreaterThan(2.5 * speed(first));
    expect(tr.transitions.slice(0, whip).every((x) => x.settings.flowThrough && x.settings.orbit === 'cw')).toBe(true);
    const front = tr.keys[whip + 1];
    expect(Math.abs(front.t - tl.buildEnd)).toBeLessThan(0.6);
    expect(angleGap(front.azimuth, 0)).toBeLessThanOrEqual(1);
    expect(angleGap(tr.keys[whip].azimuth, 0)).toBeGreaterThan(120);
    expect(tr.keys.at(-1)!.t).toBeCloseTo(tl.duration, 6);
    expect(angleGap(tr.keys.at(-1)!.azimuth, 0)).toBeLessThanOrEqual(1);
  });
  it('Turntable frames the whole finished model from the start, so the build grows into a still frame', () => {
    const tr = autoDirect(fixture(), opts({ style: 'turntable', front: 0 }));
    for (const k of tr.keys) expect(k.target).toEqual({ kind: 'model' });
    const margins = new Set(tr.keys.slice(0, -1).map((k) => k.distance.fit && k.distance.margin));
    expect(margins.size).toBe(1);
    expect(tr.keys[0].elevation).toBeGreaterThanOrEqual(33);
    expect(tr.keys[0].elevation).toBeLessThanOrEqual(42);
  });
  it('a long build stays easy to edit: few keys, never bunched together', () => {
    for (const style of ['reference', 'showcase', 'turntable', 'calm', 'energetic', 'overhead'] as const) {
      for (const k of [1, 5, 10, 20]) {
        const tr = autoDirect(stretched(k), opts({ style, front: 0 }));
        expect(tr.keys.length, `${style} ×${k}`).toBeLessThanOrEqual(26);
        for (let i = 1; i < tr.keys.length; i++) expect(tr.keys[i].t - tr.keys[i - 1].t, `${style} ×${k} key ${i}`).toBeGreaterThanOrEqual(0.5);
      }
    }
  });
  it('a swing is one key: the move into it holds the view, then turns round quickly at the end', () => {
    const tr = autoDirect(stretched(5), opts({ front: 0 }));
    const late = tr.transitions.filter((x) => x.preset === 'swoop' && x.settings.turnLast);
    expect(late.length).toBeGreaterThanOrEqual(3);
    for (const x of late) expect(x.settings.turnLast).toBeLessThanOrEqual(1);
  });
  it('Turntable keeps turning on a long build instead of crawling', () => {
    const tr = autoDirect(stretched(10), opts({ style: 'turntable', front: 0 }));
    const whip = tr.transitions.findIndex((x) => x.preset === 'swoop');
    expect(turned(tr, 0, whip)).toBeGreaterThanOrEqual(360 * 4);
  });
  it('Showcase orbit (Doctor Doom): circles round the back while building, then cuts to a low front view', () => {
    const tl = fixture();
    const tr = autoDirect(tl, opts({ style: 'showcase', front: 0 }));
    const cutAt = tr.transitions.findIndex((x) => x.preset === 'cut');
    expect(cutAt).toBeGreaterThan(0);
    const orbitFrom = tr.transitions.findIndex((x) => x.settings.flowThrough);
    expect(orbitFrom).toBeGreaterThanOrEqual(0);
    expect(Math.abs(turned(tr, orbitFrom, cutAt))).toBeGreaterThanOrEqual(150);
    const after = tr.keys[cutAt + 1];
    expect(angleGap(after.azimuth, 0)).toBeLessThanOrEqual(1);
    expect(after.elevation).toBeLessThanOrEqual(12);
  });
  it('every style keeps the landing pieces in frame', () => {
    const tl = fixture();
    const ctx = ctxFor(tl);
    for (const style of ['turntable', 'showcase'] as const) {
      const tr = autoDirect(tl, opts({ style, front: 0 }));
      for (const u of tl.units) expect(inFrame(tr, ctx, landT(u), worldBox3(u.land!))).toBe(true);
    }
  });
});
