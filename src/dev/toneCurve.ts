/**
 * A per-channel tone curve fitted to an EyeSight reference, applied as an SVG
 * feComponentTransfer table filter on the canvas (GPU, zero per-frame cost).
 *
 * The path tracer renders linear light with no tone mapping, which keeps saturated reds
 * red instead of ACES's orange skew. The display transform is then fitted from the
 * reference stills, per channel, by RMSE — the same monotone piecewise-linear fit the
 * viewport's referenceFit uses, reused here.
 */
import { fitTone, toneAt } from './referenceFitMath';

export type ToneObs = { x: number; y: number; weight: number };
export type ToneCurves = { r: number[]; g: number[]; b: number[] };

/** Fits one monotone curve per channel from (scene, reference) display-value pairs. */
export function fitChannelCurves(obs: { r: ToneObs[]; g: ToneObs[]; b: ToneObs[] }): ToneCurves {
  return { r: fitTone(obs.r), g: fitTone(obs.g), b: fitTone(obs.b) };
}

/** Samples a curve into the 17 table entries feComponentTransfer interpolates between. */
function table(curve: number[], n = 17): string {
  return Array.from({ length: n }, (_, i) => toneAt(i / (n - 1), curve).toFixed(5)).join(' ');
}

const NS = 'http://www.w3.org/2000/svg';
const ID = 'bm-tone';

function feFunc(channel: string): SVGElement {
  const f = document.createElementNS(NS, `feFunc${channel}`) as SVGElement;
  f.setAttribute('type', 'table');
  f.setAttribute('tableValues', '');
  return f;
}

/** Creates (once) and updates the SVG tone filter. */
export function ensureToneFilter(curves: ToneCurves): void {
  let svg = document.getElementById(`${ID}-svg`) as SVGSVGElement | null;
  if (!svg) {
    svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
    svg.id = `${ID}-svg`;
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    const filter = document.createElementNS(NS, 'filter') as SVGFilterElement;
    filter.id = ID;
    // The fit is in display (sRGB) bytes, so the transfer must act in sRGB, not linearRGB.
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const transfer = document.createElementNS(NS, 'feComponentTransfer');
    transfer.append(feFunc('R'), feFunc('G'), feFunc('B'));
    const alpha = feFunc('A');
    alpha.setAttribute('type', 'identity');
    transfer.append(alpha);
    filter.append(transfer);
    svg.append(filter);
    document.body.append(svg);
  }
  const set = (channel: string, curve: number[]) => {
    const f = svg!.querySelector(`feFunc${channel}`);
    f?.setAttribute('tableValues', table(curve));
  };
  set('R', curves.r); set('G', curves.g); set('B', curves.b);
}

/** Points the canvas at the fitted filter. */
export function applyToneFilter(canvas: HTMLCanvasElement, curves: ToneCurves): void {
  ensureToneFilter(curves);
  canvas.style.filter = `url(#${ID})`;
}

/** Builds per-channel (x, y, weight) observations from two same-size RGBA buffers. */
export function gatherObservations(scene: Uint8ClampedArray, reference: Uint8ClampedArray, weightOf: (i: number) => number): { r: ToneObs[]; g: ToneObs[]; b: ToneObs[] } {
  const r: ToneObs[] = [], g: ToneObs[] = [], b: ToneObs[] = [];
  for (let i = 0; i < scene.length; i += 4) {
    const w = weightOf(i);
    if (w <= 0) continue;
    r.push({ x: scene[i] / 255, y: reference[i] / 255, weight: w });
    g.push({ x: scene[i + 1] / 255, y: reference[i + 1] / 255, weight: w });
    b.push({ x: scene[i + 2] / 255, y: reference[i + 2] / 255, weight: w });
  }
  return { r, g, b };
}

/** RMSE (0-255) over pixels the weight function accepts, before and after a curve. */
export function curveRmse(scene: Uint8ClampedArray, reference: Uint8ClampedArray, curves: ToneCurves | null, weightOf: (i: number) => number): { before: number; after: number } {
  const f = (curve: number[], v: number) => (curves ? toneAt(v / 255, curve) * 255 : v);
  let sqBefore = 0, sqAfter = 0, n = 0;
  for (let i = 0; i < scene.length; i += 4) {
    if (weightOf(i) <= 0) continue;
    for (let c = 0; c < 3; c++) {
      const s = scene[i + c], t = reference[i + c];
      sqBefore += (s - t) ** 2;
      sqAfter += (f(c === 0 ? curves?.r ?? [] : c === 1 ? curves?.g ?? [] : curves?.b ?? [], s) - t) ** 2;
      n++;
    }
  }
  return n ? { before: Math.sqrt(sqBefore / n), after: Math.sqrt(sqAfter / n) } : { before: 0, after: 0 };
}
