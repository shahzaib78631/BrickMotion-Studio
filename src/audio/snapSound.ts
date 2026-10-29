import { snapsBetween, snapsOf, type Snap } from '../anim/snaps';
import type { Timeline } from '../anim/timeline';
import { chooseSample, clickFilter, loadSnapSamples, snapSamplesReady, snapSizeOf, type SnapSample } from './snapSamples';
import { DEFAULT_SOUND, type SoundSettings } from './soundSettings';

/**
 * The sound of a brick connecting. Normally a CC0 recording of a real brick snap (see
 * snapSamples.ts), picked by part size, filtered to the bright plastic click of product
 * videos and layered over a deep body thump. Until the recordings load, or where they
 * cannot, a synthesised snap stands in. That synthesis is modelled on recorded
 * product-video snaps, which are not one tick but a small event:
 *
 *   1. a short plastic scrape as the part slides onto the studs,
 *   2. a sharp click, then one to three more 15–25 ms apart as each row of studs seats,
 *   3. a hard-plastic ring (inharmonic modes around 4, 5.4, 7 and 8.3 kHz),
 *   4. a low body thump (~90–140 Hz) that carries most of the energy,
 *   5. a short room tail.
 *
 * The part sets the character: more studs give more clicks, a longer slide and a lower,
 * longer ring; a brick thumps deeper and louder than a plate. Every snap also varies a
 * little, repeatably, so a run of the same part does not sound machine-gunned.
 * Works on a live AudioContext and on an OfflineAudioContext (for the MP4).
 */

/** What a snap sounds like depends on these (see `Snap`). */
export type SnapVoice = { count: number; studs?: number; height?: number };

/** The parameters of one snap, from the size of the part(s) seating. */
export function snapCharacter(v: SnapVoice) {
  const studs = Math.min(64, Math.max(1, v.studs ?? 2));
  const tall = (v.height ?? 8) >= 20; // a brick (24 LDU), not a plate or tile (8)
  const size = Math.log2(studs); // 0 for 1x1, 3 for 2x4, 6 for 8x8
  return {
    clicks: studs <= 2 ? 2 : studs <= 6 ? 3 : 4,
    /** gap between stud-row clicks, s */
    gap: 0.014 + 0.003 * Math.min(size, 4),
    /** slide-in scrape before the first click, s */
    slide: 0.03 + 0.01 * Math.min(size, 4),
    /** ring pitch: small parts ring higher */
    pitch: (1.12 - 0.05 * size) * (tall ? 0.92 : 1),
    /** ring length, s */
    ring: 0.035 + 0.008 * size,
    thumpHz: (tall ? 105 : 135) - 6 * size,
    thump: (tall ? 0.75 : 0.5) + 0.05 * size,
    thumpDecay: (tall ? 0.2 : 0.14) + 0.012 * size,
  };
}

/** Small repeatable random numbers for one snap. */
function rng(seed: number): () => number {
  let s = (Math.imul(seed | 0, 2654435761) ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOISE_SECONDS = 0.5;
const noiseOf = new WeakMap<BaseAudioContext, AudioBuffer>();
function noise(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseOf.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
    const d = b.getChannelData(0);
    const r = rng(12345);
    for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
    noiseOf.set(ctx, b);
  }
  return b;
}

/** A short room: exponentially decaying stereo noise that darkens as it fades. */
function roomResponse(ctx: BaseAudioContext): AudioBuffer {
  const len = Math.ceil(ctx.sampleRate * 0.6);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    const r = rng(777 + c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sampleRate;
      // the one-pole low-pass closes over time, so the tail loses its highs first
      const k = Math.max(0.06, 0.9 - t * 3);
      lp += k * ((r() * 2 - 1) - lp);
      d[i] = lp * Math.exp(-t / 0.1) * (t < 0.004 ? t / 0.004 : 1);
    }
  }
  return b;
}

/** Dry and room sends for an output, made once per output node; each snap sets its own room level. */
type Bus = { dry: AudioNode; wet: AudioNode };
const busOf = new WeakMap<AudioNode, Bus>();
function busFor(ctx: BaseAudioContext, out: AudioNode): Bus {
  let bus = busOf.get(out);
  if (!bus) {
    const room = ctx.createConvolver();
    room.normalize = true;
    room.buffer = roomResponse(ctx);
    room.connect(out);
    bus = { dry: out, wet: room };
    busOf.set(out, bus);
  }
  return bus;
}

/** A decaying envelope on a new gain node: up to `peak` at `at`, near silence after `decay` s. */
function envelope(ctx: BaseAudioContext, at: number, peak: number, decay: number, attack = 0.0008): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(peak, at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  return g;
}

function noiseSource(ctx: BaseAudioContext, at: number, length: number, r: () => number): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  src.start(at, r() * (NOISE_SECONDS - length - 0.01), length + 0.01);
  return src;
}

/** One stud seating: a broadband crack plus the plastic's ringing modes. */
function click(ctx: BaseAudioContext, out: AudioNode, at: number, amp: number, pitch: number, ring: number, r: () => number) {
  const crack = noiseSource(ctx, at, 0.01, r);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1800;
  crack.connect(hp).connect(envelope(ctx, at, amp * 0.9, 0.004)).connect(out);
  const modes: [number, number, number][] = [[3900, 1, 1], [5350, 0.7, 0.75], [6900, 0.55, 0.55], [8300, 0.35, 0.4]];
  for (const [f, a, d] of modes) {
    const osc = ctx.createOscillator();
    osc.frequency.value = f * pitch * (1 + (r() - 0.5) * 0.04);
    osc.connect(envelope(ctx, at, amp * a * 0.35, ring * d)).connect(out);
    osc.start(at);
    osc.stop(at + ring * d + 0.01);
  }
}

/** The part landing: a pitch-dropping low tone and a short dull thud (the "dhup" under each click). */
function thump(ctx: BaseAudioContext, out: AudioNode, at: number, hz: number, amp: number, decay: number, r: () => number) {
  if (!(amp > 0)) return;
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(hz * 1.5, at);
  osc.frequency.exponentialRampToValueAtTime(hz, at + 0.03);
  osc.connect(envelope(ctx, at, amp, decay, 0.002)).connect(out);
  osc.start(at);
  osc.stop(at + decay + 0.01);
  const thud = noiseSource(ctx, at, 0.04, r);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 500;
  thud.connect(lp).connect(envelope(ctx, at, amp * 0.35, 0.03)).connect(out);
}

/** The part sliding onto the studs just before it seats: a rising plastic scrape. */
function slide(ctx: BaseAudioContext, out: AudioNode, at: number, length: number, pitch: number, r: () => number) {
  const start = Math.max(0, at - length);
  if (at - start < 0.005) return;
  const src = noiseSource(ctx, start, at - start, r);
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 3200 * pitch;
  band.Q.value = 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(0.05, at - 0.003);
  g.gain.linearRampToValueAtTime(0, at);
  src.connect(band).connect(g).connect(out);
}

/** One part (or a few landing together) seating at `at` (context time). */
function seat(ctx: BaseAudioContext, out: AudioNode, at: number, voice: SnapVoice, level: number, r: () => number, sound: SoundSettings) {
  const c = snapCharacter(sound.sizeMatch ? voice : { ...voice, studs: 2 });
  const pitch = (sound.sizePitch ? c.pitch : 1.05) * sound.pitch;
  const vary = (spread: number) => 1 + (r() - 0.5) * spread * sound.variation * 2;
  const clickLevel = level * sound.click;
  if (clickLevel > 0) {
    slide(ctx, out, at, c.slide * vary(0.3), pitch, r);
    // a faint catch as the first stud edge meets the socket
    click(ctx, out, at - c.slide * 0.45, 0.1 * clickLevel, pitch * 1.1, 0.01, r);
    let t = at;
    for (let i = 0; i < c.clicks; i++) {
      const amp = clickLevel * [1, 0.55, 0.4, 0.3][i] * vary(0.2);
      click(ctx, out, t, amp, pitch * (1 - i * 0.015), c.ring, r);
      t += c.gap * vary(0.4);
    }
  }
  bodyThump(ctx, out, at, c, level, r, sound);
}

/** The body under a snap, as the Sound panel sets it. */
function bodyThump(ctx: BaseAudioContext, out: AudioNode, at: number, c: ReturnType<typeof snapCharacter>, level: number, r: () => number, sound: SoundSettings) {
  const hz = c.thumpHz * sound.thumpPitch * (1 + (r() - 0.5) * 0.1 * sound.variation * 2);
  thump(ctx, out, at, hz, c.thump * level * sound.thump, c.thumpDecay * sound.thumpLength, r);
}

/**
 * Schedules one snap at `at` (context time). `voice` says how big the part is (studs,
 * height) and how many pieces land together; `variant` picks its small random variation.
 */
export function addSnap(ctx: BaseAudioContext, out: AudioNode, at: number, voice: SnapVoice = { count: 1 }, variant = 0, sound: SoundSettings = DEFAULT_SOUND) {
  const r = rng(variant);
  const bus = busFor(ctx, out);
  const pan = ctx.createStereoPanner();
  pan.pan.value = (r() - 0.5) * sound.stereo;
  const voiceOut = ctx.createGain();
  voiceOut.connect(pan);
  pan.connect(bus.dry);
  if (sound.room > 0) {
    const send = ctx.createGain();
    send.gain.value = sound.room;
    pan.connect(send).connect(bus.wet);
  }
  const count = Math.max(1, voice.count);
  // pieces landing together: the first full, the others a touch later and softer
  const per = { ...voice, studs: voice.studs !== undefined ? Math.max(1, Math.round(voice.studs / count)) : undefined };
  const samples = sound.source === 'recorded' ? usable(snapSamplesReady(), sound) : null;
  for (let i = 0; i < Math.min(count, Math.max(1, sound.together)); i++) {
    if (samples) recorded(ctx, voiceOut, at + i * 0.009, per, i ? 0.6 : 1, samples, r, sound);
    else seat(ctx, voiceOut, at + i * 0.009, per, i ? 0.6 : 1, r, sound);
  }
}

/** The loaded recordings from the chosen pack, or null for the synthesised click. */
function usable(samples: SnapSample[] | null, sound: SoundSettings): SnapSample[] | null {
  if (!samples) return null;
  const pick = sound.library === 'all' ? samples : samples.filter((s) => s.library === sound.library);
  return pick.length ? pick : samples;
}

/**
 * One part seating, from a recording: its loudest click lands at `at`, its own slide-in
 * plays just before. Bigger parts play lower and from the multi-click group; product-video
 * snaps keep the bright click and the deep thump and drop the boxy middle.
 */
function recorded(ctx: BaseAudioContext, out: AudioNode, at: number, voice: SnapVoice, level: number, samples: SnapSample[], r: () => number, sound: SoundSettings) {
  const c = snapCharacter(voice);
  const vary = (spread: number) => 1 + (r() - 0.5) * spread * sound.variation * 2;
  const sample = chooseSample(samples, sound.sizeMatch ? snapSizeOf(voice.studs ?? 2) : 'any', r());
  const rate = Math.min(2, Math.max(0.5, (sound.sizePitch ? c.pitch / 1.05 : 1) * sound.pitch * vary(0.03)));
  const clickLevel = 1.6 * sample.gain * level * sound.click * vary(0.1);
  if (clickLevel > 0) playRecording(ctx, out, at, sample, rate, clickLevel, sound.brightness);
  // the deep body under the click carries most of a product-video snap's weight
  bodyThump(ctx, out, at, c, level * RECORDED_THUMP, r, sound);
}

/** One recording through the click filter, its loudest moment landing at `at`. */
function playRecording(ctx: BaseAudioContext, out: AudioNode, at: number, sample: SnapSample, rate: number, gain: number, brightness: number) {
  const src = ctx.createBufferSource();
  src.buffer = sample.buffer;
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = gain;
  clickFilter(ctx, src, brightness).connect(g).connect(out);
  // start early by the recording's own lead-in; if that moment has passed, start part-way in
  const lead = sample.peak / rate;
  const start = at - lead;
  const now = ctx.currentTime;
  if (start >= now) src.start(start);
  else src.start(now, (now - start) * rate);
}

/** How much louder the body thump is under a recording than under the synthesised click. */
const RECORDED_THUMP = 1.0;

/** Peak level of a rendered MP4 snap track: just under full scale, like the reference videos. */
const TRACK_PEAK = 0.89;

/** The whole video's clicks as one stereo track, `duration` seconds long. */
export async function renderSnapTrack(snaps: Snap[], duration: number, sampleRate = 48000, sound: SoundSettings = DEFAULT_SOUND): Promise<AudioBuffer> {
  if (sound.source === 'recorded') await loadSnapSamples().catch(() => []);
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);
  const master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  snaps.forEach((s, i) => {
    if (s.t < duration) addSnap(ctx, master, s.t, s, i * 7919 + Math.round(s.t * 1000), sound);
  });
  const buffer = await ctx.startRendering();
  // loud and consistent like the references; the volume setting scales it (never past full scale)
  normalize(buffer, Math.min(0.99, TRACK_PEAK * sound.volume));
  return buffer;
}

/** Scales every channel so the loudest sample is `peak`. */
export function normalize(buffer: AudioBuffer, peak: number): void {
  let max = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) max = Math.max(max, Math.abs(d[i]));
  }
  if (!(max > 0)) return;
  const k = peak / max;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
}

// ---- live playback ----

/** at most this many clicks in one frame (a big jump while playing would otherwise blast) */
const MAX_PER_FRAME = 4;
/** a playhead jump longer than this is a seek or loop, not playback */
const MAX_STEP = 0.5;
/** snaps are scheduled this far ahead (s), longer than the longest lead-in of a recording */
const LOOKAHEAD = 0.2;

let live: { ctx: AudioContext; out: GainNode } | null = null;
let heard: { tl: Timeline; t: number } | null = null;

function liveOut() {
  if (!live) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    // a gentle limiter keeps overlapping snaps punchy without clipping
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -10;
    limit.knee.value = 6;
    limit.ratio.value = 6;
    limit.attack.value = 0.002;
    limit.release.value = 0.12;
    const out = ctx.createGain();
    out.gain.value = LIVE_GAIN;
    out.connect(limit).connect(ctx.destination);
    live = { ctx, out };
  }
  if (live.ctx.state === 'suspended') void live.ctx.resume().catch(() => {});
  return live;
}

/** Level of the live output at volume 1. */
const LIVE_GAIN = 0.45;

/**
 * Called once per rendered frame with the time shown: clicks for every piece that
 * seated since the last frame, when the animation is playing (`playing` as it was
 * before this frame's advance, so the final landing still sounds). Seeking,
 * scrubbing and looping back stay silent.
 */
export function soundSnaps(tl: Timeline, t: number, playing: boolean, enabled: boolean, sound: SoundSettings = DEFAULT_SOUND) {
  const prev = heard && heard.tl === tl ? heard.t : null;
  heard = { tl, t };
  if (!enabled || !playing || prev === null) return;
  const dt = t - prev;
  if (!(dt > 0) || dt > MAX_STEP) return;
  // look a little ahead: the slide-in starts before the part seats, so the click lands on its frame
  const due = snapsBetween(snapsOf(tl), prev + LOOKAHEAD, t + LOOKAHEAD);
  if (!due.length) return;
  const audio = liveOut();
  if (!audio || audio.ctx.state !== 'running') return;
  audio.out.gain.value = LIVE_GAIN * sound.volume;
  const now = audio.ctx.currentTime;
  for (const s of due.slice(-MAX_PER_FRAME)) addSnap(audio.ctx, audio.out, now + Math.max(0.005, s.t - t), s, Math.round(s.t * 1000), sound);
}

let tried = 0;
/** Plays one snap now, for the Sound panel's test buttons. */
export async function previewSnap(voice: SnapVoice, sound: SoundSettings): Promise<void> {
  if (sound.source === 'recorded') await loadSnapSamples().catch(() => []);
  const audio = liveOut();
  if (!audio) return;
  if (audio.ctx.state !== 'running') await audio.ctx.resume().catch(() => {});
  audio.out.gain.value = LIVE_GAIN * sound.volume;
  // a lead-in long enough for the recording's slide-in before its click
  addSnap(audio.ctx, audio.out, audio.ctx.currentTime + LOOKAHEAD, voice, ++tried * 7919, sound);
}

// Browsers only start sound after a user gesture: wake the output on the first click
// or key press, so the first landing after pressing Play is heard.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const wake = () => {
    void loadSnapSamples().catch(() => {});
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
