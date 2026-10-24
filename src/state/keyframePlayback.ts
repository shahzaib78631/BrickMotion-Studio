import { create } from 'zustand';

/** Frame-accurate, independent transport. The construction clock is never touched. */
export type KeyframeTransport = {
  frame: number;
  playing: boolean;
  loop: boolean;
  autoKey: boolean;
  set(next: Partial<Pick<KeyframeTransport, 'frame' | 'playing' | 'loop' | 'autoKey'>>): void;
};
export const useKeyframePlayback = create<KeyframeTransport>((set) => ({
  frame: 1, playing: false, loop: true, autoKey: false, set: (next) => set(next),
}));

export function advanceKeyframePlayback(dt: number, fps: number, start: number, end: number): number {
  const transport = useKeyframePlayback.getState();
  let frame = Math.max(start, Math.min(end, transport.frame));
  if (!transport.playing) return frame;
  frame += Math.max(0, dt) * fps;
  if (frame > end) {
    if (transport.loop) frame = start + (frame - start) % (end - start + 1);
    else { frame = end; transport.set({ frame, playing: false }); return frame; }
  }
  transport.set({ frame });
  return frame;
}
