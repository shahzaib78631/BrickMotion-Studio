/**
 * Keeps the parts library current, the way BrickLink Studio does: check the official
 * LDraw library for a newer release, apply it, and rebuild the part catalog.
 *
 *   npm run update:parts                      # check library.ldraw.org and apply any update
 *   npm run update:parts -- --check           # report local vs upstream, write nothing
 *   npm run update:parts -- --from <zip|dir>  # apply a local complete.zip, monthly update
 *                                             # zip, or an extracted library (e.g. Studio's)
 *   npm run update:parts -- --shadow          # also refresh the LDCad shadow pack (connectors)
 *   npm run update:parts -- --studio          # also add parts the installed BrickLink Studio has
 *
 * The official library is published as `complete.zip` (a full snapshot) plus monthly
 * `YYYY-MM.zip` increments; a snapshot apply also removes parts upstream has dropped,
 * while an `--from` merge never deletes. The local version comes from
 * `LDConfig.ldr` ("!LDRAW_ORG Configuration UPDATE YYYY-MM-DD"); the upstream
 * fingerprint (Last-Modified + size) is remembered in .cache so an unchanged library
 * costs one HEAD request.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildCatalog, parseDatHeader, type CatalogEntry } from '../src/catalog/buildCatalog';

const ROOT = process.cwd();
const CACHE = join(ROOT, '.cache');
const DEFAULT_DEST = join(ROOT, 'public', 'ldraw');
const COMPLETE_ZIP = 'https://library.ldraw.org/library/updates/complete.zip';
const UNOFFICIAL_ZIP = 'https://library.ldraw.org/library/unofficial/ldrawunf.zip';
const FINGERPRINT = join(CACHE, 'parts-update.json');

type Args = { check: boolean; from?: string; dest: string; shadow: boolean; unofficial: boolean; dryRun: boolean; catalogOnly: boolean; studio: boolean };

function parseArgs(argv: string[]): Args {
  const a: Args = { check: false, dest: DEFAULT_DEST, shadow: false, unofficial: false, dryRun: false, catalogOnly: false, studio: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--check') a.check = true;
    else if (v === '--catalog-only') a.catalogOnly = true;
    else if (v === '--studio') a.studio = true;
    else if (v === '--from') a.from = argv[++i];
    else if (v.startsWith('--from=')) a.from = v.slice(7);
    else if (v === '--dest') a.dest = resolve(argv[++i]);
    else if (v.startsWith('--dest=')) a.dest = resolve(v.slice(7));
    else if (v === '--shadow') a.shadow = true;
    else if (v === '--unofficial') a.unofficial = true;
    else if (v === '--dry-run') a.dryRun = true;
  }
  return a;
}

/** The library's own version string, e.g. "2026-05-29". */
function libraryVersion(dir: string): string {
  try {
    const head = readFileSync(join(dir, 'LDConfig.ldr'), 'utf8').split('\n', 10).join('\n');
    return /!LDRAW_ORG\s+Configuration\s+UPDATE\s+(\S+)/i.exec(head)?.[1] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function countParts(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      if (name.isDirectory()) walk(join(d, name.name));
      else if (name.name.toLowerCase().endsWith('.dat')) n++;
    }
  };
  try { walk(join(dir, 'parts')); } catch { /* no library yet */ }
  return n;
}

/** Last-Modified + Content-Length of the published snapshot; null when the host is unreachable. */
async function upstreamFingerprint(url: string): Promise<{ lastModified: string; size: number } | null> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return { lastModified: res.headers.get('last-modified') ?? '', size: Number(res.headers.get('content-length') ?? 0) };
  } catch {
    return null;
  }
}

function readCache(): Record<string, unknown> {
  try { return JSON.parse(readFileSync(FINGERPRINT, 'utf8')) as Record<string, unknown>; } catch { return {}; }
}

async function download(url: string, dest: string, minBytes: number): Promise<string> {
  if (existsSync(dest) && statSync(dest).size >= minBytes) {
    console.log(`  ✓ using cached ${relative(ROOT, dest)}`);
    return dest;
  }
  console.log(`  ↓ ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  const chunks: Buffer[] = [];
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  const buf = Buffer.concat(chunks);
  if (buf.length < minBytes) throw new Error(`Downloaded ${buf.length} bytes from ${url}; expected at least ${minBytes}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  return dest;
}

type Applied = { added: number; updated: number; removed: number };

/** Merges a staged library into `dest`. `prune` removes files upstream no longer ships. */
function apply(stage: string, dest: string, prune: boolean, dryRun: boolean): Applied {
  const out: Applied = { added: 0, updated: 0, removed: 0 };
  const trees = ['parts', 'p'];
  const seen = new Set<string>();
  for (const tree of trees) {
    const from = join(stage, tree);
    if (!existsSync(from)) continue;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        const rel = relative(stage, full).replace(/\\/g, '/');
        seen.add(rel);
        const target = join(dest, rel);
        if (!existsSync(target)) { out.added++; if (!dryRun) { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(full)); } continue; }
        // same size is not proof: compare the bytes so an upstream fix of equal length still lands
        const next = readFileSync(full);
        if (statSync(target).size === next.length && readFileSync(target).equals(next)) continue;
        out.updated++;
        if (!dryRun) writeFileSync(target, next);
      }
    };
    walk(from);
  }
  if (existsSync(join(stage, 'LDConfig.ldr')) && !dryRun) writeFileSync(join(dest, 'LDConfig.ldr'), readFileSync(join(stage, 'LDConfig.ldr')));
  if (prune) {
    for (const tree of trees) {
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) { walk(full); continue; }
          const rel = relative(dest, full).replace(/\\/g, '/');
          if (!seen.has(rel) && rel.toLowerCase().endsWith('.dat')) { out.removed++; if (!dryRun) unlinkSync(full); }
        }
      };
      try { walk(join(dest, tree)); } catch { /* missing tree */ }
    }
  }
  return out;
}

/** Unzips a snapshot (or merge zip) into a staging directory and applies it. */
function unzipTo(zip: string, stage: string) {
  mkdirSync(stage, { recursive: true });
  execFileSync('unzip', ['-q', '-o', zip, '-d', stage, '-x', '__MACOSX/*'], { stdio: 'inherit' });
}

function rebuildCatalog(dest: string, outDir = join(ROOT, 'public', 'data')) {
  const headers: CatalogEntry[] = [];
  const partsDir = join(dest, 'parts');
  for (const f of existsSync(partsDir) ? readdirSync(partsDir) : []) {
    if (!f.toLowerCase().endsWith('.dat')) continue;
    const text = readFileSync(join(partsDir, f), 'utf8').split('\n', 30).join('\n');
    const h = parseDatHeader(f.toLowerCase(), text);
    if (h) headers.push(h);
  }
  const csv = (name: string): string[][] => {
    const path = join(CACHE, name);
    if (!existsSync(path)) return [];
    const lines = gunzipSync(readFileSync(path)).toString('utf8').split(/\r?\n/).filter(Boolean).slice(1);
    return lines.map((line) => {
      const out: string[] = [];
      let cur = '', quoted = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quoted) {
          if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (c === '"') quoted = false;
          else cur += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { out.push(cur); cur = ''; }
        else cur += c;
      }
      out.push(cur);
      return out;
    });
  };
  const catalog = buildCatalog(headers, {
    parts: new Map(csv('parts.csv.gz').map((r) => [r[0], r[2]] as [string, string])),
    categories: new Map(csv('part_categories.csv.gz').map((r) => [r[0], r[1]] as [string, string])),
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'catalog.json'), JSON.stringify(catalog));
  return catalog.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dest = args.dest;
  if (!existsSync(join(dest, 'parts'))) {
    console.error(`No parts library at ${dest}. Run \`npm run setup\` once first.`);
    process.exit(1);
  }
  const local = libraryVersion(dest);
  console.log(`Parts library: ${dest}`);
  console.log(`  local   ${local} · ${countParts(dest).toLocaleString()} parts`);

  if (args.catalogOnly) {
    console.log(`✓ catalog rebuilt: ${rebuildCatalog(dest, dest === DEFAULT_DEST ? undefined : join(dest, '..', 'data'))} parts`);
    return;
  }

  let source: { kind: 'snapshot' | 'merge'; path: string } | null = null;
  /** The upstream fingerprint read before the apply, so the next --check can compare. */
  let seen: { lastModified: string; size: number } | null = null;
  if (args.from) {
    const from = resolve(args.from);
    if (!existsSync(from)) { console.error(`--from path not found: ${from}`); process.exit(1); }
    if (statSync(from).isDirectory()) {
      console.log(`  source  ${from} · ${libraryVersion(from)} (local directory, merge)`);
      source = { kind: 'merge', path: from };
    } else {
      console.log(`  source  ${from} (zip, merge)`);
      source = { kind: 'snapshot', path: from };
    }
  } else {
    const fingerprint = await upstreamFingerprint(COMPLETE_ZIP);
    if (!fingerprint) {
      console.error('  upstream unreachable (library.ldraw.org). Parts left unchanged; try again later, or use --from.');
      process.exit(2);
    }
    seen = fingerprint;
    const cached = readCache();
    const known = cached.fingerprint as { lastModified: string; size: number } | undefined;
    console.log(`  upstream ${fingerprint.lastModified || 'unknown date'} · ${(fingerprint.size / 1024 / 1024).toFixed(1)} MB`);
    const unchanged = known && known.lastModified === fingerprint.lastModified && known.size === fingerprint.size;
    if (unchanged && cached.localVersion === local && !args.check) {
      console.log('✓ already up to date (upstream unchanged since the last sync)');
      return;
    }
    if (unchanged && args.check) {
      console.log('✓ up to date: upstream snapshot matches the last sync');
      return;
    }
    console.log('… a new library is available');
    if (args.check) return;
    source = { kind: 'snapshot', path: await download(COMPLETE_ZIP, join(CACHE, 'complete.zip'), 100_000_000) };
  }

  const stage = join(CACHE, 'parts-stage');
  if (source.kind === 'snapshot') {
    console.log('… unpacking');
    unzipTo(source.path, stage);
  } else {
    mkdirSync(stage, { recursive: true });
  }
  const stagedLib = source.kind === 'snapshot' ? stage : source.path;
  const result = apply(stagedLib, dest, source.kind === 'snapshot', args.dryRun);
  const label = args.dryRun ? 'would apply' : 'applied';
  console.log(`✓ ${label}: ${result.added} added · ${result.updated} updated${result.removed ? ` · ${result.removed} removed` : ''} · now ${libraryVersion(dest)}`);

  if (args.dryRun) return;
  if (result.added || result.updated || result.removed) {
    // a custom --dest is a test/staging library: keep its catalog beside it, never the app's
    const outDir = dest === DEFAULT_DEST ? undefined : join(dest, '..', 'data');
    console.log(`✓ catalog rebuilt: ${rebuildCatalog(dest, outDir)} parts`);
  }

  if (args.unofficial) {
    const zip = await download(UNOFFICIAL_ZIP, join(CACHE, 'ldrawunf.zip'), 1_000_000);
    unzipTo(zip, stage);
    const u = apply(stage, dest, false, false);
    console.log(`✓ unofficial parts: ${u.added} added · ${u.updated} updated`);
  }

  if (args.studio) {
    const sync = join(ROOT, 'scripts', 'sync-studio-parts.ts');
    console.log('… adding the parts the installed BrickLink Studio has');
    try {
      execFileSync('npx', ['tsx', sync, ...(args.dryRun ? ['--dry-run'] : [])], { stdio: 'inherit' });
    } catch {
      console.error('  Studio sync skipped (no Studio install found, or it failed)');
    }
  }

  if (args.shadow) {
    const shadow = join(ROOT, 'vendor', 'LDCadShadowLibrary');
    if (existsSync(join(shadow, '.git'))) {
      console.log('… updating the LDCad shadow library (git pull)');
      try { execFileSync('git', ['-C', shadow, 'pull', '--ff-only'], { stdio: 'inherit' }); } catch { console.error('  git pull failed; keeping the current clone'); }
    }
    if (existsSync(join(shadow, 'parts')) || existsSync(join(shadow, 'p'))) {
      execFileSync('npx', ['tsx', 'scripts/import-shadow-metadata.ts'], { stdio: 'inherit' });
    } else {
      console.error('  no shadow library at vendor/LDCadShadowLibrary; skipping connectors');
    }
  }

  mkdirSync(CACHE, { recursive: true });
  // remember the upstream state only when this run actually applied the upstream snapshot,
  // so a --from run never claims the official library is up to date
  writeFileSync(FINGERPRINT, JSON.stringify({
    syncedAt: new Date().toISOString(),
    localVersion: libraryVersion(dest),
    fingerprint: seen ?? readCache().fingerprint ?? null,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
