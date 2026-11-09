/**
 * Renders every scene in data/neuralshade through EyeSight (Studio's default BUILD_FL light,
 * white world) into <scene>/target.png: the teacher images the learned shader trains on.
 * Existing targets are skipped, so it can be stopped and resumed.
 *
 *   npx tsx scripts/neural/render-targets.ts [--samples 96] [--dir data/neuralshade]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_RENDER, ROOT, runEyesight } from '../lib/eyesight';

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const DIR = join(ROOT, opt('dir', 'data/neuralshade')), SAMPLES = Number(opt('samples', '96')), PREFIX = opt('prefix', 'scene_');

async function main() {
  const scenes = readdirSync(DIR).filter((d) => d.startsWith(PREFIX)).sort();
  for (const d of scenes) {
    const dir = join(DIR, d), png = join(dir, 'target.png');
    if (existsSync(png) || !existsSync(join(dir, 'scene.dae'))) continue;
    const { width, height } = JSON.parse(readFileSync(join(dir, 'scene.json'), 'utf8')) as { width: number; height: number };
    const t0 = Date.now();
    await runEyesight({ ...DEFAULT_RENDER, width, height, samples: SAMPLES }, join(dir, 'scene.dae'), png, true);
    console.log(`✓ ${d} ${width}×${height} @${SAMPLES} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
