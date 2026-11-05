/** Compare two renders of the same model (e.g. a BrickLink Studio render and a BrickMotion one).
 *
 *   node scripts/compare-renders.cjs <reference.png> <candidate.png> [--json] [--object]
 *     --object compares only the model's pixels (ignores framing, aspect ratio and background)
 *   node scripts/compare-renders.cjs --self-test
 *
 * Only finished images are read. Both are resized to a common grid (box filter) and then
 * compared on tone (mean / spread / shadow and highlight percentiles), colour cast (mean
 * RGB) and structure (SSIM on luminance). A positive "delta" means the candidate is
 * brighter / higher / warmer than the reference. Dependency-free: 8-bit, non-interlaced PNG
 * (greyscale, RGB, RGBA) only, which is what both applications write.
 */
const fs = require('node:fs');
const zlib = require('node:zlib');

const GRID = 256;

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG file');
  let pos = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), name = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || ![0, 2, 6].includes(type)) throw new Error(`unsupported PNG (depth ${depth}, colour type ${type}, interlace ${interlace}); export 8-bit non-interlaced`);
  const channels = type === 0 ? 1 : type === 2 ? 3 : 4;
  const stride = width * channels, raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[dst + x - channels] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= channels && y > 0 ? px[dst - stride + x - channels] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
      px[dst + x] = v & 255;
    }
  }
  // composite onto mid grey so transparent backgrounds do not read as black
  const rgb = new Float64Array(width * height * 3), alpha = new Uint8Array(width * height).fill(255);
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const r = px[o], g = channels === 1 ? r : px[o + 1], b = channels === 1 ? r : px[o + 2];
    const al = channels === 4 ? px[o + 3] / 255 : 1;
    alpha[i] = channels === 4 ? px[o + 3] : 255;
    rgb[i * 3] = r * al + 128 * (1 - al); rgb[i * 3 + 1] = g * al + 128 * (1 - al); rgb[i * 3 + 2] = b * al + 128 * (1 - al);
  }
  return { width, height, rgb, alpha };
}

function encodePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 3 + 1)] = 0; for (let x = 0; x < width * 3; x++) raw[y * (width * 3 + 1) + 1 + x] = rgb[y * width * 3 + x]; }
  const chunk = (name, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(name, 4, 'latin1'); data.copy(out, 8);
    out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Box-filter onto a GRID x GRID grid (aspect ratios are compared by the caller). */
function resample({ width, height, rgb }) {
  // each grid cell averages the source pixels it covers (at least one, so small images upscale)
  const out = new Float64Array(GRID * GRID * 3);
  const span = (g, size) => { const a = Math.min(size - 1, Math.floor((g * size) / GRID)); return [a, Math.max(a + 1, Math.min(size, Math.ceil(((g + 1) * size) / GRID)))]; };
  for (let gy = 0; gy < GRID; gy++) {
    const [y0, y1] = span(gy, height);
    for (let gx = 0; gx < GRID; gx++) {
      const [x0, x1] = span(gx, width);
      let r = 0, g = 0, b = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * width + x) * 3; r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2]; }
      const n = (y1 - y0) * (x1 - x0), o = (gy * GRID + gx) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return out;
}

const luma = (rgb) => { const l = new Float64Array(GRID * GRID); for (let i = 0; i < l.length; i++) l[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2]; return l; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
const pct = (a, p) => Float64Array.from(a).sort()[Math.min(a.length - 1, Math.floor(p * a.length))];

/** Mean SSIM over 8x8 windows (stride 4) of luminance. */
function ssim(a, b) {
  const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2, W = 8;
  let sum = 0, n = 0;
  for (let y = 0; y + W <= GRID; y += 4) for (let x = 0; x + W <= GRID; x += 4) {
    let ma = 0, mb = 0;
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) { ma += a[(y + j) * GRID + x + i]; mb += b[(y + j) * GRID + x + i]; }
    ma /= W * W; mb /= W * W;
    let va = 0, vb = 0, cov = 0;
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) { const da = a[(y + j) * GRID + x + i] - ma, db = b[(y + j) * GRID + x + i] - mb; va += da * da; vb += db * db; cov += da * db; }
    va /= W * W - 1; vb /= W * W - 1; cov /= W * W - 1;
    sum += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2)); n++;
  }
  return sum / n;
}

function describe(img) {
  const rgb = resample(img), l = luma(rgb);
  const ch = (c) => { let s = 0; for (let i = 0; i < GRID * GRID; i++) s += rgb[i * 3 + c]; return s / (GRID * GRID); };
  return { size: `${img.width}x${img.height}`, aspect: img.width / img.height, rgb, luma: l, stats: { meanR: ch(0), meanG: ch(1), meanB: ch(2), meanLuma: mean(l), spread: std(l), p01: pct(l, 0.01), p50: pct(l, 0.5), p99: pct(l, 0.99) } };
}

function compare(refImg, candImg) {
  const r = describe(refImg), c = describe(candImg), delta = {};
  for (const k of Object.keys(r.stats)) delta[k] = +(c.stats[k] - r.stats[k]).toFixed(2);
  delta.warmth = +((c.stats.meanR - c.stats.meanB) - (r.stats.meanR - r.stats.meanB)).toFixed(2);
  return { reference: { size: r.size, ...round(r.stats) }, candidate: { size: c.size, ...round(c.stats) }, delta, ssim: +ssim(r.luma, c.luma).toFixed(4), aspectMatch: Math.abs(r.aspect - c.aspect) < 0.01 };
}
const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(2)]));

/**
 * Statistics over the model's own pixels only, so framing, aspect ratio and background do not
 * matter. The model is the transparent-background alpha when there is one, otherwise whatever
 * differs from the background colour (median of the image border) by more than 40 on any channel;
 * a soft floor shadow is mostly lighter than that and stays out.
 */
function objectStats({ width, height, rgb, alpha }) {
  const border = [[], [], []];
  const edge = (x, y) => { const i = (y * width + x) * 3; for (let c = 0; c < 3; c++) border[c].push(rgb[i + c]); };
  for (let x = 0; x < width; x++) { edge(x, 0); edge(x, height - 1); }
  for (let y = 0; y < height; y++) { edge(0, y); edge(width - 1, y); }
  const bg = border.map((b) => Float64Array.from(b).sort()[b.length >> 1]);
  const hasAlpha = alpha.some((a) => a < 255);
  const groups = { all: [], dark: [], red: [], light: [] };
  let n = 0;
  for (let i = 0; i < width * height; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const inside = hasAlpha ? alpha[i] > 200 : Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(b - bg[2])) > 40;
    if (!inside) continue;
    n++;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b, px = [r, g, b, y];
    groups.all.push(px);
    if (y < 70) groups.dark.push(px);
    else if (r > 1.8 * g && r > 1.8 * b) groups.red.push(px);
    else if (y > 200 && Math.max(r, g, b) - Math.min(r, g, b) < 30) groups.light.push(px);
  }
  const avg = (list) => list.length ? { R: +mean(list.map((p) => p[0])).toFixed(1), G: +mean(list.map((p) => p[1])).toFixed(1), B: +mean(list.map((p) => p[2])).toFixed(1), luma: +mean(list.map((p) => p[3])).toFixed(1), share: +(list.length / n).toFixed(3) } : null;
  const ys = Float64Array.from(groups.all.map((p) => p[3])).sort();
  const q = (p) => ys.length ? +ys[Math.min(ys.length - 1, Math.floor(p * ys.length))].toFixed(1) : null;
  return { modelPixels: n, background: bg.map((v) => Math.round(v)), mask: hasAlpha ? 'alpha' : 'background-difference', p01: q(0.01), p50: q(0.5), p99: q(0.99), spread: +std(ys).toFixed(1), all: avg(groups.all), dark: avg(groups.dark), red: avg(groups.red), light: avg(groups.light) };
}

function selfTest() {
  const assert = require('node:assert/strict');
  const make = (w, h, f) => { const p = new Uint8Array(w * h * 3); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p.set(f(x, y), (y * w + x) * 3); return decodePng(encodePng(w, h, p)); };
  // gradients in relative coordinates, so the same picture can be made at any size
  const grad = (w, h) => (x, y) => [Math.floor((x / w) * 200), Math.floor((y / h) * 200), 90];
  const a = make(300, 200, grad(300, 200)), same = make(600, 400, grad(600, 400));
  const bright = make(300, 200, (x, y) => grad(300, 200)(x, y).map((v) => Math.min(255, v + 40)));
  const same_r = compare(a, same), bright_r = compare(a, bright);
  assert.ok(same_r.ssim > 0.97, `identical content at another size should match, got ${same_r.ssim}`);
  assert.ok(same_r.aspectMatch);
  assert.ok(Math.abs(bright_r.delta.meanLuma - 40) < 1.5, `brightness delta, got ${bright_r.delta.meanLuma}`);
  assert.ok(bright_r.ssim < same_r.ssim);
  console.log('self-test passed');
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) selfTest();
else {
  const files = args.filter((a) => !a.startsWith('--'));
  if (files.length !== 2) { console.error('usage: node scripts/compare-renders.cjs <reference.png> <candidate.png> [--json] [--object]'); process.exit(2); }
  const refImg = decodePng(fs.readFileSync(files[0])), candImg = decodePng(fs.readFileSync(files[1]));
  if (args.includes('--object')) {
    const r = objectStats(refImg), c = objectStats(candImg);
    if (args.includes('--json')) console.log(JSON.stringify({ reference: r, candidate: c }, null, 2));
    else {
      console.log(`model pixels  ref ${r.modelPixels} (${r.mask})  cand ${c.modelPixels} (${c.mask})`);
      for (const k of ['p01', 'p50', 'p99', 'spread']) console.log(`${k.padEnd(8)} ref ${String(r[k]).padStart(6)}  cand ${String(c[k]).padStart(6)}  delta ${(c[k] - r[k]).toFixed(1)}`);
      for (const k of ['all', 'dark', 'red', 'light']) {
        const a = r[k], b = c[k];
        console.log(`${k.padEnd(5)} ref ${a ? `RGB ${a.R},${a.G},${a.B} luma ${a.luma} share ${a.share}` : '-'}`);
        console.log(`${''.padEnd(5)} cand ${b ? `RGB ${b.R},${b.G},${b.B} luma ${b.luma} share ${b.share}` : '-'}`);
      }
    }
    process.exit(0);
  }
  const result = compare(refImg, candImg);
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`reference ${result.reference.size}  candidate ${result.candidate.size}${result.aspectMatch ? '' : '  (ASPECT DIFFERS: framing will not match)'}`);
    console.log(`SSIM ${result.ssim}`);
    for (const [k, v] of Object.entries(result.delta)) console.log(`${k.padEnd(10)} ref ${String(result.reference[k] ?? '').padStart(7)}  cand ${String(result.candidate[k] ?? '').padStart(7)}  delta ${v > 0 ? '+' : ''}${v}`);
  }
}
