import { create } from 'zustand';
import type { ArrivalMode } from '../anim/pacing';
import type { LogoCorner } from '../export/exportVideo';

export type AnimSettings = {
  targetSeconds: number;
  heroOrbit: boolean;
  mode: 'auto' | ArrivalMode;
  logoEnabled: boolean;
  logoCorner: LogoCorner;
  /** decoded logo image; the PNG itself is kept by the settings store */
  logo: ImageBitmap | null;
  set(p: Partial<Omit<AnimSettings, 'set'>>): void;
};

export const useAnimSettings = create<AnimSettings>((set) => ({
  targetSeconds: 15,
  heroOrbit: true,
  mode: 'auto',
  logoEnabled: false,
  logoCorner: 'br',
  logo: null,
  set: (p) => set(p),
}));
