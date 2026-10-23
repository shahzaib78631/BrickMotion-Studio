import { create } from 'zustand';

/**
 * Where the build animation is (seconds) and whether it plays; shared by the preview, the
 * Build view and the timeline. `stopAt` ends playback at that time (playing one step);
 * `loop` restarts from `loopFrom` instead.
 *
 * `follow`: the Build view shows the build at `t` (with the editor's own camera) instead of
 * the still step layout. Playing, scrubbing or jumping on the timeline in the Build view
 * turns it on; picking a step to lay out (Steps panel, step card) turns it off.
 */
export type Playback = {
  t: number;
  playing: boolean;
  stopAt: number | null;
  loopFrom: number | null;
  follow: boolean;
  set(p: Partial<Pick<Playback, 't' | 'playing' | 'stopAt' | 'loopFrom' | 'follow'>>): void;
};

export const usePlayback = create<Playback>((set) => ({ t: 0, playing: false, stopAt: null, loopFrom: null, follow: false, set: (p) => set(p) }));

/** Plays [from, to] once (or looping), e.g. a single build step. */
export function playRange(from: number, to: number, loop = false) {
  usePlayback.getState().set({ t: Math.max(0, from), stopAt: to, loopFrom: loop ? Math.max(0, from) : null, playing: true, follow: true });
}

/**
 * Moves playback on by `dt` seconds (when playing) and returns the time to show:
 * stops at `stopAt` or the end, or loops back to `loopFrom`.
 */
export function advancePlayback(dt: number, duration: number): number {
  const pb = usePlayback.getState();
  let t = Math.min(pb.t, duration);
  if (!pb.playing) return t;
  t = Math.min(duration, t + dt);
  const end = Math.min(duration, pb.stopAt ?? duration);
  if (t >= end && pb.loopFrom !== null && end > pb.loopFrom) t = pb.loopFrom;
  else if (t >= end) {
    pb.set({ t: end, playing: false, stopAt: null, loopFrom: null });
    return end;
  }
  pb.set({ t });
  return t;
}
