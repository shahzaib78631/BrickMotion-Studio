/**
 * An independent check of a planned timeline (diagnostics only): every flight is sampled and
 * the moving piece's mesh is tested against the pieces already resting, with the drag
 * placement's collision world. The last 4.5 LDU of each flight (stud and pin engagement) are
 * not tested. Returns one line per flight that enters another piece.
 */
import * as THREE from 'three';
import type { Assembly, Metrics } from '../../src/model/assemble';
import { poseAt, type Timeline } from '../../src/anim/timeline';
import { collisionWorld } from '../../src/plan/collision';

export type FlightHit = { key: string; part: string; unit: number; uncertified: boolean; entry: number[]; obstacles: { key: string; part: string; out: number }[] };

export function flightHits(tl: Timeline, asm: Assembly, metrics: Metrics, samples = 40, near = 4.5): FlightHit[] {
  const byKey = new Map(asm.instances.map((i) => [i.key, i]));
  const solid = (key: string, m: THREE.Matrix4) => {
    const g = metrics(byKey.get(key)!.part);
    return { id: key, world: m.elements, body: g.body, studs: g.studs, snaps: g.snaps, mesh: g.mesh };
  };
  const doneAt = new Map<string, number>();
  for (const [k, tr] of tl.tracks) {
    const last = tr.moves[tr.moves.length - 1];
    doneAt.set(k, last ? tl.units[last.unit].start + tl.units[last.unit].dur : 0);
  }
  const out: FlightHit[] = [];
  for (const [key, tr] of tl.tracks) {
    const inst = byKey.get(key);
    if (!inst || inst.placeholder) continue;
    for (const mv of tr.moves) {
      const u = tl.units[mv.unit];
      const hits = new Map<string, number>();
      for (let s = 0; s <= samples; s++) {
        const t = u.start + (u.dur * s) / samples;
        const pose = poseAt(tl, t);
        const mine = pose(key);
        if (!mine) continue;
        const f = tr.final.elements, e = mine.elements;
        const d = Math.hypot(e[12] - f[12], e[13] - f[13], e[14] - f[14]);
        if (d < near) continue;
        const rest = [];
        for (const [k2] of tl.tracks) {
          if (k2 === key || u.keys.includes(k2) || !byKey.has(k2) || byKey.get(k2)!.placeholder) continue;
          const p2 = pose(k2);
          if (p2 && doneAt.get(k2)! <= t) rest.push(solid(k2, p2));
        }
        for (const h of collisionWorld(rest).hits([solid(key, mine)], undefined, false)) hits.set(h, Math.max(hits.get(h) ?? 0, Math.round(d)));
      }
      if (hits.size) out.push({ key, part: inst.part, unit: mv.unit, uncertified: !!u.uncertified, entry: mv.entry.map((v) => +v.toFixed(1)),
        obstacles: [...hits].map(([k, n]) => ({ key: k, part: byKey.get(k)!.part, out: n })) });
    }
  }
  return out;
}
