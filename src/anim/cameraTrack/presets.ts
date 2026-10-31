/**
 * Transition presets: named camera moves from film practice. Choosing one fills in a
 * move's settings; every setting can then be changed. `key` is how the end key differs
 * from the start key when a preset is used to make a new key (e.g. Push in = closer).
 */
import type { CameraKey, CameraTransition, CurveKind, SpeedCurve, TransitionSettings, XYZ } from './types';

export type PresetKeyChange = {
  /** added to the start key's values */
  azimuth?: number; elevation?: number; roll?: number; lensMm?: number; blur?: number;
  /** absolute focus at the end key */
  focus?: number;
  /** end distance = start distance × this */
  distanceScale?: number;
  /** slide camera and aim together, as a fraction of the distance (camera right / up) */
  slide?: { x: number; y: number };
};
export type TransitionPreset = { id: string; label: string; hint: string; settings: TransitionSettings; key?: PresetKeyChange };

const curve = (kind: CurveKind, strength: number): SpeedCurve => ({ kind, strength });
const base: TransitionSettings = {
  curve: curve('easeInOut', 0.5), path: 'arc', orbit: 'shortest', extraTurns: 0, overshoot: 0,
  motionBlur: 0.5, shake: { amount: 0, frequency: 0.6 }, cut: false, flowThrough: false,
};
const with_ = (over: Partial<TransitionSettings>): TransitionSettings => ({ ...base, ...over, shake: { ...base.shake, ...over.shake } });

export const BUILT_IN_PRESETS: readonly TransitionPreset[] = [
  { id: 'glide', label: 'Smooth glide', hint: 'A calm, even move that eases in and out', settings: with_({}) },
  { id: 'push-in', label: 'Push in', hint: 'Moves closer to draw attention', settings: with_({ curve: curve('easeInOut', 0.6) }), key: { distanceScale: 0.7 } },
  { id: 'pull-back', label: 'Pull back', hint: 'Moves away to reveal more', settings: with_({ curve: curve('easeInOut', 0.6) }), key: { distanceScale: 1.4 } },
  { id: 'truck-left', label: 'Truck left', hint: 'Slides sideways to the left', settings: with_({ path: 'straight' }), key: { slide: { x: -0.25, y: 0 } } },
  { id: 'truck-right', label: 'Truck right', hint: 'Slides sideways to the right', settings: with_({ path: 'straight' }), key: { slide: { x: 0.25, y: 0 } } },
  { id: 'pedestal-up', label: 'Pedestal up', hint: 'Rises straight up', settings: with_({ path: 'straight' }), key: { slide: { x: 0, y: 0.25 } } },
  { id: 'pedestal-down', label: 'Pedestal down', hint: 'Lowers straight down', settings: with_({ path: 'straight' }), key: { slide: { x: 0, y: -0.25 } } },
  { id: 'crane-down', label: 'Crane down', hint: 'Swoops lower, tilting up to the model', settings: with_({ curve: curve('easeInOut', 0.7) }), key: { elevation: -25 } },
  { id: 'crane-up', label: 'Crane up', hint: 'Rises and looks down over the model', settings: with_({ curve: curve('easeInOut', 0.7) }), key: { elevation: 25 } },
  { id: 'orbit', label: 'Orbit around', hint: 'Circles round the model', settings: with_({ curve: curve('easeInOut', 0.4) }), key: { azimuth: 90 } },
  { id: 'arc-reveal', label: 'Arc reveal', hint: 'Swings round and settles on the front, slightly closer', settings: with_({ curve: curve('easeOut', 0.7), overshoot: 0.05 }), key: { azimuth: 60, distanceScale: 0.9 } },
  { id: 'swoop', label: 'Fast swoop', hint: 'A quick, blurred swing to a new angle that settles softly', settings: with_({ curve: curve('snap', 0.8), overshoot: 0.15, motionBlur: 0.8 }), key: { azimuth: 70, elevation: -20 } },
  { id: 'whip-pan', label: 'Whip pan', hint: 'A very fast, fully blurred turn', settings: with_({ curve: curve('easeInOut', 1), motionBlur: 1 }), key: { azimuth: 120 } },
  { id: 'dolly-zoom', label: 'Dolly zoom', hint: 'Moves back while zooming in: the model stays put, the background stretches', settings: with_({ curve: curve('easeInOut', 0.5), lensCurve: curve('easeInOut', 0.5) }), key: { lensMm: 50, distanceScale: 2 } },
  { id: 'rack-focus', label: 'Rack focus', hint: 'Shifts the sharp area to a new depth', settings: with_({ curve: curve('easeInOut', 0.3), lensCurve: curve('easeInOut', 0.8) }), key: { focus: 0.9, blur: 0.5 } },
  { id: 'dutch-in', label: 'Dutch tilt in', hint: 'Rolls the camera for a dramatic angle', settings: with_({}), key: { roll: 12 } },
  { id: 'handheld', label: 'Handheld drift', hint: 'A gentle move with a little handheld wobble', settings: with_({ curve: curve('linear', 0), shake: { amount: 0.8, frequency: 0.7 } }), key: { azimuth: 10 } },
  { id: 'hold', label: 'Hold', hint: 'Stays put until the next move', settings: with_({ curve: curve('holdThenMove', 1) }) },
  { id: 'cut', label: 'Hard cut', hint: 'Jumps straight to the next shot', settings: with_({ cut: true, motionBlur: 0 }) },
];

export const DEFAULT_TRANSITION: TransitionSettings = BUILT_IN_PRESETS[0].settings;

/** A user preset wins over a built-in with the same id; unknown ids fall back to the glide. */
export function presetById(id: string, user: readonly TransitionPreset[]): TransitionPreset {
  return user.find((p) => p.id === id) ?? BUILT_IN_PRESETS.find((p) => p.id === id) ?? BUILT_IN_PRESETS[0];
}

const cloneSettings = (s: TransitionSettings): TransitionSettings => JSON.parse(JSON.stringify(s));

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrapDeg = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/**
 * The end key a preset makes from the move's start key, so the move does what its name says
 * (Orbit turns, Push in gets closer…): the start view with the preset's change applied.
 * Only view values come back (never the end key's time or target). `distance` is roughly how
 * far the camera is, used for slides when the start key auto-fits. Null for presets with no
 * move of their own (glide, hold, cut, most saved presets): the end key stays as it is.
 */
export function endKeyForPreset(start: CameraKey, _end: CameraKey, p: TransitionPreset, distance: number): Partial<CameraKey> | null {
  const c = p.key;
  if (!c) return null;
  const scale = c.distanceScale ?? 1;
  const dist = start.distance.fit
    ? { fit: true as const, margin: round3(clamp(start.distance.margin * scale, 0.5, 4)) }
    : { fit: false as const, value: round3(Math.max(0, start.distance.value * scale)) };
  let offset: XYZ = [...start.offset];
  if (c.slide) {
    const d = start.distance.fit ? distance : start.distance.value;
    const a = (start.azimuth * Math.PI) / 180;
    // the camera's right, seen from azimuth a (camera at +Z looks towards −Z at azimuth 0)
    const right = [Math.cos(a), 0, -Math.sin(a)];
    offset = [offset[0] + right[0] * c.slide.x * d, offset[1] + c.slide.y * d, offset[2] + right[2] * c.slide.x * d];
  }
  return {
    azimuth: wrapDeg(start.azimuth + (c.azimuth ?? 0)),
    elevation: clamp(start.elevation + (c.elevation ?? 0), -85, 89),
    roll: clamp(start.roll + (c.roll ?? 0), -180, 180),
    lensMm: clamp(start.lensMm + (c.lensMm ?? 0), 8, 400),
    focus: c.focus ?? start.focus,
    blur: clamp(start.blur + (c.blur ?? 0), 0, 1),
    distance: dist,
    offset,
  };
}

/** Uses a preset for a move: its settings (copied), its name, and the move counts as edited. */
export function applyPreset(t: CameraTransition, p: TransitionPreset): CameraTransition {
  return { ...t, preset: p.id, settings: cloneSettings(p.settings), origin: 'user' };
}

const KINDS: readonly CurveKind[] = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'holdThenMove', 'snap'];
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isCurve = (v: unknown): v is SpeedCurve =>
  !!v && typeof v === 'object' && KINDS.includes((v as SpeedCurve).kind) && num((v as SpeedCurve).strength);

/** True for a well-formed settings object (used to sanitise saved presets). */
export function isTransitionSettings(v: unknown): v is TransitionSettings {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  const shake = s.shake as Record<string, unknown> | undefined;
  return isCurve(s.curve) && (s.aimCurve === undefined || isCurve(s.aimCurve)) && (s.lensCurve === undefined || isCurve(s.lensCurve))
    && (s.path === 'arc' || s.path === 'straight') && ['shortest', 'cw', 'ccw'].includes(s.orbit as string)
    && num(s.extraTurns) && num(s.overshoot) && num(s.motionBlur) && !!shake && num(shake.amount) && num(shake.frequency)
    && typeof s.cut === 'boolean' && typeof s.flowThrough === 'boolean'
    && (s.turnLast === undefined || (num(s.turnLast) && (s.turnLast as number) >= 0));
}
