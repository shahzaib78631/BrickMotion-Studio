import { get, set } from 'idb-keyval';
import type { ArrivalMode } from '../anim/pacing';
import type { LogoCorner } from '../export/exportVideo';
import { isExportFps, type ExportFps } from '../export/frameRates';

export type Settings = {
  apiKey: string;
  model: string;
  logo: Blob | null;
  logoCorner: LogoCorner;
  logoEnabled: boolean;
  video: { targetSeconds: number; heroOrbit: boolean; mode: ArrivalMode | 'auto'; fps: ExportFps; introSeconds: number | null; buildSeconds: number | null; outroSeconds: number | null };
};

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: 'claude-opus-5-5',
  logo: null,
  logoCorner: 'br',
  logoEnabled: false,
  video: { targetSeconds: 15, heroOrbit: true, mode: 'auto', fps: 30, introSeconds: null, buildSeconds: null, outroSeconds: null },
};

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const s = (await get<Partial<Settings>>(KEY)) ?? {};
  const video = { ...DEFAULT_SETTINGS.video, ...(s.video ?? {}) };
  if (!isExportFps(video.fps)) video.fps = DEFAULT_SETTINGS.video.fps;
  for (const key of ['introSeconds', 'buildSeconds', 'outroSeconds'] as const) {
    const value = video[key];
    if (value !== null && (!Number.isFinite(value) || value < (key === 'buildSeconds' ? 1 : 0.2) || value > 120)) video[key] = null;
  }
  return { ...DEFAULT_SETTINGS, ...s, video };
}

export async function saveSettings(s: Settings): Promise<void> {
  await set(KEY, s);
}
