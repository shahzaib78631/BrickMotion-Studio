/**
 * The way a piece comes in to its seat, as the editor shows and edits it.
 *
 * A "way" is the outward unit direction from the seated piece toward where it
 * comes from, in the model's LDraw frame (−Y is up). It is what the plan stores
 * as `insertionAxis`. The editor shows it with Y up (plan units), so `toShown`
 * and `fromShown` flip Y.
 */
import type { Timeline } from './timeline';

export type Way = [number, number, number];

/** from above (LDraw −Y is up) */
export const FROM_ABOVE: Way = [0, -1, 0];

const unit = (v: readonly number[]): Way | null => {
  const len = Math.hypot(v[0], v[1], v[2]);
  return Number.isFinite(len) && len > 1e-6 ? [v[0] / len + 0, v[1] / len + 0, v[2] / len + 0] : null;
};

/**
 * The way the planned animation brings this piece in: the last stretch of its
 * flight path, or its side entry, or from above. Null when the piece does not fly.
 */
export function plannedWay(tl: Timeline | null | undefined, key: string): Way | null {
  const move = tl?.tracks.get(key)?.moves[0];
  if (!move || move.stationary) return null;
  const path = move.posePath;
  if (path && path.length > 1) {
    const a = path[path.length - 2].elements, b = path[path.length - 1].elements;
    const w = unit([a[12] - b[12], a[13] - b[13], a[14] - b[14]]);
    if (w) return w;
  }
  if (move.translationPath && move.translationPath.length > 1) {
    const p = move.translationPath, a = p[p.length - 2], b = p[p.length - 1];
    const w = unit([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
    if (w) return w;
  }
  return unit(move.entry) ?? FROM_ABOVE;
}

/** LDraw way → the X/Y/Z the editor shows (Y up). */
export const toShown = (w: Way): Way => [w[0] + 0, -w[1] + 0, w[2] + 0];
/** The X/Y/Z the editor shows (Y up) → LDraw way; null for a zero vector. */
export const fromShown = (v: readonly number[]): Way | null => unit([v[0], -v[1], v[2]]);

/** Snaps to the nearest axis when within `degrees` of it, else returns the way unchanged. */
export function snapWay(w: Way, degrees = 8): Way {
  const k = [0, 1, 2].reduce((a, i) => (Math.abs(w[i]) > Math.abs(w[a]) ? i : a), 0);
  if (Math.abs(w[k]) < Math.cos((degrees * Math.PI) / 180)) return w;
  const out: Way = [0, 0, 0];
  out[k] = Math.sign(w[k]);
  return out;
}

/** A short name for a way, for buttons and readouts ("from above", "from +X", "tilted"). */
export function wayLabel(w: Way): string {
  const s = snapWay(w, 1);
  if (s === w) return 'angled';
  if (s[1] < 0) return 'from above';
  if (s[1] > 0) return 'from below';
  if (s[0]) return s[0] > 0 ? 'from +X' : 'from −X';
  return s[2] > 0 ? 'from +Z' : 'from −Z';
}

type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';
const TILT = (15 * Math.PI) / 180;

/** Rotates `v` about unit `axis` by `angle` (Rodrigues). */
function rotate(v: Way, axis: Way, angle: number): Way {
  const c = Math.cos(angle), s = Math.sin(angle);
  const d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  const x: Way = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]];
  return unit([0, 1, 2].map((k) => v[k] * c + x[k] * s + axis[k] * d * (1 - c)))!;
}

/**
 * Arrow keys while aiming a piece's way in, relative to the camera (azimuth 0:
 * camera on +Z looking toward −Z, as in keymap.ts):
 * - an arrow alone: come in from that side of the view (↑ from behind the model,
 *   ↓ from the camera's side, ← / → from the left / right), snapped to a grid axis;
 * - Shift+↑ / Shift+↓: from above / from below;
 * - Alt+arrow: tilt the current way 15° (← / → turn it around the vertical, ↑ / ↓ raise or lower it).
 */
export function wayForArrow(key: ArrowKey, mods: { shift?: boolean; alt?: boolean }, cameraAzimuthDeg: number, current: Way): Way {
  if (mods.shift && (key === 'ArrowUp' || key === 'ArrowDown')) return key === 'ArrowUp' ? FROM_ABOVE : [0, 1, 0];
  const a = (cameraAzimuthDeg * Math.PI) / 180;
  if (mods.alt) {
    if (key === 'ArrowLeft' || key === 'ArrowRight') return rotate(current, [0, -1, 0], key === 'ArrowLeft' ? TILT : -TILT);
    // raise / lower: turn about the horizontal axis across the way (or across the view when it points straight up/down)
    let across = unit([current[2], 0, -current[0]]);
    if (!across) across = unit([Math.cos(a), 0, Math.sin(a)])!;
    const turned = rotate(current, across, TILT);
    const up = key === 'ArrowUp';
    // pick the turn that moves the way toward (or away from) above
    return (turned[1] < current[1]) === up ? turned : rotate(current, across, -TILT);
  }
  // keymap.ts: ↑ moves a piece away from the camera along (−sin a, cos a) in plan x/z (= LDraw x/z)
  const away: [number, number] = [-Math.sin(a), Math.cos(a)];
  const right: [number, number] = [Math.cos(a), Math.sin(a)];
  const dir = key === 'ArrowUp' ? away : key === 'ArrowDown' ? [-away[0], -away[1]] : key === 'ArrowRight' ? right : [-right[0], -right[1]];
  return Math.abs(dir[0]) >= Math.abs(dir[1]) ? [Math.sign(dir[0]), 0, 0] : [0, 0, Math.sign(dir[1])];
}
