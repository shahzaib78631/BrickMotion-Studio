/**
 * The fixed list of models both engines are measured on (native rewrite, phase 0).
 * Writes native/corpus/manifest.json. Paths are relative to BM_DATA_DIR for the OMR and
 * BrickNet entries and to the repository for the rest, so the list holds on any machine.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CorpusEntry = { id: string; path: string; source: 'omr' | 'bricknet' | 'reference' | 'fixture'; tier: 'smoke' | 'full' };

const BRICKNET_SAMPLE = 2000;
const SMOKE_PER_SOURCE = 25;
const REFERENCE_SAMPLES = ['samples/helicopter/helicopter.mpd', 'samples/8880-1-axle-fix.mpd', 'public/data/test-10001.mpd'];
const REFERENCE_PREFIXES = ['5590', '8880', '10156', '42000', '21065'];
const isModel = (name: string) => /\.(mpd|ldr)$/i.test(name) && !/^ldc(onfig|fgalt)/i.test(name);

/** Model files under `root`, as sorted paths relative to it. */
function walk(root: string, sub = ''): string[] {
  if (!existsSync(join(root, sub))) return [];
  const out: string[] = [];
  for (const e of readdirSync(join(root, sub), { withFileTypes: true })) {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, rel));
    else if (isModel(e.name)) out.push(rel);
  }
  return out.sort();
}

export function buildManifest(dataDir: string, repoDir: string): CorpusEntry[] {
  const entries: CorpusEntry[] = [];
  const add = (source: CorpusEntry['source'], files: string[], prefix: string, smoke: (i: number) => boolean) =>
    files.forEach((f, i) => entries.push({ id: `${source}/${f}`, path: prefix + f, source, tier: smoke(i) ? 'smoke' : 'full' }));

  add('omr', walk(join(dataDir, 'omr/models')), 'omr/models/', i => i < SMOKE_PER_SOURCE);

  const bricknet = walk(join(dataDir, 'bricknet/models'));
  const step = Math.max(1, Math.floor(bricknet.length / BRICKNET_SAMPLE));
  add('bricknet', bricknet.filter((_, i) => i % step === 0).slice(0, BRICKNET_SAMPLE), 'bricknet/models/', i => i < SMOKE_PER_SOURCE);

  const reference = new Set(REFERENCE_SAMPLES.filter(f => existsSync(join(repoDir, f))));
  for (const f of walk(join(repoDir, 'samples'))) if (!f.includes('/') && REFERENCE_PREFIXES.some(p => f.startsWith(p))) reference.add(`samples/${f}`);
  add('reference', [...reference].sort(), '', () => true);

  add('fixture', walk(join(repoDir, 'tests/fixtures')), 'tests/fixtures/', () => true);
  return entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const data = process.env.BM_DATA_DIR ?? '/Users/mac/Projects/BrickMotion-Data';
  const manifest = buildManifest(data, repo);
  const out = join(repo, 'native/corpus/manifest.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  const n = (s: string) => manifest.filter(e => e.source === s).length;
  console.log(`manifest: ${manifest.length} entries (omr ${n('omr')}, bricknet ${n('bricknet')}, reference ${n('reference')}, fixture ${n('fixture')})`);
}
