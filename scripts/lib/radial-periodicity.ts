import { sectionAtY } from './accessory-geometry';

/** Measure outer surface periodicity in sections about a supplied local axis.
 * Rounded angular sampling describes the CAD profile. Pitch radius and mating
 * geometry require additional evidence. */
export function radialPeriodicity(triangles: number[], axis: 'Y' | 'Z', stations: number[]) {
  const local = triangles.slice();
  if (axis === 'Z') for (let i = 0; i < local.length; i += 3) {
    const y = local[i + 1];
    local[i + 1] = local[i + 2]; local[i + 2] = -y;
  }
  const angles = Array.from({ length: 720 }, (_, i) => 2 * Math.PI * (i + 0.35) / 720);
  return stations.map(station => {
    const { segments } = sectionAtY(local, station);
    const radii = angles.map(theta => {
      const x = Math.cos(theta), y = Math.sin(theta);
      let farthest = 0;
      for (const [a, b] of segments) {
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const denominator = x * dy - y * dx;
        if (Math.abs(denominator) < 1e-9) continue;
        const segmentPosition = (a[0] * y - a[1] * x) / denominator;
        if (segmentPosition < 0 || segmentPosition > 1) continue;
        farthest = Math.max(farthest, (a[0] * dy - a[1] * dx) / denominator);
      }
      return farthest;
    });
    if (radii.some(radius => radius <= 0)) return { station, status: 'incomplete-radial-section' };
    const mean = radii.reduce((sum, value) => sum + value, 0) / radii.length;
    const harmonics = Array.from({ length: 78 }, (_, i) => {
      const repeats = i + 3;
      let cos = 0, sin = 0;
      for (const [sample, theta] of angles.entries()) {
        const height = radii[sample] - mean;
        cos += height * Math.cos(repeats * theta);
        sin += height * Math.sin(repeats * theta);
      }
      return { repeats, amplitudeLdu: 2 * Math.hypot(cos, sin) / radii.length };
    }).sort((a, b) => b.amplitudeLdu - a.amplitudeLdu);
    return { station, status: 'measured-section', minRadiusLdu: Math.min(...radii), maxRadiusLdu: Math.max(...radii),
      strongestHarmonics: harmonics.slice(0, 4) };
  });
}
