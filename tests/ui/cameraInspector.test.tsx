// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plan } from '../../src/plan/types';
import { useStudio } from '../../src/state/store';
import { useAppSettings } from '../../src/state/appSettings';
import { CameraInspector } from '../../src/ui/CameraInspector';
import { BUILT_IN_PRESETS, DEFAULT_TRANSITION, presetById } from '../../src/anim/cameraTrack/presets';
import type { CameraKey } from '../../src/anim/cameraTrack/types';

const key = (id: string, t: number): CameraKey => ({ id, t, target: { kind: 'model' }, offset: [0, 0, 0], azimuth: 0, elevation: 30,
  distance: { fit: true, margin: 1.1 }, roll: 0, lensMm: 50, focus: 'target', blur: 0, origin: 'auto' });
const plan = (): Plan => ({
  format: 'brickmotion-plan', version: 1, name: 't', steps: [],
  cameraTracks: { '': { build: {
    keys: [key('a', 0), key('b', 2)],
    transitions: [{ from: 'a', to: 'b', preset: 'glide', settings: structuredClone(DEFAULT_TRANSITION), origin: 'auto' }],
    shutter: 0.5,
  } } },
});
const track = () => useStudio.getState().plan.cameraTracks![''].build!;

beforeEach(() => {
  useStudio.getState().setPlan(plan(), { resetHistory: true });
  useAppSettings.getState().set({ cameraPresets: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Camera inspector — a move', () => {
  beforeEach(() => useStudio.getState().selectCamera({ kind: 'transition', clock: 'build', id: 'a' }));

  it('choosing Fast swoop writes the swoop settings', () => {
    render(<CameraInspector />);
    fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'swoop' } });
    const tr = track().transitions[0];
    expect(tr.preset).toBe('swoop');
    expect(tr.settings).toEqual(presetById('swoop', []).settings);
    expect(tr.origin).toBe('user');
  });
  it('Turn in the last sets how late the camera swings round (0 = the whole move)', () => {
    render(<CameraInspector />);
    const slider = screen.getByLabelText('Turn in the last') as HTMLInputElement;
    expect(slider.max).toBe('2');
    expect(screen.getByText('whole move')).toBeTruthy();
    fireEvent.change(slider, { target: { value: '0.5' } });
    expect(track().transitions[0].settings.turnLast).toBe(0.5);
    expect(screen.getByText('0.50 s')).toBeTruthy();
  });
  it('choosing Orbit around makes the move turn: the end key is set 90° round from the start', () => {
    render(<CameraInspector />);
    fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'orbit' } });
    expect(track().keys[1].azimuth).toBe(90);
    expect(track().keys[1].t).toBe(2);
    expect(screen.getByText(/sets the end key/i)).toBeTruthy();
    useStudio.getState().undo();
    expect(track().keys[1].azimuth).toBe(0);
    expect(track().transitions[0].preset).toBe('glide');
  });
  it('changing overshoot keeps the preset name and marks the move as edited', () => {
    render(<CameraInspector />);
    fireEvent.change(screen.getByLabelText('Overshoot'), { target: { value: '0.4' } });
    const tr = track().transitions[0];
    expect(tr.preset).toBe('glide');
    expect(tr.settings.overshoot).toBeCloseTo(0.4);
    expect(tr.origin).toBe('user');
  });
  it('Save as preset adds it to the app settings and to the list', () => {
    window.prompt = vi.fn(() => 'My glide');
    render(<CameraInspector />);
    fireEvent.change(screen.getByLabelText('Overshoot'), { target: { value: '0.3' } });
    fireEvent.click(screen.getByRole('button', { name: /Save as preset/ }));
    const saved = useAppSettings.getState().cameraPresets;
    expect(saved).toHaveLength(1);
    expect(saved[0].label).toBe('My glide');
    expect(saved[0].settings.overshoot).toBeCloseTo(0.3);
    expect(track().transitions[0].preset).toBe(saved[0].id);
    const select = screen.getByLabelText('Preset') as HTMLSelectElement;
    expect(within(select).getByRole('option', { name: 'My glide' })).toBeTruthy();
    expect(select.querySelectorAll('option')).toHaveLength(BUILT_IN_PRESETS.length + 1);
  });
});

describe('Camera inspector — a key', () => {
  beforeEach(() => useStudio.getState().selectCamera({ kind: 'key', clock: 'build', id: 'b' }));

  it('edits the key and marks it as the user\'s', () => {
    render(<CameraInspector />);
    fireEvent.change(screen.getByLabelText('Lens (mm)'), { target: { value: '85' } });
    fireEvent.change(screen.getByLabelText('Aim at'), { target: { value: 'build' } });
    const k = track().keys[1];
    expect(k.lensMm).toBe(85);
    expect(k.target).toEqual({ kind: 'build' });
    expect(k.origin).toBe('user');
  });
  it('switches between auto-fit and a fixed distance', () => {
    render(<CameraInspector />);
    fireEvent.click(screen.getByLabelText('Auto-fit distance'));
    expect(track().keys[1].distance.fit).toBe(false);
  });
});

describe('Camera inspector — several keys', () => {
  beforeEach(() => {
    const p = plan();
    p.cameraTracks![''].build!.keys[1].lensMm = 85;
    useStudio.getState().setPlan(p, { resetHistory: true });
    useStudio.getState().selectCamera({ kind: 'key', clock: 'build', id: 'b', ids: ['a', 'b'] });
  });
  it('says how many keys are chosen and which values differ', () => {
    render(<CameraInspector />);
    expect(screen.getByRole('heading', { name: '2 camera keys' })).toBeTruthy();
    expect(screen.getByText(/Lens differs/)).toBeTruthy();
  });
  it('a change applies to every chosen key, in one undo step', () => {
    render(<CameraInspector />);
    fireEvent.change(screen.getByLabelText('Lens (mm)'), { target: { value: '70' } });
    fireEvent.change(screen.getByLabelText('Height'), { target: { value: '12' } });
    expect(track().keys.map((k) => [k.lensMm, k.elevation])).toEqual([[70, 12], [70, 12]]);
    useStudio.getState().undo();
    expect(track().keys.map((k) => k.elevation)).toEqual([30, 30]);
    expect(track().keys.map((k) => k.lensMm)).toEqual([70, 70]);
  });
  it('deletes every chosen key', () => {
    render(<CameraInspector />);
    fireEvent.click(screen.getByRole('button', { name: /Delete 2 camera keys/ }));
    expect(track().keys).toHaveLength(0);
    expect(useStudio.getState().cameraSelection).toBeNull();
  });
});
