import { expect, test } from 'vitest';
import * as THREE from 'three';
import type { Snap } from '../../src/ldraw/shadow';
import { mateAxes, plugAxes, worldSnaps } from '../../src/anim/snapMates';

const cyl = (gender: 'M' | 'F', start: [number, number, number], axis: [number, number, number], length: number, radius: number, shapes = ['R']): Snap =>
  ({ kind: 'cyl', gender, start, axis, length, radius, shapes, slide: false });
const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z).elements;

const stud = cyl('M', [0, 0, 0], [0, -1, 0], 4, 6);
const socket = cyl('F', [0, 8, 0], [0, -1, 0], 4, 6);

test('a stud in the socket of the plate above is joined, along the vertical', () => {
  const axes = mateAxes(worldSnaps([stud], at(0, 0, 0)), worldSnaps([socket], at(0, -8, 0)));
  expect(axes).toHaveLength(1);
  expect(Math.abs(axes[0][1])).toBeCloseTo(1);
});

test('a stud one unit off still joins (authoring slop), two studs off does not', () => {
  expect(mateAxes(worldSnaps([stud], at(0, 0, 0)), worldSnaps([socket], at(1, -8, 0)))).toHaveLength(1);
  expect(mateAxes(worldSnaps([stud], at(0, 0, 0)), worldSnaps([socket], at(40, -8, 0)))).toHaveLength(0);
});

test('connectors far apart along the axis are not joined', () => {
  expect(mateAxes(worldSnaps([stud], at(0, 0, 0)), worldSnaps([socket], at(0, -40, 0)))).toHaveLength(0);
});

test('same gender, axle-only holes and square sockets need the matching plug', () => {
  expect(mateAxes(worldSnaps([stud], at(0, 0, 0)), worldSnaps([stud], at(0, -8, 0)))).toHaveLength(0);
  const axleHole = cyl('F', [0, 8, 0], [0, -1, 0], 4, 6, ['A']);
  expect(mateAxes(worldSnaps([stud], at(0, 0, 0)), worldSnaps([axleHole], at(0, -8, 0)))).toHaveLength(0);
  const axle = cyl('M', [0, 0, 0], [0, -1, 0], 4, 6, ['A']);
  expect(mateAxes(worldSnaps([axle], at(0, 0, 0)), worldSnaps([axleHole], at(0, -8, 0)))).toHaveLength(1);
});

test('an axle held in a clip is joined along the axle', () => {
  const clip: Snap = { kind: 'clp', gender: 'F', start: [17, 0, 0], axis: [-1, 0, 0], length: 4, radius: 2, shapes: ['CLP'], slide: false };
  const bar = cyl('M', [-18, 0, 0], [1, 0, 0], 36, 4, ['R', 'R', 'R']);
  const axes = mateAxes(worldSnaps([bar], at(0, 0, 0)), worldSnaps([clip], at(0, 0, 0)));
  expect(axes).toHaveLength(1);
  expect(Math.abs(axes[0][0])).toBeCloseTo(1);
});

test('a part without connector data joins the socket it fills, not one beside it', () => {
  // a headlight brick's front socket, 20 deep along +z from its face at z=-40
  const front = worldSnaps([cyl('F', [-30, -46, -40], [0, 0, 1], 20, 6)], at(0, 0, 0));
  const pipe = { min: [-39, -174, -58], max: [-21, -41.6, -19] };
  const axes = plugAxes(front, pipe);
  expect(axes).toHaveLength(1);
  expect(axes[0][2]).toBeCloseTo(1);
  expect(plugAxes(front, { min: [0, -174, -58], max: [20, -41.6, -19] })).toHaveLength(0);
});

const finger = (gender: 'M' | 'F', group?: string): Snap =>
  ({ kind: 'fgr', group, gender, start: [0, 0, 0], axis: [1, 0, 0], length: 16, radius: 4, shapes: ['FGR'], slide: false });

test('hinge fingers mate only with fingers of the same group', () => {
  const here = worldSnaps([finger('M', 'lckHng')], at(0, 0, 0));
  expect(mateAxes(here, worldSnaps([finger('F', 'lckHng')], at(0, 0, 0)))).toHaveLength(1);
  expect(mateAxes(here, worldSnaps([finger('F')], at(0, 0, 0)))).toHaveLength(0);
  expect(mateAxes(worldSnaps([finger('M')], at(0, 0, 0)), worldSnaps([finger('F')], at(0, 0, 0)))).toHaveLength(1);
});
