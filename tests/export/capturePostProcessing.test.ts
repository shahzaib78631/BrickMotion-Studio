import { expect, test } from 'vitest';
import { finishCapture, smoothCapture } from '../../src/export/capturePostProcessing';

test('film smoothing leaves uniform colour and alpha unchanged', () => {
  const pixels = new Uint8ClampedArray(Array.from({ length: 9 }, () => [120, 60, 200, 128]).flat());
  const before = pixels.slice();
  smoothCapture(pixels, 3, 3);
  expect(pixels).toEqual(before);
});

test('transparent edges retain their colour without dark fringes', () => {
  const pixels = new Uint8ClampedArray([0, 0, 0, 0, 240, 60, 20, 255, 0, 0, 0, 0]);
  smoothCapture(pixels, 3, 1);
  expect(pixels[3]).toBeGreaterThan(0);
  expect(pixels[7]).toBeLessThan(255);
  for (let i = 0; i < pixels.length; i += 4) expect(Array.from(pixels.slice(i, i + 3))).toEqual([240, 60, 20]);
});

test('disabled processing returns the original file without decoding', async () => {
  const blob = new Blob(['original'], { type: 'image/png' });
  expect(await finishCapture(blob, false)).toBe(blob);
});

test('uses the recovered Blackman–Harris window at width 1.5', async () => {
  const { blackmanHarrisCDF } = await import('../../src/dev/cyclesFilmMath');
  const pixels = new Uint8ClampedArray(5 * 5 * 4);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  pixels[(2 * 5 + 2) * 4] = 255;
  smoothCapture(pixels, 5, 5);
  const centreWeight = blackmanHarrisCDF(0.5, 1.5) - blackmanHarrisCDF(-0.5, 1.5);
  expect(pixels[(2 * 5 + 2) * 4]).toBe(Math.round(255 * centreWeight ** 2));
});
