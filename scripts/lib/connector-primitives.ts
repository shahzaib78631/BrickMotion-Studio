import { Matrix4, Vector3 } from 'three';
import { normalizeName, type LDrawFile, type Vec3 } from '../../src/ldraw/parse';

export type PrimitiveSurface = {
  primitive: string; path: string[]; start: Vec3; end: Vec3;
  axis: Vec3; side: Vec3; radius: number; length: number;
  surface: 'inner' | 'outer';
};

/** Measure full circular cylinders in arbitrary composed frames. These are
 * surface observations, not certified sockets: ends may be obstructed. */
export function connectorPrimitives(root: LDrawFile, lookup: (name: string) => LDrawFile | null) {
  const cylinders: PrimitiveSurface[] = [];
  const studs: { base: Vec3; tip: Vec3; radius: number; path: string[] }[] = [];
  const rejected: { path: string[]; reason: string }[] = [];
  const walk = (file: LDrawFile, world: Matrix4, inverted: boolean, path: string[], depth: number) => {
    if (depth > 32) return;
    for (const cmd of file.cmds) {
      if (cmd.t !== 'ref') continue;
      const name = normalizeName(cmd.file), plain = name.split('/').pop()!;
      const next = [...path, name];
      if (path.includes(name)) continue;
      const m = cmd.m, p = cmd.pos;
      const transform = world.clone().multiply(new Matrix4().set(
        m[0], m[1], m[2], p[0], m[3], m[4], m[5], p[1],
        m[6], m[7], m[8], p[2], 0, 0, 0, 1));
      const inside = inverted !== cmd.invert;
      const child = lookup(name);
      if (!child) continue;
      const cylinder = /^(?:4-4|16-16|48-48)cyli\.dat$/.test(plain);
      const stud = /^(?:stud|stud2|stud2a)\.dat$/.test(plain);
      if (cylinder || stud) {
        const e = transform.elements;
        const x = new Vector3(e[0], e[1], e[2]);
        const y = new Vector3(e[4], e[5], e[6]);
        const z = new Vector3(e[8], e[9], e[10]);
        const rx = x.length(), ry = y.length(), rz = z.length();
        const orthogonal = rx > 1e-8 && ry > 1e-8 && rz > 1e-8 &&
          Math.abs(rx - rz) < 1e-6 * Math.max(rx, rz) &&
          Math.abs(x.dot(y)) < 1e-6 * rx * ry &&
          Math.abs(z.dot(y)) < 1e-6 * rz * ry && Math.abs(x.dot(z)) < 1e-6 * rx * rz;
        if (!orthogonal) rejected.push({ path: next, reason: 'Non-circular, degenerate or sheared frame' });
        else {
          const origin = new Vector3().applyMatrix4(transform);
          if (cylinder) cylinders.push({ primitive: name, path: next,
            start: origin.toArray(), end: origin.clone().add(y).toArray(),
            axis: y.clone().normalize().toArray(), side: x.normalize().toArray(),
            radius: rx, length: ry, surface: inside ? 'inner' : 'outer' });
          if (stud && !inside) studs.push({ base: origin.toArray(),
            tip: new Vector3(0, -4, 0).applyMatrix4(transform).toArray(), radius: 6 * rx, path: next });
        }
      }
      // Keep nested cylinder observations; duplicate stud sites are removed below.
      walk(child, transform, inside, next, depth + 1);
    }
  };
  walk(root, new Matrix4(), false, [root.name], 0);
  const uniqueStuds = studs.filter((s, i) => studs.findIndex(t =>
    Math.hypot(...s.base.map((v, k) => v - t.base[k])) < 1e-6 &&
    Math.hypot(...s.tip.map((v, k) => v - t.tip[k])) < 1e-6 && Math.abs(s.radius - t.radius) < 1e-6) === i);
  return { studs: uniqueStuds, cylinders, rejected };
}
