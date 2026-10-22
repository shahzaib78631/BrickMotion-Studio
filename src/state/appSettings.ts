import { create } from 'zustand';
import type { ArrivalMode } from '../anim/pacing';
import type { LogoCorner } from '../export/exportVideo';
import { DEFAULT_SETTINGS, type Settings } from '../storage/settings';

export type AppSettings = {
  /** Claude API key, stored only in this browser */
  apiKey: string;
  model: string;
  targetSeconds: number;
  heroOrbit: boolean;
  mode: 'auto' | ArrivalMode;
  logoEnabled: boolean;
  logoCorner: LogoCorner;
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
  video: { targetSeconds: s.targetSeconds, heroOrbit: s.heroOrbit, mode: s.mode },
});

export async function applySettings(s: Settings): Promise<void> {
  const logoBitmap = s.logo ? await createImageBitmap(s.logo).catch(() => null) : null;
  useAppSettings.getState().set({ apiKey: s.apiKey, model: s.model, logo: s.logo, logoBitmap, logoCorner: s.logoCorner, logoEnabled: s.logoEnabled && !!logoBitmap, ...s.video });
}
