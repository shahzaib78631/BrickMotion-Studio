// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAppSettings } from '../../src/state/appSettings';
import { VideoPanel } from '../../src/ui/VideoPanel';
import { sceneOf } from '../../src/render/looks';

afterEach(cleanup);

describe('KenBrick look', () => {
  it('a black stage scene: pure black backdrop, no floor', () => {
    const sc = sceneOf('black');
    expect(sc.id).toBe('black');
    for (const st of sc.stops) for (const v of st.rgb) expect(v).toBeLessThanOrEqual(4);
    expect(sc.floor).toBe('none');
  });
  it('one button sets the 12 s pacing, the black stage and the upright format of the KenBrick videos', () => {
    useAppSettings.getState().set({ targetSeconds: 60, introSeconds: null, buildSeconds: null, outroSeconds: null, heroOrbit: true, studioLook: 'soft', format: '16:9' });
    render(<VideoPanel timeline={null} onExport={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /KenBrick look \(12 s\)/ }));
    const s = useAppSettings.getState();
    expect([s.targetSeconds, s.introSeconds, s.buildSeconds, s.outroSeconds, s.heroOrbit]).toEqual([12, 0.5, 8, 3.5, false]);
    expect(s.studioLook).toBe('black');
    expect(s.format).toBe('9:16');
  });
});
