/**
 * One-time data setup: downloads the LDraw parts library and the Rebrickable
 * catalog CSVs, unpacks them into public/, and builds public/data/catalog.json.
 * Safe to re-run: downloads are skipped when the cached file is already there.
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buildCatalog, parseDatHeader, type CatalogEntry } from '../src/catalog/buildCatalog';

const ROOT = process.cwd();
const CACHE = join(ROOT, '.cache');
const PUBLIC = join(ROOT, 'public');
const LDRAW_ZIP_URL = 'https://library.ldraw.org/library/updates/complete.zip';
const RB = 'https://cdn.rebrickable.com/media/downloads/';

async function download(url: string, dest: string, minBytes: number) {
  if (existsSync(dest) && statSync(dest).size >= minBytes) {
    console.log(`✓ cached ${dest}`);
    return;
  }
  console.log(`↓ ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let done = 0;
  let lastPct = -1;
  const body = Readable.fromWeb(res.body as never);
  body.on('data', (chunk: Buffer) => {
    done += chunk.length;
    const pct = total ? Math.floor((done / total) * 100) : -1;
    if (pct !== lastPct && pct % 5 === 0) {
      lastPct = pct;
      process.stdout.write(`  ${pct}%\r`);
    }
  });
  await pipeline(body, createWriteStream(dest));
  process.stdout.write('\n');
}

/** Minimal CSV line splitter that handles quoted fields. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function readCsvGz(path: string): string[][] {
  const lines = gunzipSync(readFileSync(path)).toString('utf8').split(/\r?\n/).filter(Boolean);
  return lines.slice(1).map(splitCsv);
}

async function main() {
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(join(PUBLIC, 'data'), { recursive: true });

  const zip = join(CACHE, 'complete.zip');
  await download(LDRAW_ZIP_URL, zip, 100_000_000);
  if (!existsSync(join(PUBLIC, 'ldraw', 'parts', '3001.dat'))) {
    console.log('… unzipping LDraw library');
    execFileSync('unzip', ['-q', '-o', zip, '-d', PUBLIC], { stdio: 'inherit' });
  }
  if (!existsSync(join(PUBLIC, 'ldraw', 'LDConfig.ldr'))) throw new Error('LDConfig.ldr missing after unzip');

  for (const f of ['parts', 'part_categories']) {
    await download(`${RB}${f}.csv.gz`, join(CACHE, `${f}.csv.gz`), 100);
  }
  const rbParts = new Map(readCsvGz(join(CACHE, 'parts.csv.gz')).map((r) => [r[0], r[2]] as [string, string]));
  const rbCats = new Map(readCsvGz(join(CACHE, 'part_categories.csv.gz')).map((r) => [r[0], r[1]] as [string, string]));

  console.log('… reading part headers');
  const partsDir = join(PUBLIC, 'ldraw', 'parts');
  const headers: CatalogEntry[] = [];
  for (const f of readdirSync(partsDir)) {
    if (!f.toLowerCase().endsWith('.dat')) continue;
    const text = readFileSync(join(partsDir, f), 'utf8').split('\n', 30).join('\n');
    const h = parseDatHeader(f.toLowerCase(), text);
    if (h) headers.push(h);
  }
  const catalog = buildCatalog(headers, { parts: rbParts, categories: rbCats });
  writeFileSync(join(PUBLIC, 'data', 'catalog.json'), JSON.stringify(catalog));
  console.log(`✓ catalog.json: ${catalog.length} parts`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
