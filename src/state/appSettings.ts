import { create } from 'zustand';
import type { ArrivalMode } from '../anim/pacing';
import type { LogoCorner } from '../export/exportVideo';

export type AppSettings = {
  /** Claude API key, stored only in this browser */
  apiKey: string;
  model: string;
  targetSeconds: number;
  heroOrbit: boolean;
  mode: 'auto' | ArrivalMode;
  logoEnabled: boolean;
  logoCorner: LogoCorner;
  /** decoded logo image; the PNG itself is kept by the settings store */
  logo: ImageBitmap | null;
  set(p: Partial<Omit<AppSettings, 'set'>>): void;
};

export const useAppSettings = create<AppSettings>((set) => ({
  apiKey: '',
  model: 'claude-opus-5-5',
  targetSeconds: 15,
  heroOrbit: true,
  mode: 'auto',
  logoEnabled: false,
  logoCorner: 'br',
  logo: null,
  set: (p) => set(p),
}));
