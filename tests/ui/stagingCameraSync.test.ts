import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shouldFollowSceneCamera } from '../../src/ui/sceneViewState';
import { fitAndApplyStagingCamera } from '../../src/ui/stagingCameraActions';
import type { Timeline } from '../../src/anim/timeline';

const mocks = vi.hoisted(() => {
  const fitted = { activeCameraId: 'camera-fitted', cameras: [{ id: 'camera-fitted' }] };
  const plan = { sceneSetup: { activeCameraId: 'camera-old', cameras: [] } };
  const sync = vi.fn();
  const frame = vi.fn(() => fitted);
  const apply = vi.fn((change: (p: typeof plan) => typeof plan) => Object.assign(plan, change(plan)));
  return { fitted, plan, sync, frame, apply };
});
vi.mock('../../src/render/stagingCamera', () => ({ frameStagingScene: mocks.frame }));
vi.mock('../../src/state/store', () => ({ useStudio: { getState: () => ({ plan: mocks.plan, apply: mocks.apply }) } }));
vi.mock('../../src/ui/viewportApi', () => ({ viewportApi: { scene: { sync: mocks.sync } } }));

beforeEach(() => {
  mocks.plan.sceneSetup = { activeCameraId: 'camera-old', cameras: [] };
  mocks.frame.mockClear();
  mocks.sync.mockClear();
  mocks.apply.mockClear();
});

describe('Camera-frame fit is live, including locked camera view', () => {
  it('respects a camera view both when viewport navigation is locked and unlocked', () => {
    expect(shouldFollowSceneCamera({ cameraView: true, lockCamera: true })).toBe(true);
    expect(shouldFollowSceneCamera({ cameraView: true, lockCamera: false })).toBe(true);
    expect(shouldFollowSceneCamera({ cameraView: false, lockCamera: true })).toBe(false);
  });

  it('commits the fitted camera AND synchronizes the displayed camera immediately', () => {
    const timeline = {} as Timeline;
    fitAndApplyStagingCamera(timeline, 9 / 16);
    expect(mocks.frame).toHaveBeenCalledWith(timeline, expect.objectContaining({ activeCameraId: 'camera-old' }), 9 / 16);
    expect(mocks.plan.sceneSetup).toBe(mocks.fitted);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(mocks.sync).toHaveBeenCalledWith(mocks.fitted);
  });
});
