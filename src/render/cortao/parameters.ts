import type { OrthographicCamera, PerspectiveCamera } from 'three';
import { Vector4 } from 'three';

/** Column-major equivalent of CORTAO's populateMainPassParameters. */
export function cortaoParameters(camera: PerspectiveCamera | OrthographicCamera, width: number, height: number, radius: number) {
  const p = camera.projectionMatrix.elements, inv = camera.projectionMatrixInverse.elements;
  const perspective = 'isPerspectiveCamera' in camera && camera.isPerspectiveCamera === true;
  const apparent = inv[5] * 0.2 * 2;
  return {
    packedResolution: (width | (height << 16)) >>> 0,
    randomSeed: 0,
    normalBias: inv[0] / width * Math.SQRT2,
    radius,
    unprojectParams: new Vector4(2 * inv[0], 2 * inv[5],
      perspective ? (p[8] - 1) / p[0] : -inv[0] + inv[12],
      perspective ? (p[9] - 1) / p[5] : -inv[5] + inv[13]),
    projectionParams: new Vector4(0.5 * p[0], 0.5 * p[5], -0.5 + 0.5 * p[8], -0.5 + 0.5 * p[9]),
    maxApparentCircleRadiusCoefficient: apparent / Math.sqrt(apparent * apparent + 1),
    mipBias: Math.log2(p[5] * height * 0.5) - 4,
    inverseMaxSlopeCompensation: 0.25,
    backfaceThreshold: 0.5,
    backfaceBoost: 0.5,
    _padding0: 0, _padding1: 0, _padding2: 0,
  };
}

/** Direct equivalent of populatePrepassParameters, including infinite clips. */
export function cortaoPrepassParameters(camera: PerspectiveCamera | OrthographicCamera, width: number, height: number, mipCount: number, randomSeed = 0) {
  const perspective = 'isPerspectiveCamera' in camera && camera.isPerspectiveCamera === true;
  const near = camera.near, far = camera.far;
  let depthScale: number, depthOffset: number;
  if (!perspective) { depthScale = far - near; depthOffset = near; }
  else if (!Number.isFinite(near)) { depthScale = 1 / far; depthOffset = 0; }
  else if (!Number.isFinite(far)) { depthScale = -1 / near; depthOffset = 1 / near; }
  else { depthScale = (near - far) / (near * far); depthOffset = 1 / near; }
  return { packedResolution: (width | height << 16) >>> 0, randomSeed, mipCount, depthScale, depthOffset,
    _padding0: 0, _padding1: 0, _padding2: 0 };
}
