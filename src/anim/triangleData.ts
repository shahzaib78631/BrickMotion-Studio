/** Immutable triangle coefficients shared by collision queries. Double precision
 * preserves the original arithmetic; meshes and sample counts stay unchanged. */
const cache = new WeakMap<Float32Array, Float64Array>();
export function triangleData(tris: Float32Array): Float64Array {
  let data = cache.get(tris);
  if (data) return data;
  data = new Float64Array(tris.length / 9 * 10);
  for (let i = 0, j = 0; i < tris.length; i += 9, j += 10) {
    const ax = tris[i + 3] - tris[i], ay = tris[i + 4] - tris[i + 1], az = tris[i + 5] - tris[i + 2];
    const bx = tris[i + 6] - tris[i], by = tris[i + 7] - tris[i + 1], bz = tris[i + 8] - tris[i + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    data[j] = ax; data[j + 1] = ay; data[j + 2] = az;
    data[j + 3] = bx; data[j + 4] = by; data[j + 5] = bz;
    data[j + 6] = nx; data[j + 7] = ny; data[j + 8] = nz;
    data[j + 9] = nx * nx + ny * ny + nz * nz;
  }
  cache.set(tris, data);
  return data;
}
