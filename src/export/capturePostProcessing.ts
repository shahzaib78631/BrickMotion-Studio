import { blackmanHarrisCDF } from '../dev/cyclesFilmMath';
import { EYESIGHT_PIPELINE } from '../data/eyesightPipeline.generated';
import { drawLogo, type LogoCorner } from './exportVideo';

/** Image-space approximation of EyeSight's Blackman–Harris film reconstruction.
 * Integrate the recovered window over pixel footprints using Studio's film width.
 * A finished image has already been sampled: this is not native reconstruction
 * or EyeSight's pass-based denoiser. Work in
 * premultiplied alpha so transparent silhouettes do not acquire dark fringes.
 */
export function smoothCapture(data: Uint8ClampedArray, width: number, height: number): void {
  const filmWidth = EYESIGHT_PIPELINE.film.filterWidth;
  const radius = Math.ceil(filmWidth);
  const kernel = Array.from({ length: 2 * radius + 1 }, (_, i) => {
    const offset = i - radius;
    return blackmanHarrisCDF(offset + 0.5, filmWidth) - blackmanHarrisCDF(offset - 0.5, filmWidth);
  });
  const sum = kernel.reduce((a, b) => a + b, 0);
  const source = new Float32Array(data.length);
  const temp = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    for (let c = 0; c < 3; c++) source[i + c] = data[i + c] * a;
    source[i + 3] = data[i + 3];
  }
  for (const horizontal of [true, false]) {
    const input = horizontal ? source : temp;
    const output = horizontal ? temp : source;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        let value = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = horizontal ? Math.min(width - 1, Math.max(0, x + k)) : x;
          const sy = horizontal ? y : Math.min(height - 1, Math.max(0, y + k));
          value += input[(sy * width + sx) * 4 + c] * kernel[k + radius] / sum;
        }
        output[at + c] = value;
      }
    }
  }
  for (let i = 0; i < data.length; i += 4) {
    const a = source[i + 3];
    for (let c = 0; c < 3; c++) data[i + c] = a > 0 ? source[i + c] * 255 / a : 0;
    data[i + 3] = a;
  }
}

export async function finishCapture(blob: Blob, smooth: boolean, logo?: { image: ImageBitmap; corner: LogoCorner } | null): Promise<Blob> {
  if (!smooth && !logo) return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not create a canvas for capture processing.');
    ctx.drawImage(bitmap, 0, 0);
    if (smooth) {
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      smoothCapture(pixels.data, canvas.width, canvas.height);
      ctx.putImageData(pixels, 0, 0);
    }
    if (logo) drawLogo(ctx, logo.image, logo.corner, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (result) => result ? resolve(result) : reject(new Error('Could not encode the processed capture.')),
      blob.type, 0.92,
    ));
  } finally { bitmap.close(); }
}
