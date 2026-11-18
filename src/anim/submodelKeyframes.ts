import * as THREE from 'three';
import { transformBox, unionBox, type Assembly } from '../model/assemble';
import type { KeyframeAnimation, ObjectAnimationTrack } from '../plan/types';
import { valuesAt } from './keyframes';
import { displayPivot, keyframeDelta } from './keyframePose';
import type { Timeline } from './timeline';

/** Exclude the constant floor/outro keys written by Bake. Values are in studs/degrees. */
export function flightFrameRange(track: ObjectAnimationTrack): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (const [channel, keys] of Object.entries(track.channels)) {
    if (channel === 'visibility' || !keys) continue;
    for (let i = 1; i < keys.length; i++) {
      if (Math.abs(keys[i].value - keys[i - 1].value) < .001) continue;
      lo = Math.min(lo, keys[i - 1].frame);
      hi = Math.max(hi, keys[i].frame);
    }
  }
  return hi > lo ? [lo, hi] : null;
}

/** Compose baked child flights over an existing parent plan. Never starts planning.
 * The child keys already contain easing; sample them with a linear clock once.
 * Later rigid attachment moves remain owned by the parent timeline. */
export function applySubmodelKeyframes(
  timeline: Timeline, animation: KeyframeAnimation | undefined, model: string,
  assemblyFor: (name: string) => Assembly,
): Timeline {
  if (!animation?.tracks.length || !timeline.subBuilds.length) return timeline;
  const explicit = new Set(animation.tracks.filter(t => t.model === model).map(t => t.target));
  const sources = new Map<string, Assembly>();
  const tracks = new Map(timeline.tracks);
  const units = timeline.units.slice();
  let buildBox = timeline.buildBox, sceneBox = timeline.sceneBox;
  const subBuilds = timeline.subBuilds.map(sb => ({ ...sb }));
  let changed = false;
  // Parent bakes first; a deeper submodel's own edited keys win over them.
  for (const sb of [...subBuilds].sort((a, b) => a.key.split('/').length - b.key.split('/').length)) {
    const baked = animation.tracks.filter(t => t.model === sb.name && t.source === 'baked-flight');
    if (!baked.length) continue;
    let assembly = sources.get(sb.name);
    if (!assembly) sources.set(sb.name, assembly = assemblyFor(sb.name));
    const instances = new Map(assembly.instances.map(inst => [inst.key, inst]));
    for (const bakedTrack of baked) {
      const key = `${sb.key}/${bakedTrack.target}`;
      if (explicit.has(key)) continue;
      const tr = tracks.get(key), inst = instances.get(bakedTrack.target);
      const move = tr?.moves[0];
      const range = flightFrameRange(bakedTrack);
      if (!tr || !inst || !move || move.stationary || !range) continue;
      // A leaf baked with additional nested attachment moves includes those
      // transports too. Only direct leaves describe one complete piece flight.
      if (bakedTrack.target.includes('/')) continue;
      const seat = move.rel ? move.to.clone().multiply(move.rel) : move.to;
      const frame = seat.clone().multiply(inst.world.clone().invert());
      const pivot = displayPivot(inst, inst.world);
      const [lo, hi] = range;
      const count = Math.min(4096, Math.max(32, Math.ceil((hi - lo) * 16)));
      const relInv = move.rel?.clone().invert();
      let box = transformBox(inst.worldBox, frame);
      const poses: THREE.Matrix4[] = [];
      for (let i = 0; i <= count; i++) {
        const v = valuesAt(animation, sb.name, inst.key, lo + (hi - lo) * i / count);
        const delta = frame.clone().multiply(keyframeDelta(v, pivot));
        box = unionBox(box, transformBox(inst.worldBox, delta));
        const pose = delta.multiply(inst.world);
        poses.push(relInv ? pose.multiply(relInv) : pose);
      }
      // The installed seat and later transports are exact parent poses.
      poses[count] = move.to.clone();
      const floor = move.rel ? poses[0].clone().multiply(move.rel) : poses[0].clone();
      const floorDelta = frame.clone().multiply(keyframeDelta(valuesAt(animation, sb.name, inst.key, lo), pivot));
      tracks.set(key, { ...tr, floor, floorBox: transformBox(inst.worldBox, floorDelta),
        moves: [{ ...move, from: poses[0], posePath: poses, hold: 0, style: { ease: 'linear' },
          translationPath: undefined, kinematicSegments: undefined, rigidDeltas: undefined,
          rigidBase: undefined, rigidPivot: undefined }, ...tr.moves.slice(1)] });
      units[move.unit] = { ...units[move.unit], uncertified: true,
        box: unionBox(units[move.unit].box ?? box, box) };
      sb.focus = unionBox(sb.focus, box);
      buildBox = unionBox(buildBox, box);
      sceneBox = unionBox(sceneBox, box);
      changed = true;
    }
  }
  return changed ? { ...timeline, tracks, units, subBuilds, buildBox, sceneBox,
    camKeys: timeline.camKeys.map(k => ({ ...k, box: subBuilds.reduce((box, sb) =>
      k.t >= sb.start - 1 && k.t <= sb.attachEnd + 1 ? unionBox(box, sb.focus) : box, k.box) })) } : timeline;
}
