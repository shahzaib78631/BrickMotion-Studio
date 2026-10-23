import { get, set } from 'idb-keyval';
import type { ArrivalMode } from '../anim/pacing';
import type { LogoCorner } from '../export/exportVideo';
import { isExportFps, type ExportFps } from '../export/frameRates';
import type { StudioLook } from '../render/studio';
import type { CameraFraming } from '../anim/camera';
import { isVideoFormat, type VideoFormat } from '../export/formats';

export type Settings = {
  apiKey: string;
  model: string;
  logo: Blob | null;
  logoCorner: LogoCorner;
  logoEnabled: boolean;
  video: { targetSeconds: number; heroOrbit: boolean; mode: ArrivalMode | 'auto'; fps: ExportFps; introSeconds: number | null; buildSeconds: number | null; outroSeconds: number | null; studioLook: StudioLook; cameraFraming: CameraFraming; format: VideoFormat; edgeLines: boolean; linearColors: boolean; bottomUp: boolean; snapSound: boolean };
};

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: 'claude-opus-5-5',
  logo: null,
  logoCorner: 'br',
  logoEnabled: false,
  video: { targetSeconds: 15, heroOrbit: true, mode: 'auto', fps: 30, introSeconds: null, buildSeconds: null, outroSeconds: null, studioLook: 'soft', cameraFraming: 'cinematic', format: '9:16', edgeLines: true, linearColors: true, bottomUp: true, snapSound: true },
};

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const s = (await get<Partial<Settings>>(KEY)) ?? {};
  const video = { ...DEFAULT_SETTINGS.video, ...(s.video ?? {}) };
  if (!isExportFps(video.fps)) video.fps = DEFAULT_SETTINGS.video.fps;
  if (video.studioLook !== 'soft' && video.studioLook !== 'classic') video.studioLook = 'soft';
  if (video.cameraFraming !== 'cinematic' && video.cameraFraming !== 'wide') video.cameraFraming = 'cinematic';
  if (!isVideoFormat(video.format)) video.format = '9:16';
  if (typeof video.edgeLines !== 'boolean') video.edgeLines = DEFAULT_SETTINGS.video.edgeLines;
  if (typeof video.linearColors !== 'boolean') video.linearColors = DEFAULT_SETTINGS.video.linearColors;
  if (typeof video.bottomUp !== 'boolean') video.bottomUp = DEFAULT_SETTINGS.video.bottomUp;
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
