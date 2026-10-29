/**
 * Recorded brick snaps (CC0, see public/sounds/snaps/CREDITS.txt), grouped by the size
 * of part they suit: short single clicks for small parts, multi-click presses for long
 * plates and big bricks. Decoded once and shared by the live preview and the MP4 export.
 */

export type SnapSize = 'small' | 'medium' | 'large';
export type SnapSample = { buffer: AudioBuffer; size: SnapSize; library: 'freesound' | 'opengameart'; /** seconds from the start to the loudest click */ peak: number; /** brings the filtered click to full scale */ gain: number };

/** The files in public/sounds/snaps and the part size each one suits. */
export const SNAP_FILES: { file: string; size: SnapSize }[] = [
  // single clean clicks (Freesound, rioforce)
  ...['fs-click-6', 'fs-click-7', 'fs-click-8', 'fs-click-9', 'fs-click-2', 'fs-click-4'].map((f) => ({ file: `${f}.wav`, size: 'small' as const })),
  // two clicks close together
  ...['fs-click-3', 'fs-click-5', 'fs-double-click-1', 'fs-double-click-2'].map((f) => ({ file: `${f}.wav`, size: 'medium' as const })),
  // longer presses that seat in several clicks (Freesound and OpenGameArt)
  ...['fs-double-click-3', 'fs-double-click-4', 'oga-brick-01', 'oga-brick-10', 'oga-brick-02'].map((f) => ({ file: `${f}.wav`, size: 'large' as const })),
];

/** Which pack a recording comes from, by its file name. */
export const libraryOf = (file: string): 'freesound' | 'opengameart' => (file.startsWith('fs-') ? 'freesound' : 'opengameart');

/** Which group a part's footprint belongs to. */
export const snapSizeOf = (studs: number): SnapSize => (studs <= 2 ? 'small' : studs <= 6 ? 'medium' : 'large');

let bank: Promise<SnapSample[]> | null = null;
let ready: SnapSample[] | null = null;

/** Where the click filter cuts by default, Hz (the Sound panel's "brightness"). */
const DEFAULT_CUTOFF = 3300;

/**
 * The tone of a product-video snap, applied to every recording: a steep cut below the
 * click (the references have almost nothing between 300 Hz and 3 kHz), a little
 * presence at the click itself, and softer air. The body comes from a separate thump.
 */
export function clickFilter(ctx: BaseAudioContext, input: AudioNode, cutoff = DEFAULT_CUTOFF): AudioNode {
  const stage = (type: BiquadFilterType, freq: number, q: number, gain = 0) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.gain.value = gain;
    return f;
  };
  return input
    .connect(stage('highpass', cutoff, 0.7))
    .connect(stage('highpass', cutoff, 0.7))
    .connect(stage('peaking', Math.max(cutoff * 1.45, 1500), 1, 3))
    .connect(stage('highshelf', 9000, 0.7, -6));
}

/** Where the filtered recording is loudest (the snap's landing moment) and how loud. */
async function measure(buffer: AudioBuffer): Promise<{ at: number; level: number }> {
  const ctx = new OfflineAudioContext(1, buffer.length, buffer.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  clickFilter(ctx, src).connect(ctx.destination);
  src.start();
  const d = (await ctx.startRendering()).getChannelData(0);
  let level = 0, at = 0;
  for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > level) { level = Math.abs(d[i]); at = i; }
  return { at: at / buffer.sampleRate, level };
}

/**
 * Recordings longer than `longer` seconds are rattles (a press that seats in a dozen
 * clicks): only `before`/`after` seconds around their loudest click are kept, with a
 * `fade` at each cut. That leaves one or two clicks, like the clean double clicks.
 */
export const CLICK_WINDOW = { longer: 0.25, before: 0.01, after: 0.03, fade: 0.008 };

/** A copy of `buffer` cut down to the click at `at` seconds, faded in and out. */
export function trimToClick(buffer: AudioBuffer, at: number): AudioBuffer {
  if (buffer.duration <= CLICK_WINDOW.longer) return buffer;
  const sr = buffer.sampleRate;
  const start = Math.max(0, Math.floor((at - CLICK_WINDOW.before) * sr));
  const end = Math.min(buffer.length, Math.ceil((at + CLICK_WINDOW.after) * sr));
  if (start === 0 && end === buffer.length) return buffer;
  const length = Math.max(1, end - start);
  const out = new AudioBuffer({ length, numberOfChannels: buffer.numberOfChannels, sampleRate: sr });
  const fadeIn = start > 0 ? Math.round(CLICK_WINDOW.fade * sr * 0.5) : 0;
  const fadeOut = end < buffer.length ? Math.round(CLICK_WINDOW.fade * sr) : 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c).slice(start, end);
    for (let i = 0; i < fadeIn && i < length; i++) data[i] *= i / fadeIn;
    for (let i = 0; i < fadeOut && i < length; i++) data[length - 1 - i] *= i / fadeOut;
    out.copyToChannel(data, c);
  }
  return out;
}

/** Loads and decodes every recording once; resolves to [] where audio or fetch is unavailable. */
export function loadSnapSamples(): Promise<SnapSample[]> {
  if (bank) return bank;
  bank = (async () => {
    if (typeof fetch !== 'function' || typeof OfflineAudioContext === 'undefined') return [];
    const decoder = new OfflineAudioContext(1, 1, 44100);
    const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
    const loaded = await Promise.all(SNAP_FILES.map(async ({ file, size }) => {
      try {
        const res = await fetch(`${base}sounds/snaps/${file}`);
        if (!res.ok) return null;
        const decoded = await decoder.decodeAudioData(await res.arrayBuffer());
        // only the landing click: some recordings rattle on for half a second, which
        // through the bright click filter sounds like a handful of coins
        const found = await measure(decoded);
        const buffer = trimToClick(decoded, found.at);
        // after the filter the recordings differ by ~10 dB: level them so every snap lands equally loud
        const m = await measure(buffer);
        return { buffer, size, library: libraryOf(file), peak: m.at, gain: m.level > 1e-4 ? 1 / m.level : 1 };
      } catch {
        return null;
      }
    }));
    ready = loaded.filter((s): s is SnapSample => !!s);
    return ready;
  })();
  return bank;
}

/** The decoded recordings, or null until loaded (the synthesised snap stands in meanwhile). */
export const snapSamplesReady = (): SnapSample[] | null => (ready && ready.length ? ready : null);

const last = new Map<SnapSize | 'any', SnapSample>();
/** A recording for this size, chosen by `pick` (0–1) and never the same one twice in a row. */
export function chooseSample(samples: SnapSample[], size: SnapSize | 'any', pick: number): SnapSample {
  let pool = size === 'any' ? samples : samples.filter((s) => s.size === size);
  if (!pool.length) pool = samples;
  const prev = last.get(size);
  if (pool.length > 1 && prev) pool = pool.filter((s) => s !== prev);
  const chosen = pool[Math.min(pool.length - 1, Math.floor(pick * pool.length))];
  last.set(size, chosen);
  return chosen;
}
