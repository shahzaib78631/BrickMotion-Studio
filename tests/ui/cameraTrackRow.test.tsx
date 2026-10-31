// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Plan } from '../../src/plan/types';
import { useStudio } from '../../src/state/store';
import { usePlayback } from '../../src/state/playback';
import { CameraTrackLanes, CameraTrackTools, placeMenu } from '../../src/ui/CameraTrackRow';
import { viewportApi } from '../../src/ui/viewportApi';
import { DEFAULT_TRANSITION } from '../../src/anim/cameraTrack/presets';
import { cameraPoseToKey } from '../../src/anim/cameraTrack/context';
import { cameraTrackAt } from '../../src/anim/cameraTrack/sample';
import type { CameraKey } from '../../src/anim/cameraTrack/types';

const key = (id: string, t: number, lensMm = 50): CameraKey => ({ id, t, target: { kind: 'model' }, offset: [0, 0, 0], azimuth: 0, elevation: 30,
  distance: { fit: true, margin: 1.1 }, roll: 0, lensMm, focus: 0.5, blur: 0, origin: 'user' });
const plan = (): Plan => ({
  format: 'brickmotion-plan', version: 1, name: 't', steps: [],
  cameraTracks: { '': { build: {
    keys: [key('a', 0), key('b', 2), key('c', 5, 85)],
    transitions: [
      { from: 'a', to: 'b', preset: 'swoop', settings: DEFAULT_TRANSITION, origin: 'user' },
      { from: 'b', to: 'c', preset: 'glide', settings: DEFAULT_TRANSITION, origin: 'user' },
    ],
    shutter: 0.5,
  } } },
});
const lanes = () => render(<CameraTrackLanes clock="build" duration={10} fps={30} toX={(t) => t * 100} toT={(x) => x / 100} laneHeight={42} />);
const track = () => useStudio.getState().plan.cameraTracks![''].build!;

beforeEach(() => {
  useStudio.getState().setPlan(plan(), { resetHistory: true });
  useStudio.getState().selectCamera(null);
});
afterEach(() => { cleanup(); viewportApi.studio = null; viewportApi.controls = null; });

describe('Camera lanes', () => {
  it('shows a diamond per key and a labelled bar per move', () => {
    lanes();
    expect(screen.getAllByRole('button', { name: /^Camera key at/ })).toHaveLength(3);
    expect(screen.getByRole('button', { name: /Fast swoop/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Smooth glide/ })).toBeTruthy();
  });
  it('marks lens changes on the Lens lane', () => {
    lanes();
    expect(screen.getByText('85 mm')).toBeTruthy();
  });
  it('clicking a move selects it for the Inspector', () => {
    lanes();
    fireEvent.click(screen.getByRole('button', { name: /Fast swoop/ }));
    expect(useStudio.getState().cameraSelection).toEqual({ kind: 'transition', clock: 'build', id: 'a' });
  });
  it('Delete removes the selected key as one undo step', () => {
    lanes();
    const b = screen.getByRole('button', { name: 'Camera key at 2.00 s' });
    fireEvent.click(b);
    fireEvent.keyDown(b, { key: 'Delete' });
    expect(track().keys.map((k) => k.id)).toEqual(['a', 'c']);
    useStudio.getState().undo();
    expect(track().keys).toHaveLength(3);
  });
});

describe('Several camera keys', () => {
  const keyBtn = (t: string) => screen.getByRole('button', { name: `Camera key at ${t} s` });
  const chosen = () => useStudio.getState().cameraSelection?.ids ?? [useStudio.getState().cameraSelection?.id];
  it('Shift-click picks every key between; Cmd/Ctrl-click adds or drops one', () => {
    lanes();
    fireEvent.click(keyBtn('0.00'));
    fireEvent.click(keyBtn('5.00'), { shiftKey: true });
    expect(chosen()).toEqual(['a', 'b', 'c']);
    fireEvent.click(keyBtn('2.00'), { metaKey: true });
    expect(chosen()).toEqual(['a', 'c']);
    fireEvent.click(keyBtn('2.00'), { ctrlKey: true });
    expect(chosen()).toEqual(['a', 'c', 'b']);
    expect(keyBtn('2.00').className).toContain('sel');
    fireEvent.click(keyBtn('2.00'));
    expect(chosen()).toEqual(['b']);
  });
  it('dragging across the empty lane picks the keys inside', () => {
    const { container } = lanes();
    const lane = container.querySelector('.bm-camtrack') as HTMLElement;
    fireEvent.pointerDown(lane, { button: 0, clientX: 150 });
    fireEvent.pointerMove(window, { clientX: 550 });
    fireEvent.pointerUp(window, { clientX: 550 });
    expect(chosen()).toEqual(['b', 'c']);
  });
  it('a drag that starts on a move bar picks keys too; a click on it still picks the move', () => {
    lanes();
    const bar = screen.getByRole('button', { name: /^Smooth glide, / });
    fireEvent.pointerDown(bar, { button: 0, clientX: 150 });
    fireEvent.pointerMove(window, { clientX: 550 });
    fireEvent.pointerUp(window, { clientX: 550 });
    fireEvent.click(bar); // the browser's click at the end of the drag
    expect(chosen()).toEqual(['b', 'c']);
    fireEvent.click(bar);
    expect(useStudio.getState().cameraSelection).toEqual({ kind: 'transition', clock: 'build', id: 'b' });
  });
  it('Delete removes every chosen key in one undo step', () => {
    lanes();
    fireEvent.click(keyBtn('0.00'));
    fireEvent.click(keyBtn('2.00'), { shiftKey: true });
    fireEvent.keyDown(keyBtn('2.00'), { key: 'Delete' });
    expect(track().keys.map((k) => k.id)).toEqual(['c']);
    expect(useStudio.getState().cameraSelection).toBeNull();
    useStudio.getState().undo();
    expect(track().keys).toHaveLength(3);
  });
  it('arrow keys and dragging move the chosen keys together', () => {
    lanes();
    fireEvent.click(keyBtn('2.00'));
    fireEvent.click(keyBtn('5.00'), { shiftKey: true });
    fireEvent.keyDown(keyBtn('5.00'), { key: 'ArrowRight', shiftKey: true });
    expect(track().keys.map((k) => +k.t.toFixed(3))).toEqual([0, 2.333, 5.333]);
    const grab = screen.getByRole('button', { name: /Camera key at 2\.33/ });
    fireEvent.pointerDown(grab, { button: 0, clientX: 233, pointerId: 1 });
    fireEvent.pointerMove(grab, { clientX: 333, pointerId: 1 });
    fireEvent.pointerUp(grab, { clientX: 333, pointerId: 1 });
    expect(track().keys.map((k) => +k.t.toFixed(3))).toEqual([0, 3.333, 6.333]);
  });
  it('the right-click menu of a chosen key acts on all of them', () => {
    lanes();
    fireEvent.click(keyBtn('0.00'));
    fireEvent.click(keyBtn('2.00'), { shiftKey: true });
    fireEvent.contextMenu(keyBtn('2.00'), { clientX: 200, clientY: 20 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete 2 camera keys/ }));
    expect(track().keys.map((k) => k.id)).toEqual(['c']);
  });
  it('Select all picks every camera key', () => {
    lanes();
    fireEvent.contextMenu(keyBtn('0.00'), { clientX: 0, clientY: 20 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Select all camera keys/ }));
    expect(chosen()).toEqual(['a', 'b', 'c']);
  });
});

describe('Camera lane right-click menus', () => {
  const pick = (name: string | RegExp) => fireEvent.click(screen.getByRole('menuitem', { name }));
  it('a key\'s menu deletes it, as one undo step', () => {
    lanes();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Camera key at 2.00 s' }), { clientX: 200, clientY: 20 });
    expect(screen.getByRole('menu', { name: 'Camera key menu' })).toBeTruthy();
    pick(/Delete camera key/);
    expect(track().keys.map((k) => k.id)).toEqual(['a', 'c']);
    expect(screen.queryByRole('menu')).toBeNull();
    useStudio.getState().undo();
    expect(track().keys.map((k) => k.id)).toEqual(['a', 'b', 'c']);
  });
  it('a key\'s menu jumps the playhead to it and opens it in the Inspector', () => {
    lanes();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Camera key at 5.00 s' }), { clientX: 500, clientY: 20 });
    pick(/Go to this key/);
    expect(usePlayback.getState().t).toBe(5);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Camera key at 5.00 s' }), { clientX: 500, clientY: 20 });
    pick(/Edit in the Inspector/);
    expect(useStudio.getState().cameraSelection).toEqual({ kind: 'key', clock: 'build', id: 'c' });
  });
  it('a move\'s menu changes it to another preset (which also sets its end key)', () => {
    lanes();
    fireEvent.contextMenu(screen.getByRole('button', { name: /^Fast swoop, / }), { clientX: 100, clientY: 20 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Change move to/ }));
    pick(/^Orbit around/);
    expect(track().transitions.find((x) => x.from === 'a')!.preset).toBe('orbit');
    expect(track().keys.find((k) => k.id === 'b')!.azimuth).toBe(90);
  });
  it('right-clicking an empty spot on the Camera lane adds a key there from the view', () => {
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    cam.position.set(0, 5, 10);
    viewportApi.studio = { camera: cam, perspective: cam } as never;
    viewportApi.controls = { target: new THREE.Vector3(0, 1, 0) } as never;
    const { container } = lanes();
    const lane = container.querySelector('.bm-camtrack') as HTMLElement;
    lane.getBoundingClientRect = () => ({ left: 0, right: 1000, top: 0, bottom: 42, width: 1000, height: 42, x: 0, y: 0, toJSON() {} });
    fireEvent.contextMenu(lane, { clientX: 350, clientY: 20 });
    pick(/Add camera key here/);
    expect(track().keys.some((k) => Math.abs(k.t - 3.5) < 1e-9)).toBe(true);
  });
});

describe('Camera tools', () => {
  it('adds a key at the playhead from the viewport view', () => {
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    cam.position.set(0, 5, 10);
    viewportApi.studio = { camera: cam, perspective: cam } as never;
    viewportApi.controls = { target: new THREE.Vector3(0, 1, 0) } as never;
    render(<CameraTrackTools clock="build" time={3.5} duration={10} fps={30} sensorMm={36} />);
    fireEvent.click(screen.getByRole('button', { name: /Key from view/ }));
    const added = track().keys.find((k) => Math.abs(k.t - 3.5) < 1e-9)!;
    expect(added).toBeTruthy();
    expect(added.target).toEqual({ kind: 'point', at: [0, 1, 0] });
  });
});

describe('Auto-direct menu', () => {
  it('opens outside the timeline panel so nothing clips it, and every style can be picked', () => {
    const { container } = render(<CameraTrackTools clock="build" time={0} duration={10} fps={30} sensorMm={36} onAutoDirect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Auto-direct/ }));
    const menu = screen.getByRole('menu');
    expect(container.contains(menu)).toBe(false);
    expect(menu.style.position).toBe('fixed');
    expect(screen.getAllByRole('menuitem')).toHaveLength(6);
    // clicking inside the menu does not close it
    fireEvent.pointerDown(screen.getAllByRole('menuitem')[5]);
    expect(screen.queryByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('placeMenu', () => {
  const at = (top: number, bottom: number) => ({ left: 300, right: 420, top, bottom, width: 120, height: bottom - top });
  it('opens below the button when there is room', () => {
    const p = placeMenu(at(100, 130), 1000, 1400);
    expect(p.top).toBe(136);
    expect(p.bottom).toBeUndefined();
    expect(p.maxHeight).toBe(1000 - 136 - 8);
  });
  it('opens above the button near the bottom of the window, as tall as the room above', () => {
    const p = placeMenu(at(700, 730), 800, 1400);
    expect(p.top).toBeUndefined();
    expect(p.bottom).toBe(800 - 700 + 6);
    expect(p.maxHeight).toBe(700 - 6 - 8);
  });
  it('stays inside the window sideways', () => {
    expect(placeMenu({ ...at(100, 130), left: 1300 }, 1000, 1400, 320).left).toBe(1400 - 320 - 8);
    expect(placeMenu({ ...at(100, 130), left: -20 }, 1000, 1400, 320).left).toBe(8);
  });
});

describe('cameraPoseToKey', () => {
  it('reproduces the view it was made from', () => {
    const pos = new THREE.Vector3(3, 7, -9), target = new THREE.Vector3(1, 2, 0);
    const k = cameraPoseToKey(pos, target, 28, 36, 1.5);
    const ctx = { aspect: 1, sensorMm: 36, duration: 5, modelBox: new THREE.Box3(), buildBox: () => new THREE.Box3(), pieceBox: () => null };
    const s = cameraTrackAt({ keys: [{ ...k, id: 'x', origin: 'user' }], transitions: [], shutter: 0 }, 1.5, ctx)!;
    expect(s.position.distanceTo(pos)).toBeCloseTo(0, 6);
    expect(s.fov).toBeCloseTo(28, 6);
  });
});
