import { create } from 'zustand';

/** Where the build animation is (seconds) and whether it plays; shared by the preview and the timeline. */
export type Playback = { t: number; playing: boolean; set(p: Partial<Pick<Playback, 't' | 'playing'>>): void };

export const usePlayback = create<Playback>((set) => ({ t: 0, playing: false, set: (p) => set(p) }));
