import { describe, expect, it } from 'vitest';
import { maxBlurPx } from '../../src/render/depthOfField';

describe('lens blur size', () => {
  it('uses the named blur size when no exact size is given', () => {
    expect(maxBlurPx({ blur: 'medium', focus: 0.5 }, 1080)).toBe(10);
  });
  it('an exact size wins over the named one, scaled to the frame height', () => {
    expect(maxBlurPx({ blur: 'medium', focus: 0.5, px: 7 }, 1080)).toBe(7);
    expect(maxBlurPx({ blur: 'medium', focus: 0.5, px: 7 }, 2160)).toBe(14);
    expect(maxBlurPx({ blur: 'off', focus: 0.5, px: 0 }, 1080)).toBe(0);
  });
});

describe('frameRegion', () => {
  it('turns a CSS frame (top-left origin) into device pixels from the bottom left', async () => {
    const { frameRegion } = await import('../../src/render/depthOfField');
    // canvas 1000×800 CSS px at pixel ratio 2; frame 300×600 at (350, 100)
    expect(frameRegion({ x: 350, y: 100, width: 300, height: 600 }, 800, 2)).toEqual({ x: 700, y: 200, width: 600, height: 1200 });
  });
});
