/**
 * LEGO instruction booklets → BrickMotion MPD (Phase 1: parts, colours and official steps;
 * each step's new parts are laid out beside the model, not yet placed).
 *
 *   npm run instructions -- --name superman --set 40859-1 --pdf 6668730 --pdf 6668732 [--out file.mpd]
 *
 * --pdf takes a LEGO booklet id, a URL or a local file. Needs REBRICKABLE_API_KEY in the
 * environment the first time a set is fetched (the inventory is cached in the work folder).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { exportLDraw } from '../src/io/ldrawExport';
import { parseLDConfig } from '../src/ldraw/colors';
import { flattenPart } from '../src/ldraw/flatten';
import { measurePart, type PartMetrics } from '../src/ldraw/metrics';
import { parseLDraw, type LDrawFile } from '../src/ldraw/parse';
import type { Plan } from '../src/plan/types';
import { placementJob } from '../src/instructions/placementJob';
import { assessExtraction } from '../src/instructions/assessment';
import { bookletSources, bookletUrl, orderBooklets } from '../src/instructions/booklets';
import { planFromBooklets, type Flag } from '../src/instructions/buildPlan';
import { calloutUseDiffs, inventoryDiffs } from '../src/instructions/inventory';
import { loadElements, loadSetParts, resolveSetPart, type Resolved } from '../src/instructions/rebrickable';
import { instructionsReport } from '../src/instructions/report';
import type { Booklet, Matches } from '../src/instructions/types';
import { runPython } from './instructions/pythonBridge';

const ROOT = process.cwd();
const LDRAW = join(ROOT, 'public', 'ldraw');
const PDF_CACHE = join(ROOT, '.cache', 'instructions', 'pdf');

function parseArgs(argv: string[]) {
  const pdfs: string[] = [];
  let name = '';
  let set = '';
  let out = '';
  let inventory = '';
  let extractOnly = false;
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === '--extract-only') extractOnly = true;
    else if (argv[i] === '--strict') strict = true;
    else if (argv[i] === '--inventory' && v) (inventory = v, i++);
    else if (argv[i] === '--pdf' && v) (pdfs.push(v), i++);
    else if (argv[i] === '--name' && v) (name = v, i++);
    else if (argv[i] === '--set' && v) (set = v, i++);
    else if (argv[i] === '--out' && v) (out = v, i++);
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  if (!name || !pdfs.length || (!extractOnly && !set && !inventory)) throw new Error('Usage: npm run instructions -- --name <name> [--set <set_num e.g. 40859-1> | --inventory <SetPart JSON>] --pdf <id|url|path> [--pdf …] [--out file.mpd] [--extract-only] [--strict]');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new Error('--name must be a simple folder name');
  return { name, set, pdfs, out, inventory, extractOnly, strict };
}

async function download(url: string, dest: string) {
  if (existsSync(dest)) return;
  console.log(`↓ ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 BrickMotion' } });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function localPdf(spec: string): Promise<string> {
  const url = bookletUrl(spec);
  if (!url) {
    const path = resolve(spec);
    if (!existsSync(path)) throw new Error(`No such file: ${spec}`);
    return path;
  }
  mkdirSync(PDF_CACHE, { recursive: true });
  const file = join(PDF_CACHE, /^\d+$/.test(spec.trim()) ? `${spec.trim()}.pdf` : `${createHash('sha256').update(url).digest('hex').slice(0, 16)}-${basename(new URL(url).pathname) || 'booklet.pdf'}`);
  await download(url, file);
  return file;
}

async function python(args: string[]) {
  const r = await runPython(args);
  if (r.code !== 0) throw new Error(`python ${args.slice(0, 3).join(' ')} failed:\n${r.stderr.trim().split('\n').slice(-5).join('\n')}`);
  return r.stdout;
}

function partMetrics(plan: Plan): (part: string) => PartMetrics {
  const files = new Map<string, LDrawFile | null>();
  const lookup = (ref: string) => {
    const id = ref.replace(/\\/g, '/').toLowerCase();
    if (!files.has(id)) {
      const path = [join(LDRAW, 'parts', id), join(LDRAW, 'p', id)].find((p) => existsSync(p));
      files.set(id, path ? parseLDraw(readFileSync(path, 'utf8'), id) : null);
    }
    return files.get(id) ?? null;
  };
  const ids = new Set<string>();
  const steps = [plan.steps, ...Object.values(plan.submodels ?? {}).map((s) => s.steps)];
  for (const list of steps) for (const s of list) for (const p of s.pieces) if ('part' in p) ids.add(p.part);
  const map = new Map<string, PartMetrics>();
  for (const id of ids) {
    const root = lookup(`${id}.dat`);
    map.set(id, measurePart(root ? flattenPart(id, root, lookup, () => {}) : null, id));
  }
  return (part) => map.get(part) ?? measurePart(null, part);
}

function loadLocalInventory(path: string): import('../src/instructions/rebrickable').SetPart[] {
  const rows: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(rows) || !rows.length) throw new Error('--inventory must contain a nonempty SetPart JSON array');
  for (const p of rows) {
    if (!p || typeof p.part !== 'string' || typeof p.colorName !== 'string' || typeof p.ldrawPart !== 'string' || !p.ldrawPart || !Number.isInteger(p.quantity) || p.quantity < 1 ||
        !Number.isInteger(p.color) || typeof p.element !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(p.element) || typeof p.spare !== 'boolean' ||
        (p.image !== null && typeof p.image !== 'string')) throw new Error('Invalid local inventory row: require element, ldrawPart, LDraw color, positive quantity, spare and image (URL or null)');
  }
  return rows;
}

async function main() {
  const { name, set, pdfs, out, inventory, extractOnly, strict } = parseArgs(process.argv.slice(2));
  const work = join(ROOT, '.cache', 'instructions', name);
  const bookletDir = join(work, 'booklets');
  mkdirSync(work, { recursive: true });
  const pendingDir = mkdtempSync(join(work, 'booklets-pending-'));

  const extracted: Booklet[] = [];
  const files: string[] = [];
  try {
    for (const spec of pdfs) files.push(await localPdf(spec));
    for (const { path: pdf, id } of bookletSources(files)) {
      await python(['-m', 'instructions_pdf', 'extract', pdf, join(pendingDir, id)]);
      extracted.push({ ...(JSON.parse(readFileSync(join(pendingDir, id, 'booklet.json'), 'utf8')) as Booklet), id });
    }
    // Keep the previous extraction intact if a PDF/OCR operation fails.
    const previous = `${pendingDir}-previous`;
    if (existsSync(bookletDir)) renameSync(bookletDir, previous);
    try { renameSync(pendingDir, bookletDir); }
    catch (error) {
      if (existsSync(previous)) renameSync(previous, bookletDir);
      throw error;
    }
    rmSync(previous, { recursive: true, force: true });
  } finally {
    rmSync(pendingDir, { recursive: true, force: true });
  }
  const assessment = assessExtraction(extracted);
  const assessmentPath = join(work, 'extraction.json');
  writeFileSync(assessmentPath, JSON.stringify({ ...assessment, booklets: extracted }, null, 1));
  console.log(`Extraction: ${assessment.steps} steps, ${assessment.callouts} callouts, ${assessment.issues.length} issues`);
  console.log(`  Evidence: ${assessmentPath}`);
  if (extractOnly) {
    if (strict && (assessment.issues.length || assessment.unparsedPages.length)) process.exitCode = 2;
    return;
  }
  if ((assessment.issues.length || assessment.unparsedPages.length) && strict) throw new Error(`Extraction requires review; see ${assessmentPath}`);
  const { booklets, models, flags: orderFlags } = orderBooklets(extracted);
  for (const b of extracted) if (!booklets.includes(b)) rmSync(join(bookletDir, b.id), { recursive: true, force: true });

  const parts = inventory ? loadLocalInventory(resolve(inventory)) : await loadSetParts(set, join(work, 'rebrickable-parts.json'));
  const inventoryPage = booklets.some((b) => b.inventory.length > 0);
  if (!inventoryPage) {
    const dir = join(bookletDir, 'rb-images');
    mkdirSync(dir, { recursive: true });
    for (const p of parts) if (!p.spare && p.element && p.image) await download(p.image, join(dir, `${p.element}.jpg`));
  }
  await python(['-m', 'instructions_pdf', 'match', bookletDir]);
  const matches = JSON.parse(readFileSync(join(bookletDir, 'matches.json'), 'utf8')) as Matches;

  const byElement = new Map(parts.filter((p) => p.element).map((p) => [p.element!, p]));
  // booklets sometimes print an alternate element id for a piece in the set: look those up
  const unknown = [...new Set([...matches.matches.flatMap((m) => (m.element ? [m.element] : [])), ...booklets.flatMap((b) => b.inventory.map((e) => e.element))])]
    .filter((e) => !byElement.has(e));
  const extra = inventory ? new Map<string, import('../src/instructions/rebrickable').SetPart>() : await loadElements(unknown, join(work, 'rebrickable-elements.json'));
  const inSet = new Set(parts.map((p) => `${p.ldrawPart}|${p.color}`));
  const hasPart = (id: string) => existsSync(join(LDRAW, 'parts', `${id.toLowerCase()}.dat`));
  const resolveElement = (element: string): Resolved => {
    const p = byElement.get(element) ?? extra.get(element);
    if (!p) return { part: '', color: null, flags: [`element ${element} not found on Rebrickable`] };
    const r = resolveSetPart(p, hasPart);
    if (!byElement.has(element) && !inSet.has(`${p.ldrawPart}|${p.color}`)) r.flags.push(`element ${element} (${p.ldrawPart} ${p.colorName}) is not in the Rebrickable inventory for ${set}`);
    return r;
  };
  const byId = new Map(booklets.map((b) => [b.id, b]));
  const modelBooklets = models.map(m => m.map(id => byId.get(id)!));
  const jobPath = join(work, 'placement-job.json');
  writeFileSync(jobPath, JSON.stringify(placementJob(name, modelBooklets, matches, resolveElement, bookletDir), null, 1));
  console.log(`  Placement evidence: ${jobPath}`);
  const { plan, flags } = planFromBooklets(name, modelBooklets, matches, resolveElement);
  const allFlags = [...assessment.issues.map(d => ({ message: `${d.booklet} page ${d.page ?? '?'}: ${d.message}` })), ...orderFlags.map((message) => ({ message })), ...(inventoryPage ? inventoryDiffs(booklets, parts, extra) : calloutUseDiffs(booklets, matches.matches, parts, extra)), ...flags];

  const colors = parseLDConfig(readFileSync(join(LDRAW, 'LDConfig.ldr'), 'utf8'));
  const mpdPath = resolve(out || join(work, `${name}.mpd`));
  mkdirSync(dirname(mpdPath), { recursive: true });
  writeFileSync(mpdPath, exportLDraw(plan, partMetrics(plan), colors));
  const reportPath = join(work, 'report.md');
  writeFileSync(reportPath, instructionsReport(name, plan, allFlags, matches, { inventoryPage }));
  const steps = models.length > 1 ? Object.values(plan.submodels ?? {}).reduce((n, s) => n + s.steps.length, 0) : plan.steps.length;
  console.log(`Parts layout (unplaced, not a complete model): ${name}: ${models.length} model(s), ${steps} steps, ${allFlags.length} flags`);
  console.log(`  MPD:    ${mpdPath}`);
  console.log(`  Report: ${reportPath}`);
  if (strict) process.exitCode = 2; // This stage has no placement/buildability evidence.
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
