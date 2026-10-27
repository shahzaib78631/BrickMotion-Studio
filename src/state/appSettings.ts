import { create } from 'zustand';
import type { AnimOptions, ArrivalMode, FloorSides, FloorSort } from '../anim/pacing';
import type { JointLimitRule } from '../anim/motion/v4/jointLimits';
import type { MechanismProgram } from '../anim/motion/v4/mechanismProgram';
import { CONSTRUCTION_BUDGET_PRESETS, type ConstructionBudgetPreset } from '../anim/construction/budgetPresets';
import type { LogoCorner } from '../export/exportVideo';
import type { ExportFps } from '../export/frameRates';
import type { StudioLook } from '../render/studio';
import type { CameraFraming, CameraSettings } from '../anim/camera';
import { DEFAULT_SETTINGS, type Settings } from '../storage/settings';
import type { VideoFormat } from '../export/formats';

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
  /** a click each time pieces connect, in playback and the MP4 */
  snapSound: boolean;
  introSeconds: number | null;
  buildSeconds: number | null;
  outroSeconds: number | null;
  mode: 'auto' | ArrivalMode;
  logoEnabled: boolean;
  logoCorner: LogoCorner;
  /** the floating quick-action bar over the viewport when parts are selected */
  showSelectionBar: boolean;
  /** MP4 camera: the automatic cinematics, or the camera the viewport plays. */
  exportCamera: 'automatic' | 'buildView';
  /** play the intro shot and hero orbit in the Build viewport as well as in the video */
  cameraFollowsPlayback: boolean;
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
  exportCamera: s.exportCamera ?? 'automatic',
  video: { targetSeconds: s.targetSeconds, heroOrbit: s.heroOrbit, mode: s.mode, fps: s.fps, introSeconds: s.introSeconds, buildSeconds: s.buildSeconds, outroSeconds: s.outroSeconds, studioLook: s.studioLook, cameraFraming: s.cameraFraming, camera: s.camera, format: s.format, edgeLines: s.edgeLines, linearColors: s.linearColors, bottomUp: s.bottomUp, snapSound: s.snapSound, planner: s.planner ?? 'legacy', constructionSupport: s.constructionSupport ?? 'fixture', constructionBudget: s.constructionBudget ?? 'standard', constructionStepModules: s.constructionStepModules === true, motionV4Limits: s.motionV4Limits ?? [], motionV4Mechanism: s.motionV4Mechanism ?? null, floorSort: s.floorSort, floorSides: s.floorSides },
});

export async function applySettings(s: Settings): Promise<void> {
  const logoBitmap = s.logo ? await createImageBitmap(s.logo).catch(() => null) : null;
  useAppSettings
    .getState()
    .set({ apiKey: s.apiKey, model: s.model, logo: s.logo, logoBitmap, logoCorner: s.logoCorner, logoEnabled: s.logoEnabled && !!logoBitmap, showSelectionBar: s.showSelectionBar, cameraFollowsPlayback: s.cameraFollowsPlayback, exportCamera: s.exportCamera ?? 'automatic', ...s.video });
}

/** The animation options the timeline planner needs, taken from the video settings. */
export const animOptions = (s: Pick<AppSettings, 'targetSeconds' | 'heroOrbit' | 'mode' | 'introSeconds' | 'buildSeconds' | 'outroSeconds' | 'bottomUp' | 'planner' | 'constructionSupport'> & Partial<Pick<AppSettings, 'constructionBudget' | 'constructionStepModules' | 'motionV4Limits' | 'motionV4Mechanism' | 'floorSort' | 'floorSides'>>): AnimOptions => ({
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
  floorSort: s.floorSort ?? 'step',
  floorSides: s.floorSides ?? 'front-back',
});
