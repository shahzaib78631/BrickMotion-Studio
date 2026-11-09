/**
 * A small controlled scene for calibrating the viewport against EyeSight: colour swatches,
 * a white tower, a round brick, a flat tile and a 45° brick, so one image per camera angle
 * shows how every kind of surface is lit. Positions are LDraw units (Y down); part origins
 * are at the top of the part. Shared by the EyeSight script and the viewport page.
 */
export type CalibPiece = { key: string; part: string; color: number; x: number; y: number; z: number; rotY?: number };

const swatches = [15, 0, 4, 19, 71].map((color, i): CalibPiece => ({ key: `sw${i}`, part: '3003', color, x: -160 + i * 60, y: 0, z: 0 }));
export const CALIB_PIECES: readonly CalibPiece[] = [
  ...swatches,
  { key: 'tower0', part: '3003', color: 15, x: -160, y: 0, z: -120 },
  { key: 'tower1', part: '3003', color: 15, x: -160, y: -24, z: -120 },
  { key: 'tower2', part: '3003', color: 15, x: -160, y: -48, z: -120 },
  { key: 'tile', part: '3068b', color: 15, x: -160, y: -80, z: -120 },
  { key: 'round', part: '3941', color: 15, x: -40, y: 0, z: -120 },
  { key: 'turned', part: '3003', color: 15, x: 80, y: 0, z: -120, rotY: 45 },
  { key: 'redTile', part: '3068b', color: 4, x: 20, y: -8, z: -120 },
];

/** Scene centre in app world studs (+Y up). */
export const CALIB_CENTER: readonly [number, number, number] = [-40 / 20, 0.6, 60 / 20];

/** Camera orbiting the centre: azimuth in degrees about +Y, 25° up, 25 studs away. */
export function calibCamera(azDeg: number): { position: [number, number, number]; target: [number, number, number]; fov: number } {
  const az = (azDeg * Math.PI) / 180, el = (25 * Math.PI) / 180, d = 25;
  const [cx, cy, cz] = CALIB_CENTER;
  return {
    position: [cx + d * Math.cos(el) * Math.sin(az), cy + d * Math.sin(el), cz + d * Math.cos(el) * Math.cos(az)],
    target: [cx, cy, cz],
    fov: 30,
  };
}
