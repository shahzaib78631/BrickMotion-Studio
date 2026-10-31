import type { SoundSettings } from '../audio/soundSettings';
import { create } from 'zustand';
import type { AnimOptions, ArrivalMode, FloorSides, FloorSort, FloorStyle, FloorMatch, FrameStagingCamera } from '../anim/pacing';
import type { JointLimitRule } from '../anim/motion/v4/jointLimits';
import type { MechanismProgram } from '../anim/motion/v4/mechanismProgram';
import { CONSTRUCTION_BUDGET_PRESETS, type ConstructionBudgetPreset } from '../anim/construction/budgetPresets';
import type { LogoCorner } from '../export/exportVideo';
import type { ExportFps } from '../export/frameRates';
import type { Materials, StudioLook } from '../render/looks';
import type { CameraFraming, CameraSettings } from '../anim/camera';
import type { TransitionPreset } from '../anim/cameraTrack/presets';
import { DEFAULT_SETTINGS, type Settings, type VideoEngine } from '../storage/settings';
import { formatAspect, type VideoFormat } from '../export/formats';
import type { SceneSetup } from '../render/sceneSetup';

/** The layout that was already planned when Camera frame was selected.
 * Stored in memory only so changes to draft Group/Where/Side/Format do not
 * disturb that timeline before the explicit Apply action. */
export type PreviousFloorLayout = {
  style: FloorStyle; sort: FloorSort; sides: FloorSides;
  match: FloorMatch; aspect: number; camera?: FrameStagingCamera;
};

export type AppSettings = {
  /** Claude API key, stored only in this browser */
  apiKey: string;
  model: string;
  targetSeconds: number;
  fps: ExportFps;
  heroOrbit: boolean;
  studioLook: StudioLook;
  cameraFraming: CameraFraming;
  camera: CameraSettings;
  /** output frame shape for the preview and MP4 */
  format: VideoFormat;
  /** faint LDraw outline edges on every brick */
  edgeLines: boolean;
  /** linear tone mapping (truer LEGO colours) instead of filmic */
  linearColors: boolean;
  /** within a step, each piece is placed after what it rests on */
  bottomUp: boolean;
  planner?: 'legacy' | 'construction-v2' | 'construction-auto' | 'construction-v3' | 'construction-v3-auto' | 'construction-v4' | 'standard-motion' | 'standard-motion-v4' | 'assembly-artifact';
  constructionSupport?: 'fixture' | 'table';
  constructionBudget?: ConstructionBudgetPreset;
  constructionStepModules?: boolean;
  motionV4Limits?: JointLimitRule[];
  motionV4Mechanism?: MechanismProgram | null;
  /** how pieces waiting on the floor are grouped, and where around the model */
  floorSort: FloorSort;
  floorSides: FloorSides;
  floorStyle: FloorStyle;
  /** waiting pieces fill the bands in order, or wait on the side they are built on */
  floorMatch: FloorMatch;
  /** brick finish, surface texture and floor surface */
  materials: Materials;
  /** a click each time pieces connect, in playback and the MP4 */
  snapSound: boolean;
  /** how that click sounds (Sound panel) */
  sound: SoundSettings;
  /** MP4 renderer: the live one, or path traced per frame (slow, final quality) */
  videoEngine: VideoEngine;
  /** samples per pixel for a path-traced MP4 */
  pathSamples: number;
  introSeconds: number | null;
  buildSeconds: number | null;
  outroSeconds: number | null;
  mode: 'auto' | ArrivalMode;
  logoEnabled: boolean;
  logoCorner: LogoCorner;
  /** the floating quick-action bar over the viewport when parts are selected */
  showSelectionBar: boolean;
  /** MP4 camera: the automatic cinematics, or the camera the viewport plays. */
  exportCamera: 'automatic' | 'buildView' | 'track';
  /** play the intro shot and hero orbit in the Build viewport as well as in the video */
  cameraFollowsPlayback: boolean;
  /** camera moves saved as presets */
  cameraPresets: TransitionPreset[];
  /** When Camera frame staging plays, fit the scene camera to the visible loose pieces. */
  autoFitStaging: boolean;
  /** UI-only selection; no planning until Arrange is pressed. Never persisted. */
  frameStagingPending: boolean;
  frameStagingPrevious: PreviousFloorLayout | null;
  /** the logo file as stored */
  logo: Blob | null;
  /** the decoded logo, ready to draw */
  logoBitmap: ImageBitmap | null;
  set(p: Partial<Omit<AppSettings, 'set'>>): void;
};

export const useAppSettings = create<AppSettings>((set) => ({
  apiKey: DEFAULT_SETTINGS.apiKey,
  model: DEFAULT_SETTINGS.model,
  ...DEFAULT_SETTINGS.video,
  logoEnabled: DEFAULT_SETTINGS.logoEnabled,
  logoCorner: DEFAULT_SETTINGS.logoCorner,
  showSelectionBar: DEFAULT_SETTINGS.showSelectionBar,
  exportCamera: DEFAULT_SETTINGS.exportCamera,
  cameraFollowsPlayback: DEFAULT_SETTINGS.cameraFollowsPlayback,
  cameraPresets: DEFAULT_SETTINGS.cameraPresets,
  autoFitStaging: DEFAULT_SETTINGS.autoFitStaging,
  frameStagingPending: false,
  frameStagingPrevious: null,
  logo: null,
  logoBitmap: null,
  set: (p) => set(p),
}));

export const toSettings = (s: AppSettings): Settings => ({
  apiKey: s.apiKey,
  model: s.model,
  logo: s.logo,
  logoCorner: s.logoCorner,
  logoEnabled: s.logoEnabled,
  showSelectionBar: s.showSelectionBar,
  cameraFollowsPlayback: s.cameraFollowsPlayback,
  cameraPresets: s.cameraPresets,
  autoFitStaging: s.autoFitStaging,
  exportCamera: s.exportCamera ?? 'track',
  video: { targetSeconds: s.targetSeconds, heroOrbit: s.heroOrbit, mode: s.mode, fps: s.fps, introSeconds: s.introSeconds, buildSeconds: s.buildSeconds, outroSeconds: s.outroSeconds, studioLook: s.studioLook, cameraFraming: s.cameraFraming, camera: s.camera, format: s.format, edgeLines: s.edgeLines, linearColors: s.linearColors, bottomUp: s.bottomUp, snapSound: s.snapSound, planner: s.planner ?? 'legacy', constructionSupport: s.constructionSupport ?? 'fixture', constructionBudget: s.constructionBudget ?? 'standard', constructionStepModules: s.constructionStepModules === true, motionV4Limits: s.motionV4Limits ?? [], motionV4Mechanism: s.motionV4Mechanism ?? null, floorSort: s.floorSort, floorSides: s.floorSides, floorStyle: s.floorStyle ?? 'packed', floorMatch: s.floorMatch ?? 'fill', materials: s.materials, sound: s.sound, videoEngine: s.videoEngine, pathSamples: s.pathSamples },
});

export async function applySettings(s: Settings): Promise<void> {
  const logoBitmap = s.logo ? await createImageBitmap(s.logo).catch(() => null) : null;
  useAppSettings
    .getState()
    .set({ apiKey: s.apiKey, model: s.model, logo: s.logo, logoBitmap, logoCorner: s.logoCorner, logoEnabled: s.logoEnabled && !!logoBitmap, showSelectionBar: s.showSelectionBar, cameraFollowsPlayback: s.cameraFollowsPlayback, cameraPresets: s.cameraPresets ?? [], autoFitStaging: false, frameStagingPending: false, frameStagingPrevious: null, exportCamera: s.exportCamera ?? 'track', ...s.video });
}

/** The animation options the timeline planner needs, taken from the video settings. */
export const animOptions = (s: Pick<AppSettings, 'targetSeconds' | 'heroOrbit' | 'mode' | 'introSeconds' | 'buildSeconds' | 'outroSeconds' | 'bottomUp' | 'planner' | 'constructionSupport'> & Partial<Pick<AppSettings, 'constructionBudget' | 'constructionStepModules' | 'motionV4Limits' | 'motionV4Mechanism' | 'floorSort' | 'floorSides' | 'floorStyle' | 'floorMatch' | 'format' | 'frameStagingPending' | 'frameStagingPrevious'>>, sceneSetup?: SceneSetup): AnimOptions => ({
  targetSeconds: s.targetSeconds,
  heroOrbit: s.heroOrbit,
  mode: s.mode === 'auto' ? undefined : s.mode,
  introSeconds: s.introSeconds,
  buildSeconds: s.buildSeconds,
  outroSeconds: s.outroSeconds,
  bottomUp: s.bottomUp,
  planner: s.planner ?? 'legacy',
  constructionSupport: s.constructionSupport ?? 'fixture',
  constructionStepModules: s.constructionStepModules === true,
  motionV4Limits: s.motionV4Limits ?? [],
  motionV4Mechanism: s.motionV4Mechanism ?? null,
  constructionMaxMilliseconds: CONSTRUCTION_BUDGET_PRESETS[s.constructionBudget ?? 'standard'].maxMilliseconds,
  constructionMaxStates: CONSTRUCTION_BUDGET_PRESETS[s.constructionBudget ?? 'standard'].maxStates,
  constructionMaxCandidates: CONSTRUCTION_BUDGET_PRESETS[s.constructionBudget ?? 'standard'].maxCandidates,
  // Until the user explicitly applies Camera frame, preserve normal/default
  // staging and NEVER bind an animation request to the live camera. After the
  // click, read ONLY the project-local snapshot, so changing the lens, camera
  // target, output ratio, crop, or draft spacing cannot restart planning.
  floorSort: s.frameStagingPending && s.frameStagingPrevious
    ? s.frameStagingPrevious.sort : s.floorStyle === 'camera-frame' && sceneSetup?.frameStaging
    ? sceneSetup.frameStaging.floorSort : s.floorSort ?? 'step',
  floorSides: s.frameStagingPending && s.frameStagingPrevious
    ? s.frameStagingPrevious.sides : s.floorStyle === 'camera-frame' && sceneSetup?.frameStaging
    ? sceneSetup.frameStaging.floorSides : s.floorSides ?? 'front-back',
  floorStyle: s.frameStagingPending && s.frameStagingPrevious
    ? s.frameStagingPrevious.style : s.floorStyle === 'camera-frame' && !sceneSetup?.frameStaging
    ? 'packed' : s.floorStyle ?? 'packed',
  floorAspect: s.frameStagingPending && s.frameStagingPrevious
    ? s.frameStagingPrevious.aspect : s.floorStyle === 'camera-frame' && sceneSetup?.frameStaging
    ? sceneSetup.frameStaging.camera.aspect : formatAspect(s.format ?? '9:16'),
  ...(s.frameStagingPending && s.frameStagingPrevious
    ? (s.frameStagingPrevious.camera ? { floorCamera: s.frameStagingPrevious.camera } : {})
    : s.floorStyle === 'camera-frame' && sceneSetup?.frameStaging
    ? { floorCamera: sceneSetup.frameStaging.camera } : {}),
  floorMatch: s.frameStagingPending && s.frameStagingPrevious
    ? s.frameStagingPrevious.match : s.floorStyle === 'camera-frame' && sceneSetup?.frameStaging
    ? sceneSetup.frameStaging.floorMatch : s.floorMatch ?? 'fill',
});
