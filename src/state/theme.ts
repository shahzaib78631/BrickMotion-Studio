import { useEffect, useState } from 'react';
import { create } from 'zustand';

/**
 * The workspace theme: light, dark or the system's choice, an accent colour, and the
 * tone of the neutral surfaces. Stored in this browser only; the tokens live in themes.css.
 */
export type ThemeMode = 'light' | 'dark' | 'system';
export type ThemeAccent = 'violet' | 'blue' | 'teal' | 'green' | 'orange' | 'rose' | 'mono';
export type ThemeSurface = 'cool' | 'neutral' | 'warm';

export const ACCENTS: { id: ThemeAccent; label: string; light: string; dark: string }[] = [
  { id: 'violet', label: 'Violet', light: '#602ee8', dark: '#7955ff' },
  { id: 'blue', label: 'Blue', light: '#2563eb', dark: '#4f8cff' },
  { id: 'teal', label: 'Teal', light: '#0f8a82', dark: '#2bb3a8' },
  { id: 'green', label: 'Green', light: '#1d8f4e', dark: '#34c172' },
  { id: 'orange', label: 'Orange', light: '#d9590f', dark: '#ff8a3d' },
  { id: 'rose', label: 'Rose', light: '#d4245e', dark: '#ff5c8d' },
  { id: 'mono', label: 'Graphite', light: '#18181b', dark: '#f4f4f5' },
];
export const SURFACES: { id: ThemeSurface; label: string; hint: string; light: [string, string]; dark: [string, string] }[] = [
  { id: 'cool', label: 'Cool', hint: 'Blue-grey surfaces', light: ['#f7f8fe', '#ffffff'], dark: ['#111322', '#191c2d'] },
  { id: 'neutral', label: 'Neutral', hint: 'Plain grey surfaces', light: ['#f5f5f4', '#ffffff'], dark: ['#0f0f11', '#18181b'] },
  { id: 'warm', label: 'Warm', hint: 'Paper-toned surfaces', light: ['#f7f3ec', '#fffdf9'], dark: ['#14110e', '#1c1915'] },
];

const KEYS = { mode: 'bm-theme', accent: 'bm-accent', surface: 'bm-surface' } as const;
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode: not remembered */
  }
};
const oneOf = <T extends string>(v: string | null, all: readonly T[], fallback: T): T => (all.includes(v as T) ? (v as T) : fallback);

type ThemeState = { mode: ThemeMode; accent: ThemeAccent; surface: ThemeSurface; set(patch: Partial<Pick<ThemeState, 'mode' | 'accent' | 'surface'>>): void };

export const useTheme = create<ThemeState>((set) => ({
  mode: oneOf(read(KEYS.mode), ['light', 'dark', 'system'] as const, 'light'),
  accent: oneOf(read(KEYS.accent), ACCENTS.map((a) => a.id), 'violet'),
  surface: oneOf(read(KEYS.surface), SURFACES.map((s) => s.id), 'cool'),
  set(patch) {
    for (const [k, v] of Object.entries(patch)) write(KEYS[k as keyof typeof KEYS], v as string);
    set(patch);
  },
}));

const systemDark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
export const resolveMode = (mode: ThemeMode, dark = systemDark()): 'light' | 'dark' => (mode === 'system' ? (dark ? 'dark' : 'light') : mode);

/** The attributes to put on the `.studio` root; follows the system when the mode is "system". */
export function useThemeAttrs(): { 'data-theme': 'light' | 'dark'; 'data-accent': ThemeAccent; 'data-surface': ThemeSurface } {
  const { mode, accent, surface } = useTheme();
  const [dark, setDark] = useState(systemDark);
  useEffect(() => {
    if (mode !== 'system' || typeof matchMedia !== 'function') return;
    const q = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(q.matches);
    on();
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, [mode]);
  return { 'data-theme': resolveMode(mode, dark), 'data-accent': accent, 'data-surface': surface };
}

/** The same, read once without React (the splash screen). */
export function themeAttrs() {
  const { mode, accent, surface } = useTheme.getState();
  return { 'data-theme': resolveMode(mode), 'data-accent': accent, 'data-surface': surface } as const;
}
