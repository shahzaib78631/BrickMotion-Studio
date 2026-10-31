/**
 * The Camera track: camera keys (a view at a moment) and the transitions between them.
 * A key stores rig values (what it looks at, the angle round and above it, how far, the
 * lens), not a raw position, so moving between keys swings round the model naturally.
 * World units: studs, +Y up (see worldBox3).
 */
import type * as THREE from 'three';
import type { CamPose } from '../camera';

export type XYZ = [number, number, number];
/** What the camera looks at: the finished model, what is being built now, the piece landing, or a fixed point. */
export type CameraTarget = { kind: 'model' } | { kind: 'build' } | { kind: 'piece' } | { kind: 'point'; at: XYZ };
/** Auto-fit the target's box (times a margin), or a fixed distance in studs. */
export type CameraDistance = { fit: true; margin: number } | { fit: false; value: number };

export type CameraKey = {
  id: string;
  /** seconds on the video timeline */
  t: number;
  target: CameraTarget;
  /** world-space nudge of the aim point */
  offset: XYZ;
  /** degrees round the target, from +Z towards +X */
  azimuth: number;
  /** degrees above the target */
  elevation: number;
  distance: CameraDistance;
  /** Dutch tilt, degrees */
  roll: number;
  lensMm: number;
  /** 0 = nearest point of the model, 1 = farthest (as LensChoice.focus); 'target' = on what it looks at */
  focus: number | 'target';
  /** depth-of-field strength 0..1 */
  blur: number;
  /** 'auto': made by Auto-direct and untouched; 'user': created or edited by hand */
  origin: 'auto' | 'user';
};

export type CurveKind = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'holdThenMove' | 'snap';
/** How a move speeds up and slows down. `strength` 0..1 (0 is close to linear). */
export type SpeedCurve = { kind: CurveKind; strength: number };

export type TransitionSettings = {
  /** position (angle, height, distance, roll) */
  curve: SpeedCurve;
  /** what it looks at; defaults to `curve` */
  aimCurve?: SpeedCurve;
  /** lens, focus and blur; defaults to `curve` */
  lensCurve?: SpeedCurve;
  /** 'arc': swing round the target; 'straight': the camera slides along a line */
  path: 'arc' | 'straight';
  /** 'cw' turns azimuth up, 'ccw' down; 'shortest' takes the short way round */
  orbit: 'shortest' | 'cw' | 'ccw';
  /** whole extra turns for 'cw' / 'ccw' */
  extraTurns: number;
  /** push past the end and settle back, 0..1 */
  overshoot: number;
  /** shutter strength while moving, 0 = off, 0.5 ≈ 180°, 1 = 360° */
  motionBlur: number;
  /** handheld noise: amount in degrees, frequency in Hz */
  shake: { amount: number; frequency: number };
  /** no in-between: jump at the second key */
  cut: boolean;
  /** carry speed through the end key into the next move (both moves must flow) */
  flowThrough: boolean;
  /** seconds: hold the angle, then turn round only in the last this-many seconds of the move
   *  (height, distance and aim still glide over the whole gap); 0 or missing = the whole gap */
  turnLast?: number;
};

/** The move from key `from` to the key after it. */
export type CameraTransition = { from: string; to: string; preset: string; settings: TransitionSettings; origin: 'auto' | 'user' };

export type DirectorStyle = 'reference' | 'showcase' | 'turntable' | 'calm' | 'energetic' | 'overhead';

export type CameraTrack = {
  /** sorted by t, unique times */
  keys: CameraKey[];
  transitions: CameraTransition[];
  /** shutter when the camera holds still (pieces still move), 0..1 */
  shutter: number;
  style?: DirectorStyle;
};

/** Which video a track belongs to: the Build animation or the keyframe Timeline. */
export type CameraClock = 'build' | 'timeline';
/** Per editable model. */
export type CameraTracks = Record<string, Partial<Record<CameraClock, CameraTrack>>>;

/** What the sampler needs to know about the scene at a time. */
export type CameraContext = {
  aspect: number;
  sensorMm: number;
  duration: number;
  modelBox: THREE.Box3;
  buildBox(t: number): THREE.Box3;
  pieceBox(t: number): THREE.Box3 | null;
};

/** A camera pose plus everything else the track decides for that frame. */
export type CameraShot = CamPose & { roll: number; lensMm: number; focus: number; blur: number; shutter: number };
