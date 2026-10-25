import { get, set } from 'idb-keyval';
import type { ArrivalMode, FloorSides, FloorSort } from '../anim/pacing';
import { isConstructionBudgetPreset, type ConstructionBudgetPreset } from '../anim/construction/budgetPresets';
import type { LogoCorner } from '../export/exportVideo';
import { isExportFps, type ExportFps } from '../export/frameRates';
import type { StudioLook } from '../render/studio';
import { DEFAULT_CAMERA_SETTINGS, type CameraFraming, type CameraSettings } from '../anim/camera';
import { isVideoFormat, type VideoFormat } from '../export/formats';

export type Settings = {
  apiKey: string;
  model: string;
  logo: Blob | null;
  logoCorner: LogoCorner;
  logoEnabled: boolean;
  video: { targetSeconds: number; heroOrbit: boolean; mode: ArrivalMode | 'auto'; fps: ExportFps; introSeconds: number | null; buildSeconds: number | null; outroSeconds: number | null; studioLook: StudioLook; cameraFraming: CameraFraming; camera: CameraSettings; format: VideoFormat; edgeLines: boolean; linearColors: boolean; bottomUp: boolean; snapSound: boolean; planner?: 'legacy' | 'construction-v2' | 'construction-auto' | 'construction-v3' | 'construction-v3-auto'; constructionSupport?: 'fixture' | 'table'; constructionBudget?: ConstructionBudgetPreset; constructionStepModules?: boolean; floorSort: FloorSort; floorSides: FloorSides };
};

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: 'claude-opus-5-5',
  logo: null,
  logoCorner: 'br',
  logoEnabled: false,
  video: { targetSeconds: 15, heroOrbit: true, mode: 'auto', fps: 30, introSeconds: null, buildSeconds: null, outroSeconds: null, studioLook: 'soft', cameraFraming: 'cinematic', camera: DEFAULT_CAMERA_SETTINGS, format: '9:16', edgeLines: true, linearColors: true, bottomUp: true, snapSound: true, planner: 'legacy', constructionSupport: 'fixture', constructionBudget: 'standard', constructionStepModules: false, floorSort: 'step', floorSides: 'front-back' },
};

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const s = (await get<Partial<Settings>>(KEY)) ?? {};
  const video = { ...DEFAULT_SETTINGS.video, ...(s.video ?? {}) };
  if (!isExportFps(video.fps)) video.fps = DEFAULT_SETTINGS.video.fps;
  if (video.studioLook !== 'soft' && video.studioLook !== 'classic') video.studioLook = 'soft';
  if (video.cameraFraming !== 'cinematic' && video.cameraFraming !== 'wide') video.cameraFraming = 'cinematic';
  video.camera = { ...DEFAULT_CAMERA_SETTINGS, ...(video.camera ?? {}) };
  delete (video.camera as Partial<Record<string, number>>).closeUpStrength; // replaced by submodelFocus
  const ranges: Record<keyof CameraSettings, [number, number]> = {
    lensMm: [18, 200], sensorWidthMm: [12, 70], buildAzimuth: [-180, 180], buildElevation: [15, 89],
    buildMargin: [1, 2], targetLock: [0, 1], submodelFocus: [0, 1], buildDrift: [-45, 45], damping: [0, 1],
    heroOrbitDegrees: [-360, 360], heroElevation: [5, 85], heroMargin: [1, 2],
  };
  for (const key of Object.keys(ranges) as (keyof CameraSettings)[]) {
    const [lo, hi] = ranges[key];
    const value = Number(video.camera[key]);
    video.camera[key] = Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : DEFAULT_CAMERA_SETTINGS[key];
  }
  if (!isVideoFormat(video.format)) video.format = '9:16';
  if (typeof video.edgeLines !== 'boolean') video.edgeLines = DEFAULT_SETTINGS.video.edgeLines;
  if (typeof video.linearColors !== 'boolean') video.linearColors = DEFAULT_SETTINGS.video.linearColors;
  if (typeof video.bottomUp !== 'boolean') video.bottomUp = DEFAULT_SETTINGS.video.bottomUp;
  if (video.constructionSupport !== 'table') video.constructionSupport = 'fixture';
  if (!isConstructionBudgetPreset(video.constructionBudget)) video.constructionBudget = 'standard';
  if (typeof video.constructionStepModules !== 'boolean') video.constructionStepModules = false;
  if (!['construction-v2', 'construction-auto', 'construction-v3', 'construction-v3-auto'].includes(video.planner ?? '')) video.planner = 'legacy';
  if (!['step', 'colour', 'part', 'size'].includes(video.floorSort)) video.floorSort = 'step';
  if (!['front-back', 'front', 'behind', 'sides'].includes(video.floorSides)) video.floorSides = 'front-back';
  if (typeof video.snapSound !== 'boolean') video.snapSound = DEFAULT_SETTINGS.video.snapSound;
  for (const key of ['introSeconds', 'buildSeconds', 'outroSeconds'] as const) {
    const value = video[key];
    if (value !== null && (!Number.isFinite(value) || value < (key === 'buildSeconds' ? 1 : 0.2) || value > 120)) video[key] = null;
  }
  return { ...DEFAULT_SETTINGS, ...s, video };
}

export async function saveSettings(s: Settings): Promise<void> {
  await set(KEY, s);
}
