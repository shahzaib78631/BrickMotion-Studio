import * as THREE from 'three';
import { expect, test } from 'vitest';
import { blurRadius, focusDistance, maxBlurPx } from '../../src/render/depthOfField';
import { DEFAULT_MATERIALS, sanitizeMaterials } from '../../src/render/looks';
import { GLOW_GAIN, materialFor, setBrickMaterials } from '../../src/render/materials';
import { tracedMaterial } from '../../src/export/pathTracedStill';
import { sanitizeSettings } from '../../src/storage/settings';
import { pathTraceColor } from '../../src/dev/eyesightScene';
import type { ColorDef } from '../../src/ldraw/colors';

const absorption = (c: THREE.Color) => new THREE.Color().setRGB(Math.max(0.02, c.r), Math.max(0.02, c.g), Math.max(0.02, c.b));
const transYellow: ColorDef = { code: 46, name: 'Trans_Yellow', hex: '#F5CD2F', edge: '#C8A000', alpha: 128, finish: 'trans' };
const red: ColorDef = { code: 4, name: 'Red', hex: '#C91A09', edge: '#333333', alpha: 255, finish: 'solid' };

test('glow, glass and lens are sanitised from storage', () => {
  const m = sanitizeMaterials({ glow: { colors: [46, 46, 'x', 1.5, 4], strength: 99 }, glass: 'clear', lens: { blur: 'strong', focus: -3 } });
  expect(m.glow).toEqual({ colors: [46, 4], strength: 4 });
  expect(m.glass).toBe('clear');
  expect(m.lens).toEqual({ blur: 'strong', focus: 0 });
  const d = sanitizeMaterials({ glass: 'mirror', lens: { blur: 'huge' } });
  expect(d.glass).toBe('soft');
  expect(d.lens).toEqual(DEFAULT_MATERIALS.lens);
  expect(d.glow).toEqual(DEFAULT_MATERIALS.glow);
});

test('the video engine is stored, and anything unknown falls back to the live renderer', () => {
  expect(sanitizeSettings({}).video.videoEngine).toBe('live');
  const s = sanitizeSettings({ video: { videoEngine: 'path', pathSamples: 128 } as never });
  expect(s.video.videoEngine).toBe('path');
  expect(s.video.pathSamples).toBe(128);
  expect(sanitizeSettings({ video: { videoEngine: 'gpu', pathSamples: 7 } as never }).video).toMatchObject({ videoEngine: 'live', pathSamples: 64 });
});

test('glowing colours give off their own colour, others none', () => {
  const lamp = materialFor(transYellow, false) as THREE.MeshPhysicalMaterial;
  const brick = materialFor(red, false) as THREE.MeshPhysicalMaterial;
  setBrickMaterials({ finish: 'studio', texture: 'none', glow: { colors: [46], strength: 2 } });
  expect(lamp.emissive.getHexString()).toBe(new THREE.Color('#F5CD2F').getHexString());
  expect(lamp.emissiveIntensity).toBeCloseTo(2 * GLOW_GAIN);
  expect(brick.emissive.getHex()).toBe(0);
  setBrickMaterials({ finish: 'studio', texture: 'none', glow: { colors: [], strength: 2 } });
  expect(lamp.emissive.getHex()).toBe(0);
});

test('clear glass refracts in the path tracer and glowing parts light the scene', () => {
  setBrickMaterials({ finish: 'studio', texture: 'none', glow: { colors: [46], strength: 1 } });
  const lamp = materialFor(transYellow, false);
  const soft = tracedMaterial(lamp, { ...DEFAULT_MATERIALS, glass: 'soft' }) as THREE.MeshPhysicalMaterial;
  expect(soft.transmission).toBeLessThan(1);
  expect(soft.emissiveIntensity).toBeGreaterThan((lamp as THREE.MeshPhysicalMaterial).emissiveIntensity);
  const clear = tracedMaterial(lamp, { ...DEFAULT_MATERIALS, glass: 'clear' }) as THREE.MeshPhysicalMaterial;
  expect(clear).toMatchObject({ transmission: 1, transparent: false, opacity: 1, ior: 1.52 });
  expect(clear.attenuationColor.equals((lamp as THREE.MeshPhysicalMaterial).attenuationColor)).toBe(true);
  // the viewport's material is untouched
  expect((lamp as THREE.MeshPhysicalMaterial).transmission).toBeLessThan(1);
  // solid bricks never turn to glass
  const brick = tracedMaterial(materialFor(red, false), { ...DEFAULT_MATERIALS, glass: 'clear' }) as THREE.MeshPhysicalMaterial;
  expect(brick.transmission).toBe(0);
  setBrickMaterials({ finish: 'studio', texture: 'none', glow: { colors: [], strength: 1.5 } });
});

test('the colour source switches a brick between the LDraw value and Studio’s table', () => {
  const brick = materialFor(red, false) as THREE.MeshPhysicalMaterial;
  const ldrawRed = new THREE.Color(red.hex).getHexString();
  setBrickMaterials({ finish: 'catalog', palette: 'ldraw', texture: 'none' });
  expect(brick.color.getHexString()).toBe(ldrawRed);
  setBrickMaterials({ finish: 'eyesight', palette: 'studio', texture: 'none' });
  expect(brick.color.getHexString()).not.toBe(ldrawRed);
});

test('blur is zero at the focus, grows away from it and never passes the lens maximum', () => {
  expect(blurRadius(10, 10, 12)).toBe(0);
  expect(blurRadius(12, 10, 12)).toBeGreaterThan(0);
  expect(blurRadius(20, 10, 12)).toBeGreaterThan(blurRadius(12, 10, 12));
  expect(blurRadius(1e9, 10, 12)).toBe(12);
  expect(blurRadius(2, 10, 12)).toBe(12); // close foreground
  expect(blurRadius(20, 10, 0)).toBe(0);
  expect(maxBlurPx({ blur: 'off', focus: 0.5 }, 1080)).toBe(0);
  expect(maxBlurPx({ blur: 'medium', focus: 0.5 }, 2160)).toBe(2 * maxBlurPx({ blur: 'medium', focus: 0.5 }, 1080));
});

test('focus runs from the nearest to the farthest point of the model', () => {
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 1000);
  camera.position.set(0, 0, 50);
  camera.lookAt(0, 0, 0);
  const box = new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5));
  expect(focusDistance(camera, box, 0)).toBeCloseTo(45);
  expect(focusDistance(camera, box, 1)).toBeCloseTo(55);
  expect(focusDistance(camera, box, 0.5)).toBeCloseTo(50);
});


test.each([
  { code: 46, name: 'Trans_Yellow', hex: '#F5CD2F', rgb: [1, 0.9137255, 0] },
  { code: 36, name: 'Trans_Red', hex: '#C91A09', rgb: [0.88, 0, 0] },
  { code: 34, name: 'Trans_Green', hex: '#237841', rgb: [0, 0.6, 0.1428191] },
  { code: 47, name: 'Trans_Clear', hex: '#FCFCFC', rgb: [1, 1, 1] },
])('transparent Studio $name uses its tint in the viewport and path renderer', ({ code, name, hex, rgb }) => {
  const def: ColorDef = { code, name, hex, edge: '#333333', alpha: 128, finish: 'trans' };
  setBrickMaterials({ finish: 'eyesight', palette: 'studio', texture: 'none' });
  const material = materialFor(def, false) as THREE.MeshPhysicalMaterial;
  const expected = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace);
  expect(material.attenuationColor.getHexString()).toBe(absorption(expected).getHexString());
  expect(material.transparent).toBe(false);
  expect(material.opacity).toBe(1);
  expect(material.transmission).toBeGreaterThan(0.9);
  expect(pathTraceColor(def, 'studio').toArray()).toEqual(expected.toArray());
  setBrickMaterials({ finish: 'eyesight', palette: 'ldraw', texture: 'none' });
  expect(material.attenuationColor.getHexString()).toBe(absorption(new THREE.Color(hex)).getHexString());
  setBrickMaterials({ finish: 'eyesight', palette: 'studio', texture: 'none' });
  expect(material.attenuationColor.getHexString()).toBe(absorption(expected).getHexString());
});


test('glass settings restyle cached viewport materials without fading reflections', () => {
  setBrickMaterials({ finish: 'eyesight', palette: 'studio', texture: 'none', glass: 'soft' });
  const material = materialFor(transYellow, false) as THREE.MeshPhysicalMaterial;
  const version = material.version;
  const tint = material.attenuationColor.clone();
  setBrickMaterials({ finish: 'eyesight', palette: 'studio', texture: 'none', glass: 'clear' });
  expect(materialFor(transYellow, false)).toBe(material);
  expect(material).toMatchObject({ transmission: 1, opacity: 1, transparent: false, depthWrite: true, roughness: 0.02, ior: 1.52, metalness: 0, thickness: 0.06, attenuationDistance: 0.3 });
  expect(material.attenuationColor.equals(tint)).toBe(true);
  expect(material.version).toBeGreaterThan(version);
  setBrickMaterials({ finish: 'eyesight', palette: 'studio', texture: 'none', glass: 'milky' });
  expect(material).toMatchObject({ transmission: 0.3, roughness: 0.55, opacity: 1 });
  setBrickMaterials({ finish: 'eyesight', palette: 'studio', texture: 'none', glass: 'soft' });
  expect(material).toMatchObject({ transmission: 0.92, roughness: 0.1, opacity: 1 });
});


test('saturated glass keeps finite absorption in every channel', () => {
  setBrickMaterials({ finish: 'eyesight', palette: 'studio', texture: 'none', glass: 'clear' });
  const glass = materialFor({ code: 36, name: 'Trans_Red', hex: '#C91A09', edge: '#333333', alpha: 128, finish: 'trans' }, false) as THREE.MeshPhysicalMaterial;
  for (const channel of glass.attenuationColor.toArray()) {
    expect(channel).toBeGreaterThan(0);
    expect(Number.isFinite(-Math.log(channel) / glass.attenuationDistance)).toBe(true);
  }
  setBrickMaterials({ finish: 'eyesight', palette: 'studio', texture: 'none', glass: 'soft' });
});

test('viewport glass thickness is not shrunk by the LDraw root scale', () => {
  const glass = materialFor(transYellow, false) as THREE.MeshPhysicalMaterial;
  const shader = { uniforms: {}, vertexShader: '#include <common>', fragmentShader: '#include <transmission_fragment>', defines: {} };
  glass.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
  expect(shader.fragmentShader).toContain('thickness / max(length(modelMatrix[0].xyz), 0.000001)');
  expect(shader.fragmentShader).not.toContain('#include <transmission_fragment>');
});
