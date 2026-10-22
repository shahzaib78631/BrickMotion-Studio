export type Tool = 'select' | 'move';
export type Command =
  | { kind: 'move'; d: { x: number; y: number; z: number } }
  | { kind: 'rotate' }
  | { kind: 'delete' }
  | { kind: 'duplicate' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'tool'; tool: Tool };

type KeyLike = { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean };

/** Snaps a horizontal direction to the nearest grid axis. */
function snap(x: number, z: number) {
  const r = (v: number) => (Math.round(v) === 0 ? 0 : Math.round(v));
  return Math.abs(x) >= Math.abs(z) ? { x: r(Math.sign(x)), y: 0, z: 0 } : { x: 0, y: 0, z: r(Math.sign(z)) };
}

/**
 * Maps a key press to an editor command. Azimuth 0 means the camera sits on +Z looking toward −Z;
 * arrow keys move relative to the camera, snapped to the nearest axis. The view shows plan z flipped
 * (world z = −LDU z), so a world direction (x, z) is plan (x, −z).
 */
export function commandForKey(e: KeyLike, cameraAzimuthDeg: number): Command | null {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') return e.shiftKey ? { kind: 'redo' } : { kind: 'undo' };
  if (mod && e.key.toLowerCase() === 'd') return { kind: 'duplicate' };
  if (mod) return null;
  const a = (cameraAzimuthDeg * Math.PI) / 180;
  const fwd = { x: -Math.sin(a), z: Math.cos(a) };
  const right = { x: Math.cos(a), z: Math.sin(a) };
  switch (e.key) {
    case 'ArrowUp':
      return { kind: 'move', d: snap(fwd.x, fwd.z) };
    case 'ArrowDown':
      return { kind: 'move', d: snap(-fwd.x, -fwd.z) };
    case 'ArrowRight':
      return { kind: 'move', d: snap(right.x, right.z) };
    case 'ArrowLeft':
      return { kind: 'move', d: snap(-right.x, -right.z) };
    case 'PageUp':
      return { kind: 'move', d: { x: 0, y: 1, z: 0 } };
    case 'PageDown':
      return { kind: 'move', d: { x: 0, y: -1, z: 0 } };
    case 'r':
    case 'R':
      return { kind: 'rotate' };
    case 'v':
    case 'V':
      return { kind: 'tool', tool: 'select' };
    case 'm':
    case 'M':
      return { kind: 'tool', tool: 'move' };
    case 'Delete':
    case 'Backspace':
      return { kind: 'delete' };
  }
  return null;
}
