/**
 * COLLADA 1.4.1 export: the finished model, or the build animation as sampled
 * keyframes, in a standard .dae any DCC tool (Blender, three.js, Studio) can open.
 *
 * Coordinates: the app's world is studs, +Y up (bricks.ts applies rotX(π) and a
 * 1/20 scale to the LDraw coordinate geometry). The exporter writes the scene in
 * LDU like Studio's own .dae (one stud = 20 units, `<unit name="LDU" meter="0.04"/>`):
 * EyeSight's materials carry absolute-size bump/noise values tuned for that scale, and
 * a stud-sized scene makes them dent every flat face. Camera options stay in studs and
 * are scaled to LDU here.
 *
 * Colour roles: a part's geometry is shared by every instance, but the main faces
 * take the piece's own colour. Triangle groups are therefore bound by role
 * ("main", "fixed_0", …) and each instance maps those roles to its colours —
 * binding by colour code would make every instance of a part share the first
 * instance's colour.
 */
import * as THREE from 'three';
import { materialName, type ColorDef } from '../ldraw/colors';
import type { PartGeometry } from '../ldraw/geometry';

export type ColladaPiece = { key: string; part: string; color: number | string; world: THREE.Matrix4 };

export type ColladaCamera = { position: THREE.Vector3; target: THREE.Vector3; fov: number; near: number; far: number; width: number; height: number; /** Dutch tilt about the view axis, degrees */ roll?: number };

export type ColladaLight = {
  name?: string;
  /** `ambient` has no direction (Studio's "Hemi.003" fill); default `directional` */
  type?: 'directional' | 'ambient';
  /** subject→lamp, app world (Y up); ignored for ambient */
  dir: readonly [number, number, number];
  size: number;
  intensity: number;
};

export type ColladaAnimation = {
  fps: number;
  duration: number;
  /** The pose of every piece key at `t` seconds; null hides it. */
  sample(t: number): Map<string, THREE.Matrix4 | null>;
};

export type ColladaOptions = {
  name: string;
  pieces: readonly ColladaPiece[];
  geometryOf: (part: string) => PartGeometry | null;
  colors: ReadonlyMap<number, ColorDef>;
  camera?: ColladaCamera;
  lights?: readonly ColladaLight[];
  animation?: ColladaAnimation;
  /** Studio's exporter writes row-major matrices; standard tools expect column-major. */
  matrixOrder?: 'column' | 'row';
};

/** Scene units per stud: Studio writes LDU (20 per stud). */
export const SCENE_UNITS_PER_STUD = 20;
/** The app's LDraw (Y-down, LDU) → world (+Y up) root; units stay LDU. */
const ROOT = new THREE.Matrix4().makeRotationX(Math.PI);

const num = (v: number) => (Math.abs(v) < 1e-6 ? 0 : Number(v.toFixed(6)));

/** COLLADA matrix text. Column-major (spec) unless `order` says row-major (Studio/EyeSight). */
export function matrixText(m: THREE.Matrix4, order: 'column' | 'row' = 'column'): string {
  const e = m.elements;
  const values = order === 'row'
    ? [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], e[3], e[7], e[11], e[15]]
    : [e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], e[9], e[10], e[11], e[12], e[13], e[14], e[15]];
  return values.map(num).join(' ');
}

const xml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const idSafe = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, '_');

export { materialName };

const FALLBACK: ColorDef = { code: 71, name: 'Light_Bluish_Grey', hex: '#A0A5A9', edge: '#333333', alpha: 255, finish: 'solid' };

/** One colour role of a part: `color` null means "the piece's own colour". */
type Group = { symbol: string; color: ColorDef | null; positions: number[]; normals: number[]; indices: number[] };

/** Appends one BufferGeometry's triangles (positions and its own creased normals). */
function appendGeometry(group: Group, geo: THREE.BufferGeometry) {
  const pos = geo.getAttribute('position');
  if (!pos) return;
  const nrm = geo.getAttribute('normal');
  const base = group.positions.length / 3;
  for (let i = 0; i < pos.count; i++) {
    group.positions.push(num(pos.getX(i)), num(pos.getY(i)), num(pos.getZ(i)));
    group.normals.push(nrm ? num(nrm.getX(i)) : 0, nrm ? num(nrm.getY(i)) : 0, nrm ? num(nrm.getZ(i)) : 0);
  }
  const index = geo.getIndex();
  if (index) for (let i = 0; i < index.count; i++) group.indices.push(base + index.getX(i));
  else for (let i = 0; i < pos.count; i++) group.indices.push(base + i);
}

/** A part's geometry as colour roles: main faces, double-sided faces and fixed-colour faces. */
function partGroups(id: string, geometryOf: (p: string) => PartGeometry | null, colors: ReadonlyMap<number, ColorDef>): Group[] {
  const geom = geometryOf(id);
  if (!geom) return [];
  const groups: Group[] = [];
  const add = (symbol: string, color: ColorDef | null, geo: THREE.BufferGeometry | null) => {
    if (!geo) return;
    const g: Group = { symbol, color, positions: [], normals: [], indices: [] };
    appendGeometry(g, geo);
    if (g.indices.length) groups.push(g);
  };
  add('main', null, geom.main);
  add('main_ds', null, geom.mainDoubleSided);
  geom.fixed.forEach((fixed, i) => {
    // colour 16 inside a part means "the piece's colour", exactly as the app draws it
    const color = fixed.color === 16 ? null : colors.get(fixed.color) ?? FALLBACK;
    add(`fixed_${i}`, color, fixed.geometry);
  });
  return groups;
}

/** The camera node matrix for a look-at pose in the app world. */
export function cameraMatrix(cam: Pick<ColladaCamera, 'position' | 'target' | 'roll'>): THREE.Matrix4 {
  const m = new THREE.Matrix4().lookAt(cam.position, cam.target, new THREE.Vector3(0, 1, 0));
  if (cam.roll) m.multiply(new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(cam.roll)));
  m.setPosition(cam.position.clone().multiplyScalar(SCENE_UNITS_PER_STUD));
  return m;
}

/** Builds the COLLADA document. Pure: no DOM, no filesystem — testable and reusable by the CLI renderer. */
export function buildCollada(opts: ColladaOptions): string {
  const order = opts.matrixOrder ?? 'column';
  const pieces = opts.pieces;
  const pieceColorOf = (p: ColladaPiece): ColorDef => {
    const code = typeof p.color === 'string' ? Number(p.color) : p.color;
    // 16 = "main colour": the app draws it as light bluish grey (DEFAULT_COLOR)
    return opts.colors.get(code === 16 ? 71 : code) ?? FALLBACK;
  };

  // geometry per part (shared); each instance binds the roles to its own colours
  const parts = new Map<string, Group[]>();
  const colorDefs = new Map<number, ColorDef>();
  for (const p of pieces) {
    const pieceColor = pieceColorOf(p);
    colorDefs.set(pieceColor.code, pieceColor);
    let groups = parts.get(p.part);
    if (!groups) parts.set(p.part, (groups = partGroups(p.part, opts.geometryOf, opts.colors)));
    for (const g of groups) if (g.color) colorDefs.set(g.color.code, g.color);
  }

  const geometries: string[] = [];
  for (const [part, groups] of parts) {
    if (!groups.length) continue;
    const gid = `Part-${idSafe(part)}`;
    const positions: number[] = [];
    const normals: number[] = [];
    const index: number[] = [];
    const triangleGroups: string[] = [];
    for (const g of groups) {
      const start = index.length;
      const base = positions.length / 3;
      positions.push(...g.positions);
      normals.push(...g.normals);
      // a missing normal falls back to the face normal so every reader shades the part
      for (let t = 0; t < g.indices.length; t += 3) {
        const ia = g.indices[t], ib = g.indices[t + 1], ic = g.indices[t + 2];
        const flat = [ia, ib, ic].some((i) => g.normals[i * 3] === 0 && g.normals[i * 3 + 1] === 0 && g.normals[i * 3 + 2] === 0);
        if (flat) {
          const a = [g.positions[ia * 3], g.positions[ia * 3 + 1], g.positions[ia * 3 + 2]];
          const b = [g.positions[ib * 3], g.positions[ib * 3 + 1], g.positions[ib * 3 + 2]];
          const c = [g.positions[ic * 3], g.positions[ic * 3 + 1], g.positions[ic * 3 + 2]];
          const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
          let nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
          const len = Math.hypot(nx, ny, nz) || 1;
          for (const i of [ia, ib, ic]) {
            normals[(base + i) * 3] = num(nx / len);
            normals[(base + i) * 3 + 1] = num(ny / len);
            normals[(base + i) * 3 + 2] = num(nz / len);
          }
        }
        index.push(base + ia, base + ib, base + ic);
      }
      triangleGroups.push(`<triangles count="${(index.length - start) / 3}" material="${g.symbol}"><input semantic="VERTEX" source="#${gid}-vert" offset="0"/><input semantic="NORMAL" source="#${gid}-norm" offset="0"/><p>${index.slice(start).join(' ')}</p></triangles>`);
    }
    geometries.push(`<geometry id="${gid}" name="${gid}"><mesh>
<source id="${gid}-pos"><float_array id="${gid}-pos-array" count="${positions.length}">${positions.join(' ')}</float_array>
<technique_common><accessor count="${positions.length / 3}" source="#${gid}-pos-array" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
<source id="${gid}-norm"><float_array id="${gid}-norm-array" count="${normals.length}">${normals.join(' ')}</float_array>
<technique_common><accessor count="${normals.length / 3}" source="#${gid}-norm-array" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
<vertices id="${gid}-vert"><input semantic="POSITION" source="#${gid}-pos"/></vertices>
${triangleGroups.join('\n')}
</mesh></geometry>`);
  }

  const effects: string[] = [];
  const materials: string[] = [];
  for (const c of [...colorDefs.values()].sort((a, b) => a.code - b.code)) {
    const mid = `material_${c.code}`;
    const h = c.hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => num(parseInt(h.slice(i, i + 2), 16) / 255));
    const op = num(c.alpha / 255);
    materials.push(`<material id="${mid}" name="${xml(materialName(c))}"><instance_effect url="#${mid}-fx"/></material>`);
    effects.push(`<effect id="${mid}-fx"><profile_COMMON><technique sid="common"><phong>
<emission><color sid="emission">0 0 0 1</color></emission><ambient><color sid="ambient">0 0 0 1</color></ambient>
<diffuse><color sid="diffuse">${r} ${g} ${b} 1</color></diffuse><specular><color sid="specular">0.5 0.5 0.5 1</color></specular>
<shininess><float sid="shininess">16</float></shininess><reflective><color sid="reflective">0 0 0 1</color></reflective>
<transparent><color sid="transparent">${op} ${op} ${op} 1</color></transparent><transparency><float sid="transparency">1</float></transparency>
<index_of_refraction><float sid="index_of_refraction">0</float></index_of_refraction>
</phong></technique></profile_COMMON></effect>`);
  }

  const nodeId = (p: ColladaPiece, i: number) => `piece_${i}`;
  const world = (p: ColladaPiece) => ROOT.clone().multiply(p.world);
  const nodes = pieces.map((p, i) => {
    const groups = parts.get(p.part) ?? [];
    if (!groups.length) return '';
    const pieceColor = pieceColorOf(p);
    // each instance maps the shared geometry's roles to its own colours
    const binds = groups.map((g) => `<instance_material symbol="${g.symbol}" target="#material_${(g.color ?? pieceColor).code}"/>`).join('');
    return `<node id="${nodeId(p, i)}" name="${xml(p.part)}"><matrix sid="matrix">${matrixText(world(p), order)}</matrix>
<instance_geometry url="#Part-${idSafe(p.part)}"><bind_material><technique_common>${binds}</technique_common></bind_material></instance_geometry></node>`;
  }).filter(Boolean);

  let cameraXml = '';
  if (opts.camera) {
    const cam = opts.camera;
    const aspect = cam.width / cam.height;
    const xfov = 2 * Math.atan(Math.tan((cam.fov * Math.PI) / 360) * aspect) * (180 / Math.PI);
    cameraXml = `<library_cameras><camera id="camera_main"><optics><technique_common><perspective>
<aspect_ratio>${num(aspect)}</aspect_ratio><xfov>${num(xfov)}</xfov><znear>${num(cam.near * SCENE_UNITS_PER_STUD)}</znear><zfar>${num(cam.far * SCENE_UNITS_PER_STUD)}</zfar>
</perspective></technique_common></optics><extra><technique profile="eyesight"><resolution_x type="int">${cam.width}</resolution_x><resolution_y type="int">${cam.height}</resolution_y></technique></extra></camera></library_cameras>`;
  }

  const lights = (opts.lights ?? []).map((l, i) => {
    const dir = new THREE.Vector3(...l.dir).normalize();
    const m = new THREE.Matrix4().lookAt(dir.clone().multiplyScalar(1000), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
    m.setPosition(dir.clone().multiplyScalar(1000));
    return { i, m };
  });
  const lightLib = lights.length
    ? `<library_lights>${lights.map(({ i }) => `<light id="light_${i}"><technique_common>${opts.lights![i].type === 'ambient' ? '<ambient><color>1 1 1</color></ambient>' : '<directional><color>1 1 1</color></directional>'}</technique_common><extra><technique profile="eyesight"><size>${num(opts.lights![i].size)}</size><intensity>${num(opts.lights![i].intensity)}</intensity></technique></extra></light>`).join('')}</library_lights>`
    : '';
  // Studio's light nodes carry these eyesight settings; without them the direct lights are not sampled
  const lightNodes = lights.map(({ i, m }) => `<node id="Light_${i}" name="${xml(opts.lights![i].name ?? `Light ${i + 1}`)}" type="NODE"><matrix sid="matrix">${matrixText(m, order)}</matrix><instance_light url="#light_${i}"/>
<extra><technique profile="eyesight"><cast_shadow sid="cast_shadow" type="bool">1</cast_shadow><use_mis sid="use_mis" type="bool">1</use_mis><max_bounces sid="max_bounces" type="int">1024</max_bounces><samples sid="samples" type="int">1</samples></technique></extra></node>`).join('\n');

  // --- animation: one sampled matrix channel per piece ----------------------
  let animationsXml = '';
  if (opts.animation) {
    const { fps, duration, sample } = opts.animation;
    const frames = Math.max(2, Math.round(duration * fps) + 1);
    const times: number[] = [];
    for (let f = 0; f < frames; f++) times.push(num(Math.min(duration, f / fps)));
    // sample every piece, then keep only the channels that actually move
    const tracks = new Map<number, { id: string; matrices: THREE.Matrix4[] }>();
    for (let f = 0; f < frames; f++) {
      const pose = sample(times[f]);
      pieces.forEach((p, i) => {
        if (!parts.get(p.part)?.length) return;
        let track = tracks.get(i);
        if (!track) tracks.set(i, (track = { id: nodeId(p, i), matrices: [] }));
        const m = pose.get(p.key);
        // a piece that has not appeared yet collapses to a point where it stands: parking it far away
        // would drag EyeSight's shadow-catcher floor (placed under the scene's lowest point) with it
        const mat = m ? ROOT.clone().multiply(m) : world(p).multiply(new THREE.Matrix4().makeScale(1e-5, 1e-5, 1e-5));
        track.matrices.push(mat);
      });
    }
    const moving: string[] = [];
    for (const [i, track] of tracks) {
      const first = track.matrices[0].elements;
      if (track.matrices.every((m) => m.elements.every((v, k) => Math.abs(v - first[k]) < 1e-6))) continue;
      const inputId = `anim_${i}-input`;
      const outputId = `anim_${i}-output`;
      moving.push(`<animation id="anim_${i}"><source id="${inputId}"><float_array id="${inputId}-array" count="${frames}">${times.join(' ')}</float_array>
<technique_common><accessor count="${frames}" source="#${inputId}-array" stride="1"><param name="TIME" type="float"/></accessor></technique_common></source>
<source id="${outputId}"><float_array id="${outputId}-array" count="${frames * 16}">${track.matrices.map((m) => matrixText(m, order)).join(' ')}</float_array>
<technique_common><accessor count="${frames}" source="#${outputId}-array" stride="16"><param name="TRANSFORM" type="float4x4"/></accessor></technique_common></source>
<sampler id="anim_${i}-sampler"><input semantic="INPUT" source="#${inputId}"/><input semantic="OUTPUT" source="#${outputId}"/><input semantic="INTERPOLATION" source="#anim_interp"/></sampler>
<channel source="#anim_${i}-sampler" target="${track.id}/matrix"/></animation>`);
    }
    if (moving.length) {
      animationsXml = `<library_animations><source id="anim_interp"><Name_array id="anim_interp-values" count="1">LINEAR</Name_array>
<technique_common><accessor count="1" source="#anim_interp-values" stride="1"><param name="INTERPOLATION" type="name"/></accessor></technique_common></source>
${moving.join('\n')}</library_animations>`;
    }
  }

  const cameraNode = opts.camera
    ? `<node id="Camera_Node" name="Camera_Node" type="NODE"><matrix sid="matrix">${matrixText(cameraMatrix(opts.camera), order)}</matrix><instance_camera url="#camera_main"/></node>`
    : '';

  return `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
<asset><created>${new Date().toISOString()}</created><modified>${new Date().toISOString()}</modified><unit name="LDU" meter="0.04"/><up_axis>Y_UP</up_axis></asset>
${cameraXml}
${lightLib}
<library_effects>${effects.join('\n')}</library_effects>
<library_materials>${materials.join('\n')}</library_materials>
<library_geometries>${geometries.join('\n')}</library_geometries>
${animationsXml}
<library_visual_scenes><visual_scene id="Scene" name="${xml(opts.name)}">
${nodes.join('\n')}
${cameraNode}
${lightNodes}
</visual_scene></library_visual_scenes>
<scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>`;
}
