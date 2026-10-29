/**
 * Everything about the connect sound the user can change. Playback in the app and the
 * MP4 export both read these, so what you hear while editing is what the video gets.
 */

/** Recorded brick snaps, or the synthesised click (no files needed). */
export type SoundSource = 'recorded' | 'synth';
/** Which recordings to draw from (see public/sounds/snaps/CREDITS.txt). */
export type SoundLibrary = 'all' | 'freesound' | 'opengameart';

export type SoundSettings = {
  /** overall loudness */
  volume: number;
  source: SoundSource;
  library: SoundLibrary;
  /** level of the plastic click */
  click: number;
  /** the click keeps only what is above this, Hz: higher is thinner and brighter */
  brightness: number;
  /** level of the low "dhup" body under each click; 0 turns it off */
  thump: number;
  /** pitch of that body, × its normal pitch */
  thumpPitch: number;
  /** how long the body rings, × its normal length */
  thumpLength: number;
  /** how much room echo follows each snap */
  room: number;
  /** pitch of every click, × normal */
  pitch: number;
  /** bigger parts play lower */
  sizePitch: boolean;
  /** small parts click once, big parts press in with several clicks */
  sizeMatch: boolean;
  /** how much each snap differs from the last in pitch and level, 0–1 */
  variation: number;
  /** most pieces heard when several land together */
  together: number;
  /** how far snaps spread left and right, 0–1 */
  stereo: number;
};

export const DEFAULT_SOUND: SoundSettings = {
  volume: 1,
  source: 'recorded',
  library: 'all',
  click: 1,
  brightness: 3300,
  thump: 0.5,
  thumpPitch: 1,
  thumpLength: 1,
  room: 0.2,
  pitch: 1,
  sizePitch: true,
  sizeMatch: true,
  variation: 0.5,
  together: 3,
  stereo: 0.25,
};

type NumberKey = { [K in keyof SoundSettings]: SoundSettings[K] extends number ? K : never }[keyof SoundSettings];

/** Slider limits for every number setting: [min, max, step]. */
export const SOUND_RANGES: Record<NumberKey, [number, number, number]> = {
  volume: [0, 1.5, 0.05],
  click: [0, 2, 0.05],
  brightness: [500, 6000, 100],
  thump: [0, 2, 0.05],
  thumpPitch: [0.5, 2, 0.05],
  thumpLength: [0.3, 2, 0.05],
  room: [0, 1, 0.05],
  pitch: [0.7, 1.4, 0.01],
  variation: [0, 1, 0.05],
  together: [1, 3, 1],
  stereo: [0, 1, 0.05],
};

/** Ready-made starting points. */
export const SOUND_PRESETS: { id: string; label: string; hint: string; sound: SoundSettings }[] = [
  { id: 'default', label: 'Balanced', hint: 'Recorded click with a soft body under it', sound: DEFAULT_SOUND },
  { id: 'product', label: 'Product video', hint: 'A deep body under a bright click, like brand build videos', sound: { ...DEFAULT_SOUND, thump: 1, room: 0.25 } },
  { id: 'click', label: 'Click only', hint: 'Just the plastic click: no body, almost no room', sound: { ...DEFAULT_SOUND, thump: 0, room: 0.08, brightness: 2500 } },
  { id: 'soft', label: 'Soft', hint: 'Quieter, warmer clicks for calm videos', sound: { ...DEFAULT_SOUND, volume: 0.7, click: 0.7, brightness: 1800, thump: 0.3, room: 0.3 } },
  { id: 'synth', label: 'Synthesised', hint: 'The generated click, no recordings', sound: { ...DEFAULT_SOUND, source: 'synth' } },
];

/** A stored value made safe: unknown or out-of-range fields fall back or are clamped. */
export function sanitizeSound(raw: unknown): SoundSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: SoundSettings = { ...DEFAULT_SOUND };
  for (const key of Object.keys(SOUND_RANGES) as NumberKey[]) {
    const v = Number(r[key]);
    const [lo, hi] = SOUND_RANGES[key];
    if (r[key] !== undefined && r[key] !== null && Number.isFinite(v)) out[key] = Math.min(hi, Math.max(lo, v));
  }
  out.together = Math.round(out.together);
  if (r.source === 'recorded' || r.source === 'synth') out.source = r.source;
  if (r.library === 'all' || r.library === 'freesound' || r.library === 'opengameart') out.library = r.library;
  if (typeof r.sizePitch === 'boolean') out.sizePitch = r.sizePitch;
  if (typeof r.sizeMatch === 'boolean') out.sizeMatch = r.sizeMatch;
  return out;
}
