import { snapsBetween, snapsOf, type Snap } from '../anim/snaps';
import type { Timeline } from '../anim/timeline';

/**
 * The click of two bricks connecting, synthesised (no sound files): a sharp plastic
 * tick, a short second tick as the studs seat, and a small hollow body tone.
 * Works on a live AudioContext and on an OfflineAudioContext (for the MP4).
 */

const noiseOf = new WeakMap<BaseAudioContext, AudioBuffer>();
function noise(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseOf.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.05), ctx.sampleRate);
    const d = b.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < d.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      d[i] = (seed / 0x3fffffff - 1) * 0.9;
    }
    noiseOf.set(ctx, b);
  }
  return b;
}

/** a decaying envelope on a new gain node: up to `peak` at `at`, near silence after `decay` s */
function envelope(ctx: BaseAudioContext, at: number, peak: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(peak, at + 0.0015);
  g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
  return g;
}

function tick(ctx: BaseAudioContext, out: AudioNode, at: number, freq: number, q: number, peak: number, decay: number) {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = freq;
  band.Q.value = q;
  const g = envelope(ctx, at, peak, decay);
  src.connect(band).connect(g).connect(out);
  src.start(at);
  src.stop(at + decay + 0.01);
}

function tone(ctx: BaseAudioContext, out: AudioNode, at: number, freq: number, peak: number, decay: number) {
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(freq, at);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.8, at + decay);
  const g = envelope(ctx, at, peak, decay);
  osc.connect(g).connect(out);
  osc.start(at);
  osc.stop(at + decay + 0.01);
}

/** Schedules one connect click at `at` (context time); `count` pieces landing together sound a little fuller. */
export function addSnap(ctx: BaseAudioContext, out: AudioNode, at: number, count = 1, variant = 0) {
  // small, repeatable variation so a run of clicks doesn't sound machine-gunned
  const v = Math.sin(variant * 12.9898) * 43758.5453;
  const jitter = 1 + ((v - Math.floor(v)) - 0.5) * 0.16;
  const level = Math.min(1, 0.6 + 0.15 * (count - 1));
  tick(ctx, out, at, 3400 * jitter, 1.4, 0.9 * level, 0.025);
  tick(ctx, out, at + 0.012, 5200 * jitter, 2, 0.45 * level, 0.016);
  tone(ctx, out, at, 1300 * jitter, 0.18 * level, 0.045);
  tone(ctx, out, at, 210 * jitter, 0.22 * level, 0.04);
}

/** The whole video's clicks as one stereo track, `duration` seconds long. */
export async function renderSnapTrack(snaps: Snap[], duration: number, sampleRate = 48000): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);
  snaps.forEach((s, i) => {
    if (s.t < duration) addSnap(ctx, master, s.t, s.count, i);
  });
  return ctx.startRendering();
}

// ---- live playback ----

/** at most this many clicks in one frame (a big jump while playing would otherwise blast) */
const MAX_PER_FRAME = 4;
/** a playhead jump longer than this is a seek or loop, not playback */
const MAX_STEP = 0.5;

let live: { ctx: AudioContext; out: GainNode } | null = null;
let heard: { tl: Timeline; t: number } | null = null;

function liveOut() {
  if (!live) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    const out = ctx.createGain();
    out.gain.value = 0.6;
    out.connect(ctx.destination);
    live = { ctx, out };
  }
  if (live.ctx.state === 'suspended') void live.ctx.resume().catch(() => {});
  return live;
}

/**
 * Called once per rendered frame with the time shown: clicks for every piece that
 * seated since the last frame, when the animation is playing (`playing` as it was
 * before this frame's advance, so the final landing still sounds). Seeking,
 * scrubbing and looping back stay silent.
 */
export function soundSnaps(tl: Timeline, t: number, playing: boolean, enabled: boolean) {
  const prev = heard && heard.tl === tl ? heard.t : null;
  heard = { tl, t };
  if (!enabled || !playing || prev === null) return;
  const dt = t - prev;
  if (!(dt > 0) || dt > MAX_STEP) return;
  const due = snapsBetween(snapsOf(tl), prev, t);
  if (!due.length) return;
  const audio = liveOut();
  if (!audio || audio.ctx.state !== 'running') return;
  const now = audio.ctx.currentTime + 0.005;
  for (const s of due.slice(-MAX_PER_FRAME)) addSnap(audio.ctx, audio.out, now, s.count, Math.round(s.t * 1000));
}

// Browsers only start sound after a user gesture: wake the output on the first click
// or key press, so the first landing after pressing Play is heard.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const wake = () => {
    try {
      liveOut();
    } catch {
      /* no audio on this device */
    }
    window.removeEventListener('pointerdown', wake);
    window.removeEventListener('keydown', wake);
  };
  window.addEventListener('pointerdown', wake);
  window.addEventListener('keydown', wake);
}
