import { describe, expect, it } from 'vitest';
import { animOptions, useAppSettings, type PreviousFloorLayout } from '../../src/state/appSettings';
import { captureFrameStaging, isFrameStagingCurrent } from '../../src/state/frameStaging';
import { sceneSetupOf, type SceneCamera, type SceneSetup } from '../../src/render/sceneSetup';
import { emptyPlan } from '../../src/plan/types';
import { parsePlan } from '../../src/plan/schema';

const cam: SceneCamera = { kind: 'camera', id: 'cam-1', name: 'Camera 1', position: [6, 12, 20], target: [0, 0, 0], fov: 40, near: 0.1, far: 5000 };
const scene: SceneSetup = { ...sceneSetupOf(), cameras: [cam], activeCameraId: cam.id };
const draft = { format: '9:16' as const, floorSort: 'all' as const, floorSides: 'around' as const, floorMatch: 'fill' as const };

describe('manual Camera frame staging (regression: repeated replanning)', () => {
  it('captures a copy of the active camera without moving it', () => {
    const captured = captureFrameStaging(draft, scene)!;
    expect(captured.camera.position).toEqual(cam.position);
    expect(captured.camera.aspect).toBeCloseTo(9 / 16);
    expect(captured.floorSides).toBe('around');
    expect(scene.frameStaging).toBeUndefined();
    captured.camera.position[0] = 700;
    expect(cam.position[0]).toBe(6);
  });

  it('does not change timeline options when Camera frame is selected but not applied', () => {
    const settings = { ...useAppSettings.getState(), ...draft, floorStyle: 'showcase' as const };
    const prior = animOptions(settings, scene);
    const frozen: PreviousFloorLayout = {
      style: prior.floorStyle!, sort: prior.floorSort!, sides: prior.floorSides!,
      match: prior.floorMatch!, aspect: prior.floorAspect!,
    };
    const changedCamera = { ...scene, cameras: [{ ...cam, position: [120, 40, 200] as [number, number, number], fov: 90 }] };
    const pending = { ...settings, frameStagingPending: true, frameStagingPrevious: frozen, format: '16:9' as const,
      floorSort: 'colour' as const, floorSides: 'behind' as const, floorMatch: 'nearest' as const };
    expect(animOptions(pending, changedCamera)).toEqual(prior);
  });

  it('uses the applied snapshot, not subsequent camera and draft control changes', () => {
    const captured = captureFrameStaging(draft, scene)!;
    const appliedScene = { ...scene, frameStaging: captured };
    const settings = { ...useAppSettings.getState(), ...draft, floorStyle: 'camera-frame' as const, frameStagingPending: false, frameStagingPrevious: null };
    const planned = animOptions(settings, appliedScene);
    expect(planned.floorStyle).toBe('camera-frame');
    expect(planned.floorCamera).toEqual(captured.camera);
    const changed = { ...appliedScene, cameras: [{ ...cam, position: [8, 25, 40] as [number, number, number], fov: 20 }],
      cropToRegion: true, region: { x: .1, y: .1, width: .8, height: .8 } };
    const edited = { ...settings, format: '1:1' as const, floorSort: 'part' as const, floorSides: 'front' as const, floorMatch: 'nearest' as const };
    // This is the options JSON key watched by useTimeline. A stable key means
    // an edited camera cannot start a planner request.
    expect(JSON.stringify(animOptions(edited, changed))).toEqual(JSON.stringify(planned));
    expect(isFrameStagingCurrent(captured, edited, changed)).toBe(false);
    const updatedShot = captureFrameStaging(edited, changed)!;
    expect(JSON.stringify(animOptions(edited, { ...changed, frameStaging: updatedShot }))).not.toEqual(JSON.stringify(planned));
  });

  it('keeps an already-applied Camera frame frozen while the tile is reselected', () => {
    const captured = captureFrameStaging(draft, scene)!;
    const appliedScene = { ...scene, frameStaging: captured };
    const settings = { ...useAppSettings.getState(), ...draft, floorStyle: 'camera-frame' as const };
    const planned = animOptions(settings, appliedScene);
    const base: PreviousFloorLayout = { style: planned.floorStyle!, sort: planned.floorSort!, sides: planned.floorSides!,
      match: planned.floorMatch!, aspect: planned.floorAspect!, camera: planned.floorCamera };
    const pending = { ...settings, frameStagingPending: true, frameStagingPrevious: base, floorSort: 'part' as const };
    expect(animOptions(pending, { ...appliedScene, cameras: [{ ...cam, fov: 89 }] })).toEqual(planned);
  });

  it('does not implicitly plan Camera frame for an old project lacking a snapshot', () => {
    const settings = { ...useAppSettings.getState(), ...draft, floorStyle: 'camera-frame' as const };
    const opts = animOptions(settings, scene);
    expect(opts.floorStyle).toBe('packed');
    expect(opts.floorCamera).toBeUndefined();
  });

  it('preserves the applied shot in project files, while old scene files remain valid', () => {
    const withSnapshot = { ...scene, frameStaging: captureFrameStaging(draft, scene)! };
    const output = parsePlan(JSON.parse(JSON.stringify({ ...emptyPlan(), sceneSetup: withSnapshot })));
    expect(output.ok).toBe(true);
    if (output.ok) expect(output.plan.sceneSetup?.frameStaging).toEqual(withSnapshot.frameStaging);
    expect(parsePlan({ ...emptyPlan(), sceneSetup: scene }).ok).toBe(true);
  });
});
