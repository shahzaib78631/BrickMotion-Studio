import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildCollada, matrixText, materialName, type ColladaPiece } from '../../src/export/collada';
import type { PartGeometry } from '../../src/ldraw/geometry';
import type { ColorDef } from '../../src/ldraw/colors';

const RED: ColorDef = { code: 4, name: 'Red', hex: '#C91A09', edge: '#333', alpha: 255, finish: 'solid' };
const BLACK: ColorDef = { code: 0, name: 'Black', hex: '#1B2A34', edge: '#333', alpha: 255, finish: 'solid' };
const colors = new Map<number, ColorDef>([[4, RED], [0, BLACK]]);

const square = (z: number) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, z, 20, 0, z, 20, 20, z, 0, 20, z,
  ], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
};

const geometry = (): PartGeometry => ({
  main: square(0),
  mainDoubleSided: null,
  fixed: [{ color: 0, geometry: square(-24), doubleSided: false }],
  edges: null,
});

const piece = (key: string, part: string, color: number, x: number): ColladaPiece => ({
  key, part, color, world: new THREE.Matrix4().makeTranslation(x, 0, 0),
});

const base = {
  name: 'Test',
  pieces: [piece('a', '3001', 4, 0), piece('b', '3001', 4, 40)],
  geometryOf: () => geometry(),
  colors,
};

describe('COLLADA export', () => {
  it('writes a standard 1.4.1 scene with one shared geometry per part and colour groups', () => {
    const dae = buildCollada(base);
    expect(dae).toContain('<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">');
    expect(dae).toContain('<unit name="LDU" meter="0.04"/>');
    expect(dae).toContain('<up_axis>Y_UP</up_axis>');
    expect(dae.match(/<geometry id="Part-3001"/g)).toHaveLength(1);
    // triangle groups are colour ROLES; each instance maps them to its own colours
    expect(dae).toContain('<triangles count="2" material="main">');
    expect(dae).toContain('<triangles count="2" material="fixed_0">');
    expect(dae).toContain('<instance_material symbol="main" target="#material_4"/>');
    expect(dae).toContain('<instance_material symbol="fixed_0" target="#material_0"/>');
    expect(dae).toContain('name="SOLID-RED"');
    expect(dae).toContain('name="SOLID-BLACK"');
    expect(dae.match(/<node id="piece_/g)).toHaveLength(2);
    expect(dae).toContain('<instance_visual_scene url="#Scene"/>');
  });

  it('gives two instances of one part their own colour on the shared geometry', () => {
    const dae = buildCollada({
      name: 'Two colours',
      pieces: [piece('a', '3001', 4, 0), piece('b', '3001', 0, 40)],
      geometryOf: () => geometry(),
      colors,
    });
    // one geometry, with role symbols only (no colour code baked in)
    expect(dae.match(/<geometry id="Part-3001"/g)).toHaveLength(1);
    expect(dae).not.toMatch(/material="c\d+"/);
    // the two instances bind the same role to different materials
    const bindings = [...dae.matchAll(/<instance_material symbol="main" target="#material_(\d+)"\/>/g)].map((m) => m[1]);
    expect(bindings).toEqual(['4', '0']);
  });

  it('bakes the app world transform (LDraw → studs, +Y up) into the node matrices', () => {
    const dae = buildCollada(base);
    const m = /<node id="piece_0"[^>]*><matrix[^>]*>([^<]+)<\/matrix>/.exec(dae);
    expect(m).not.toBeNull();
    const values = m![1].split(' ').map(Number);
    // column-major: translation in elements 12..14. The root flips Y/Z; geometry and translations stay in LDU.
    expect(values[12]).toBeCloseTo(0, 6);
    expect(values[13]).toBeCloseTo(0, 6);
    expect(values[14]).toBeCloseTo(0, 6);
    expect(values[0]).toBeCloseTo(1, 6);   // X
    expect(values[5]).toBeCloseTo(-1, 6);  // Y flipped
    expect(values[10]).toBeCloseTo(-1, 6); // Z flipped
  });

  it("supports Studio's row-major matrix order for EyeSight", () => {
    const m = new THREE.Matrix4().makeTranslation(1, 2, 3);
    expect(matrixText(m, 'column')).toBe('1 0 0 0 0 1 0 0 0 0 1 0 1 2 3 1');
    expect(matrixText(m, 'row')).toBe('1 0 0 1 0 1 0 2 0 0 1 3 0 0 0 1');
  });

  it("names materials the way Studio's library does", () => {
    expect(materialName(RED)).toBe('SOLID-RED');
    // Studio spells it GRAY; LDraw uses GREY
    expect(materialName({ ...RED, name: 'Light_Bluish_Grey', code: 71 })).toBe('SOLID-LIGHT_BLUISH_GRAY');
    // a colour already named Trans_X must not become TRANS-TRANS_X
    expect(materialName({ ...RED, name: 'Trans_Bright_Green', finish: 'trans' })).toBe('TRANS-BRIGHT_GREEN');
    expect(materialName({ ...RED, name: 'Silver_Metallic', finish: 'metal' })).toBe('METAL-SILVER_METALLIC');
  });

  it('exports the camera and rig', () => {
    const dae = buildCollada({
      ...base,
      camera: { position: new THREE.Vector3(6, 5, 8), target: new THREE.Vector3(0, 0, 0), fov: 30, near: 0.1, far: 5000, width: 1080, height: 1920 },
      lights: [{ dir: [-0.57, 0.5, -0.65], size: 0.1, intensity: 2 }],
    });
    expect(dae).toContain('<camera id="camera_main">');
    expect(dae).toContain('<node id="Camera_Node"');
    expect(dae).toContain('<instance_camera url="#camera_main"/>');
    expect(dae).toContain('<light id="light_0">');
    expect(dae).toContain('<instance_light url="#light_0"/>');
    // 30° vertical on a 9:16 frame is a narrow horizontal field
    const xfov = /<xfov>([^<]+)<\/xfov>/.exec(dae)![1];
    expect(Number(xfov)).toBeGreaterThan(10);
    expect(Number(xfov)).toBeLessThan(30);
  });

  it('writes an ambient light without a direction', () => {
    const dae = buildCollada({ ...base, lights: [{ type: 'ambient', dir: [0, 1, 0], size: 0, intensity: 0.01 }] });
    expect(dae).toContain('<ambient><color>1 1 1</color></ambient>');
    expect(dae).not.toContain('<directional>');
  });

  it('animates only the pieces that move, sampling the timeline', () => {
    const moving = (t: number) => new Map<string, THREE.Matrix4 | null>([
      ['a', new THREE.Matrix4().makeTranslation(t * 10, 0, 0)],
      ['b', new THREE.Matrix4().makeTranslation(40, 0, 0)],
    ]);
    const dae = buildCollada({ ...base, animation: { fps: 10, duration: 1, sample: moving } });
    expect(dae).toContain('<library_animations>');
    expect(dae.match(/<channel /g)).toHaveLength(1); // only 'a' moves
    expect(dae).toContain('target="piece_0/matrix"');
    expect(dae).toContain('target="piece_0/matrix"');
    const count = /<float_array id="anim_0-input-array" count="(\d+)"/.exec(dae)![1];
    expect(Number(count)).toBe(11); // 0…1s at 10 fps
    // the sampler's OUTPUT stride is 16 floats per matrix
    expect(dae).toContain('stride="16"');
  });

  it('parks pieces that have not appeared yet instead of writing NaN', () => {
    const none = () => new Map<string, THREE.Matrix4 | null>([['a', null]]);
    const dae = buildCollada({ ...base, animation: { fps: 2, duration: 1, sample: none } });
    expect(dae).not.toContain('NaN');
  });
});
