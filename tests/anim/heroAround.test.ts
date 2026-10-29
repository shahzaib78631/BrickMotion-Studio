import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { heroAround } from '../../src/anim/camera';

const shot = { position: new THREE.Vector3(10, 6, 0), target: new THREE.Vector3(0, 1, 0), fov: 35 };
const tl = { buildEnd: 10, duration: 13, heroOrbit: true };

describe('heroAround', () => {
  it('holds the shot through the build', () => {
    const at = heroAround(tl, shot, { heroOrbitDegrees: 90 });
    expect(at(0).position.toArray()).toEqual(shot.position.toArray());
    expect(at(9.99).position.toArray()).toEqual(shot.position.toArray());
  });

  it('orbits around the target at the same distance, height and lens', () => {
    const at = heroAround(tl, shot, { heroOrbitDegrees: 90 });
    const end = at(13);
    expect(end.target.toArray()).toEqual(shot.target.toArray());
    expect(end.fov).toBe(35);
    expect(end.position.y).toBeCloseTo(6);
    expect(end.position.distanceTo(shot.target)).toBeCloseTo(shot.position.distanceTo(shot.target));
    // a full 90° swing around +Y: +X ends on -Z
    expect(end.position.x).toBeCloseTo(0);
    expect(end.position.z).toBeCloseTo(-10);
  });

  it('holds still when the hero orbit is off', () => {
    const at = heroAround({ ...tl, heroOrbit: false }, shot, { heroOrbitDegrees: 90 });
    expect(at(12).position.toArray()).toEqual(shot.position.toArray());
  });
});
