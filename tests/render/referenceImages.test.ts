import * as THREE from 'three';
import { expect, test } from 'vitest';
import { addImage, createReferenceImage, facing, imagesOf, quaternionOf, removeImage, rotationOf, turnImage, updateImage } from '../../src/render/referenceImages';
import { EMPTY_SCENE_SETUP } from '../../src/render/sceneSetup';
import { parsePlan } from '../../src/plan/schema';
import { projectToJson, readProjectFile } from '../../src/io/projectFile';
import type { Plan } from '../../src/plan/types';

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const view = { from: new THREE.Vector3(0, 20, 60), target: new THREE.Vector3(0, 10, 0), fov: 30, viewAspect: 1.5 };
const plan = (images = [createReferenceImage('pic', PIXEL, 2, view)]): Plan => ({
  format: 'brickmotion-plan', version: 1, name: 'p', steps: [],
  sceneSetup: { ...EMPTY_SCENE_SETUP, images },
});

test('a new image hangs at the view centre, faces the camera, and is half see-through', () => {
  const image = createReferenceImage('pic', PIXEL, 2, view);
  expect(image.position).toEqual([0, 10, 0]);
  expect(image.opacity).toBe(0.6);
  // its front (+Z) points back at the camera
  const front = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternionOf(image.rotation));
  const toCamera = view.from.clone().sub(view.target).normalize();
  expect(front.dot(toCamera)).toBeCloseTo(1, 2);
  expect(image.width).toBeGreaterThan(1);
});

test('rotation round-trips and quarter turns turn about the world axis', () => {
  const q = quaternionOf([10, 40, -25]);
  const back = quaternionOf(rotationOf(q));
  expect(Math.abs(q.dot(back))).toBeCloseTo(1, 4);
  const image = { ...createReferenceImage('p', PIXEL, 1, view), rotation: [0, 0, 0] as [number, number, number] };
  // a quarter turn about the vertical axis points the front along +X
  const turned = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternionOf(turnImage(image, 1, 90)));
  expect(turned.x).toBeCloseTo(1); expect(turned.z).toBeCloseTo(0);
  expect(facing(new THREE.Vector3(0, 0, 5), new THREE.Vector3())).toEqual([0, 0, 0]);
});

test('images are added, changed and removed without touching the rest of the scene', () => {
  const a = createReferenceImage('a', PIXEL, 1, view), b = createReferenceImage('b', PIXEL, 1, view);
  let s = addImage(addImage(EMPTY_SCENE_SETUP, a), b);
  expect(imagesOf(s).map((i) => i.name)).toEqual(['a', 'b']);
  s = updateImage(s, a.id, { opacity: 0.2, id: 'nope' });
  expect(imagesOf(s)[0]).toMatchObject({ id: a.id, opacity: 0.2 });
  s = removeImage(removeImage(s, a.id), b.id);
  expect(s.images).toBeUndefined();
  expect(EMPTY_SCENE_SETUP.images).toBeUndefined();
});

test('images survive the plan schema and a saved project; bad ones are refused', () => {
  const p = plan();
  const parsed = parsePlan(p);
  expect(parsed.ok && parsed.plan.sceneSetup?.images?.[0]).toMatchObject({ name: 'pic', aspect: 2, opacity: 0.6, locked: false });
  const file = readProjectFile(projectToJson(p, []));
  expect(file.ok && file.plan.sceneSetup?.images?.[0].src).toBe(PIXEL);
  const bad = plan([{ ...createReferenceImage('x', 'https://example.com/a.png', 1, view) }]);
  expect(parsePlan(bad).ok).toBe(false);
  const out = plan([{ ...createReferenceImage('x', PIXEL, 1, view), opacity: 2 }]);
  expect(parsePlan(out).ok).toBe(false);
});
