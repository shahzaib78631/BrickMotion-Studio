// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import type { Plan } from '../../src/plan/types';
import { useStudio } from '../../src/state/store';
import { ExportDialog } from '../../src/ui/ExportDialog';

const planWith = (useCameraForVideo: boolean): Plan => ({
  format: 'brickmotion-plan',
  version: 1,
  name: 't',
  steps: [{ pieces: [{ id: 'a', part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 }] }],
  sceneSetup: {
    cameras: [{ kind: 'camera', id: 'cam1', name: 'Hero cam', position: [0, -60, 60], target: [0, 0, 0], fov: 40, near: 1, far: 900 }],
    lights: [], activeCameraId: 'cam1', useCameraForVideo, useLightsForVideo: false, includeStudioLights: true, region: null, cropToRegion: false,
  } as never,
});

afterEach(cleanup);

test('says a saved scene camera takes over after the intro, and can switch it off', async () => {
  const plan = planWith(true);
  useStudio.getState().setPlan(plan, { resetHistory: true });
  render(<ExportDialog plan={plan} jobs={[{ model: '', label: 'Main model' }]} onClose={() => undefined} />);
  // the warning names the camera and says what is missing
  const banner = await screen.findByRole('note');
  expect(banner.textContent).toContain('Hero cam');
  expect(banner.textContent).toContain('the intro moves into its shot');
  // one click restores the automatic video camera
  const button = await screen.findByRole('button', { name: /Use the automatic camera/i });
  button.click();
  await waitFor(() => expect(useStudio.getState().plan.sceneSetup?.useCameraForVideo).toBe(false));
  await waitFor(() => expect(screen.queryByRole('note')).toBeNull());
});

test('says nothing when the automatic camera is already in charge', () => {
  const plan = planWith(false);
  useStudio.getState().setPlan(plan, { resetHistory: true });
  render(<ExportDialog plan={plan} jobs={[{ model: '', label: 'Main model' }]} onClose={() => undefined} />);
  expect(screen.queryByRole('note')).toBeNull();
});
