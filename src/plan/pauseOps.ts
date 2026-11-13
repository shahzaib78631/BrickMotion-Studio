import { MAX_PAUSE, MIN_PAUSE, normalizePauses } from '../anim/pauses';
import { relink } from '../anim/cameraTrack/ops';
import type { CameraKey } from '../anim/cameraTrack/types';
import type { Pause, Plan } from './types';

type ModelName = string;
let counter = 0;
const newId = () => `pause-${Date.now().toString(36)}-${(counter++).toString(36)}`;
const round = (n: number) => Math.round(n * 100) / 100;

export const pausesOf = (p: Plan, m: ModelName): Pause[] => normalizePauses(p.pauses?.[m] ?? []);

function setPauses(p: Plan, m: ModelName, list: Pause[]): Plan {
  const { [m]: _gone, ...rest } = p.pauses ?? {};
  const pauses = list.length ? { ...rest, [m]: list } : rest;
  if (!Object.keys(pauses).length) {
    const { pauses: _p, ...plan } = p;
    return plan as Plan;
  }
  return { ...p, pauses };
}

/** Everything on the video after `from` moves by `by` seconds, like a ripple edit; the camera keys of the Build video follow. */
function ripple(p: Plan, m: ModelName, from: number, by: number): Plan {
  const track = p.cameraTracks?.[m]?.build;
  if (!track || !track.keys.length || !by) return p;
  const moved: CameraKey[] = track.keys.map((k) => (k.t > from + 1e-9 ? { ...k, t: Math.max(0, round(k.t + by)) } : k)).sort((a, b) => a.t - b.t);
  // keep times unique
  for (let i = 1; i < moved.length; i++) if (moved[i].t <= moved[i - 1].t) moved[i] = { ...moved[i], t: round(moved[i - 1].t + 0.01) };
  return { ...p, cameraTracks: { ...p.cameraTracks, [m]: { ...p.cameraTracks![m], build: { ...track, keys: moved, transitions: relink(moved, track.transitions) } } } };
}

/** A pause of `len` seconds at video time `at`. A time inside an existing pause is moved to its end. Returns the new id too. */
export function addPause(p: Plan, m: ModelName, at: number, len = 1): { plan: Plan; id: string | null } {
  const list = pausesOf(p, m);
  const hit = list.find((x) => at > x.at - 1e-9 && at < x.at + x.len - 1e-9);
  const start = round(Math.max(0, hit ? hit.at + hit.len : at));
  const length = round(Math.min(MAX_PAUSE, Math.max(MIN_PAUSE, len)));
  const id = newId();
  // later pauses move out of the way
  const next = [...list.map((x) => (x.at >= start - 1e-9 ? { ...x, at: round(x.at + length) } : x)), { id, at: start, len: length }];
  return { plan: ripple(setPauses(p, m, normalizePauses(next)), m, start, length), id };
}

/** Changes a pause's length; what comes after moves with it. */
export function setPauseLength(p: Plan, m: ModelName, id: string, len: number): Plan {
  const list = pausesOf(p, m);
  const cur = list.find((x) => x.id === id);
  if (!cur) return p;
  const length = round(Math.min(MAX_PAUSE, Math.max(MIN_PAUSE, len)));
  const delta = round(length - cur.len);
  if (!delta) return p;
  const next = list.map((x) => (x.id === id ? { ...x, len: length } : x.at > cur.at ? { ...x, at: round(x.at + delta) } : x));
  return ripple(setPauses(p, m, next), m, cur.at + Math.min(cur.len, length), delta);
}

/** Removes a pause; what came after moves back. */
export function removePause(p: Plan, m: ModelName, id: string): Plan {
  const list = pausesOf(p, m);
  const cur = list.find((x) => x.id === id);
  if (!cur) return p;
  const next = list.filter((x) => x.id !== id).map((x) => (x.at > cur.at ? { ...x, at: round(x.at - cur.len) } : x));
  return ripple(setPauses(p, m, next), m, cur.at, -cur.len);
}
