/**
 * Syncs the LDraw parts library shipped with a local BrickLink Studio install into
 * public/ldraw, then rebuilds public/data/catalog.json so the new parts are searchable.
 *
 * Studio carries its own tuned library (including BrickLink's `bl_*` decorated parts and
 * fixes that the public complete.zip does not have), so re-running this after a Studio
 * update keeps the app's parts current:
 *
 *   npm run data:studio-parts                 # add the parts we are missing (dry-run first!)
 *   npm run data:studio-parts -- --dry-run    # report only, write nothing
 *   npm run data:studio-parts -- --dir "/Applications/Studio 2.0/ldraw"
 *   npm run data:studio-parts -- --refresh    # also replace parts whose content differs
 *   npm run data:studio-parts -- --unofficial # also merge Studio's UnOfficial parts
 *
 * The default is gap-filling: our library also tracks the public LDraw snapshots, so a
 * differing file is not automatically worse than Studio's copy. `--refresh` treats Studio
 * as authoritative and replaces them (report first with --dry-run).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, copyFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildCatalog, parseDatHeader, type CatalogEntry } from '../src/catalog/buildCatalog';

const ROOT = process.cwd();
const PUBLIC = join(ROOT, 'public');
const DEST_LDRAW = join(PUBLIC, 'ldraw');
const CACHE = join(ROOT, '.cache');

type Args = { dir?: string; dryRun: boolean; refresh: boolean; unofficial: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, refresh: false, unofficial: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--refresh') args.refresh = true;
    else if (a === '--unofficial') args.unofficial = true;
    else if (a.startsWith('--dir=')) args.dir = a.slice('--dir='.length);
  }
  return args;
}

/** The LDraw library inside a BrickLink Studio install, or null. */
function findStudioLdraw(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.BRICKLINK_STUDIO_DIR,
    process.env.BRICKLINK_STUDIO_DIR ? join(process.env.BRICKLINK_STUDIO_DIR, 'ldraw') : undefined,
    '/Applications/Studio 2.0/ldraw',
    '/Applications/BrickLink Studio 2.0/ldraw',
    join(homedir(), 'Applications/Studio 2.0/ldraw'),
    'C:/Program Files/Studio 2.0/ldraw',
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (existsSync(join(c, 'parts')) && existsSync(join(c, 'p'))) return c;
  }
  return null;
}

type Tree = { from: string; to: string; label: string };

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

const isPartFile = (name: string) => !name.startsWith('.') && !name.endsWith('~');

/** Every file under `dir`, as paths relative to it. */
function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const name of readdirSafe(dir)) {
    if (!isPartFile(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

function syncTree(tree: Tree, args: Args, stats: { added: number; updated: number; same: number; kept: number; bytes: number }) {
  if (!existsSync(tree.from)) return;
  for (const rel of walk(tree.from)) {
    const src = join(tree.from, rel);
    const dest = join(tree.to, rel);
    const srcSize = statSync(src).size;
    if (!existsSync(dest)) {
      stats.added++;
      stats.bytes += srcSize;
      if (!args.dryRun) { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(src, dest); }
      continue;
    }
    const next = readFileSync(src);
    if (statSync(dest).size === next.length && readFileSync(dest).equals(next)) { stats.same++; continue; }
    if (!args.refresh) { stats.kept++; continue; }
    stats.updated++;
    stats.bytes += srcSize;
    if (!args.dryRun) copyFileSync(src, dest);
  }
}

/** Rebuilds public/data/catalog.json from the library on disk (Rebrickable names when cached). */
function rebuildCatalog() {
  const headers: CatalogEntry[] = [];
  const partsDir = join(DEST_LDRAW, 'parts');
  for (const f of readdirSafe(partsDir)) {
    if (!f.toLowerCase().endsWith('.dat')) continue;
    const text = readFileSync(join(partsDir, f), 'utf8').split('\n', 30).join('\n');
    const h = parseDatHeader(f.toLowerCase(), text);
    if (h) headers.push(h);
  }
  // Rebrickable CSVs come from `npm run setup`; without them the catalog keeps LDraw names
  const csv = readCachedCsv('parts.csv.gz');
  const cats = readCachedCsv('part_categories.csv.gz');
  const catalog = buildCatalog(headers, {
    parts: new Map(csv.map((r) => [r[0], r[2]] as [string, string])),
    categories: new Map(cats.map((r) => [r[0], r[1]] as [string, string])),
  });
  mkdirSync(join(PUBLIC, 'data'), { recursive: true });
  writeFileSync(join(PUBLIC, 'data', 'catalog.json'), JSON.stringify(catalog));
  return catalog.length;
}

function readCachedCsv(name: string): string[][] {
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
}

function readStudioVersion(dir: string): string {
  try {
    // version.txt ships as labelled lines ("Version", then the number)
    const lines = readFileSync(join(dir, '..', 'version.txt'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.find((l) => /^\d/.test(l)) ?? lines[0] ?? 'unknown';
  } catch { return 'unknown'; }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = findStudioLdraw(args.dir);
  if (!source) {
    console.error('BrickLink Studio not found. Pass --dir "/Applications/Studio 2.0/ldraw" or set BRICKLINK_STUDIO_DIR.');
    process.exit(1);
  }
  if (!existsSync(join(DEST_LDRAW, 'parts', '3001.dat'))) {
    console.error(`public/ldraw is missing; run \`npm run setup\` once first (syncing into ${DEST_LDRAW}).`);
    process.exit(1);
  }
  const version = readStudioVersion(source);
  console.log(`Studio library: ${source} (version ${version})${args.dryRun ? ' — dry run' : ''}`);

  const trees: Tree[] = [
    { from: join(source, 'parts'), to: join(DEST_LDRAW, 'parts'), label: 'parts' },
    { from: join(source, 'p'), to: join(DEST_LDRAW, 'p'), label: 'p' },
  ];
  if (args.unofficial) trees.push({ from: join(source, 'UnOfficial', 'parts'), to: join(DEST_LDRAW, 'parts'), label: 'UnOfficial/parts' });

  let added = 0, updated = 0, same = 0, kept = 0, bytes = 0;
  for (const tree of trees) {
    const stats = { added: 0, updated: 0, same: 0, kept: 0, bytes: 0 };
    syncTree(tree, args, stats);
    console.log(`  ${tree.label.padEnd(18)} +${stats.added} new · ${stats.updated} replaced · ${stats.same} identical${stats.kept ? ` · ${stats.kept} differ (use --refresh)` : ''}`);
    added += stats.added; updated += stats.updated; same += stats.same; kept += stats.kept; bytes += stats.bytes;
  }

  if (args.dryRun) {
    console.log(`Would write ${added + updated} files (${(bytes / 1024 / 1024).toFixed(1)} MB); ${same} already identical.`);
    return;
  }
  console.log(`✓ ${added} added, ${updated} updated (${(bytes / 1024 / 1024).toFixed(1)} MB); ${same} unchanged${kept ? `, ${kept} kept` : ''}`);
  if (added || updated) {
    console.log(`✓ catalog rebuilt: ${rebuildCatalog()} parts`);
  } else {
    console.log('… nothing changed, catalog left as is');
  }
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(join(CACHE, 'studio-parts-sync.json'), JSON.stringify({
    source, version, syncedAt: new Date().toISOString(), added, updated, unchanged: same, kept,
  }, null, 2));
}

main();
