/** A compact, testable studio color profile sampled from the two supplied
 * references. RGB values are sRGB byte values, NOT linear-light floats. */
export const SOFT_STUDIO_GRADIENT = [
  { at: 0, rgb: [172, 171, 180] },
  { at: 0.30, rgb: [179, 178, 187] },
  { at: 0.58, rgb: [184, 183, 192] },
  { at: 0.83, rgb: [199, 198, 207] },
  { at: 1, rgb: [207, 206, 214] },
] as const;

/** Bottom-to-top RGBA pixels for Three.js DataTexture (2 × height).
 * A screen-aligned background prevents changes in the lighting color gradient
 * when users orbit or zoom the camera. */
export function studioGradientPixels(height = 256): Uint8Array {
  const pixels = new Uint8Array(2 * height * 4);
  for (let y = 0; y < height; y++) {
    const t = 1 - y / (height - 1);
    let next = 1;
    while (next < SOFT_STUDIO_GRADIENT.length - 1 && t > SOFT_STUDIO_GRADIENT[next].at) next++;
    const a = SOFT_STUDIO_GRADIENT[next - 1];
    const b = SOFT_STUDIO_GRADIENT[next];
    const f = Math.max(0, Math.min(1, (t - a.at) / (b.at - a.at)));
    for (let x = 0; x < 2; x++) {
      const offset = (y * 2 + x) * 4;
      for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = Math.round(a.rgb[channel] + (b.rgb[channel] - a.rgb[channel]) * f);
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}
