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

/** A full 256-entry per-channel display LUT (values 0..1). */
export type Lut = { r: number[]; g: number[]; b: number[] };

/** Per-channel histogram matching: maps each scene value to the reference value at the same
 * quantile. One monotone step sets brightness, contrast, saturation and the background to the
 * reference's distribution (only pixels the caller weights in are counted). */
export function histogramMatch(scene: Uint8ClampedArray, reference: Uint8ClampedArray, weightOf: (i: number) => number): Lut {
  const cdf = (a: Uint8ClampedArray, c: number): Float64Array => {
    const h = new Float64Array(256); let n = 0;
    for (let i = 0; i < a.length; i += 4) { const w = weightOf(i); if (w <= 0) continue; h[a[i + c]] += w; n += w; }
    const out = new Float64Array(256); let acc = 0;
    for (let v = 0; v < 256; v++) { acc += h[v]; out[v] = n > 0 ? acc / n : v / 255; }
    return out;
  };
  const lut: Lut = { r: [], g: [], b: [] };
  const keys: ('r' | 'g' | 'b')[] = ['r', 'g', 'b'];
  for (let c = 0; c < 3; c++) {
    const cs = cdf(scene, c), cr = cdf(reference, c);
    let j = 0;
    for (let v = 0; v < 256; v++) {
      while (j < 255 && cr[j] < cs[v]) j++;
      lut[keys[c]].push(j / 255);
    }
  }
  return lut;
}

const LUT_ID = 'bm-lut';
/** Applies a 256-entry per-channel LUT as an SVG table filter (GPU, zero per-frame cost). */
export function applyLutFilter(canvas: HTMLCanvasElement, lut: Lut): void {
  let svg = document.getElementById(`${LUT_ID}-svg`) as SVGSVGElement | null;
  if (!svg) {
    svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
    svg.id = `${LUT_ID}-svg`;
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    const filter = document.createElementNS(NS, 'filter') as SVGFilterElement;
    filter.id = LUT_ID;
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const transfer = document.createElementNS(NS, 'feComponentTransfer');
    transfer.append(feFunc('R'), feFunc('G'), feFunc('B'));
    const a = feFunc('A'); a.setAttribute('type', 'identity'); transfer.append(a);
    filter.append(transfer); svg.append(filter); document.body.append(svg);
  }
  const set = (ch: string, arr: number[]) => svg!.querySelector(`feFunc${ch}`)?.setAttribute('tableValues', arr.map((v) => v.toFixed(5)).join(' '));
  set('R', lut.r); set('G', lut.g); set('B', lut.b);
  canvas.style.filter = `url(#${LUT_ID})`;
}

/** Applies a LUT to an RGBA buffer in place (used to measure the matched result). */
export function applyLutToPixels(pixels: Uint8ClampedArray, lut: Lut): void {
  const lr = lut.r.map((v) => v * 255), lg = lut.g.map((v) => v * 255), lb = lut.b.map((v) => v * 255);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = lr[pixels[i]]; pixels[i + 1] = lg[pixels[i + 1]]; pixels[i + 2] = lb[pixels[i + 2]];
  }
}

/** A controlled tonal map anchored at the region's own p5 / p50 / p95 (per channel), instead of a
 * raw histogram match — this sets brightness and contrast but cannot overshoot at the top end. */
export function anchoredMap(scene: Uint8ClampedArray, reference: Uint8ClampedArray, isRegion: (i: number) => boolean): Lut {
  const pct = (a: Uint8ClampedArray, c: number, p: number): number => {
    const h = new Float64Array(256); let n = 0;
    for (let i = 0; i < a.length; i += 4) { if (!isRegion(i)) continue; h[a[i + c]]++; n++; }
    if (!n) return Math.round(p * 255);
    let acc = 0; const t = n * p;
    for (let v = 0; v < 256; v++) { acc += h[v]; if (acc >= t) return v; }
    return 255;
  };
  const lut: Lut = { r: [], g: [], b: [] };
  const keys: ('r' | 'g' | 'b')[] = ['r', 'g', 'b'];
  for (let c = 0; c < 3; c++) {
    const xs = [0, pct(scene, c, 0.05), pct(scene, c, 0.5), pct(scene, c, 0.95), 256];
    const ys = [0, pct(reference, c, 0.05), pct(reference, c, 0.5), pct(reference, c, 0.95), 256];
    for (let k = 1; k < xs.length; k++) xs[k] = Math.max(xs[k], xs[k - 1] + 1);
    for (let k = 1; k < ys.length; k++) ys[k] = Math.max(ys[k], ys[k - 1]);
    const out: number[] = [];
    let seg = 1;
    for (let v = 0; v < 256; v++) {
      while (seg < xs.length - 1 && v >= xs[seg]) seg++;
      const x0 = xs[seg - 1], x1 = xs[seg], y0 = ys[seg - 1], y1 = ys[seg];
      const t = Math.min(1, Math.max(0, (v - x0) / Math.max(1, x1 - x0)));
      out.push(Math.min(255, Math.max(0, y0 + t * (y1 - y0))) / 255);
    }
    lut[keys[c]] = out;
  }
  return lut;
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
