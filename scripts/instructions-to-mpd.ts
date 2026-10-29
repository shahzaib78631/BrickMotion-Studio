/**
 * LEGO instruction booklets → BrickMotion MPD (Phase 1: parts, colours and official steps;
 * each step's new parts are laid out beside the model, not yet placed).
 *
 *   npm run instructions -- --name superman --set 40859-1 --pdf 6668730 --pdf 6668732 [--out file.mpd]
 *
 * --pdf takes a LEGO booklet id, a URL or a local file. Needs REBRICKABLE_API_KEY in the
 * environment the first time a set is fetched (the inventory is cached in the work folder).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { exportLDraw } from '../src/io/ldrawExport';
import { parseLDConfig } from '../src/ldraw/colors';
import { flattenPart } from '../src/ldraw/flatten';
import { measurePart, type PartMetrics } from '../src/ldraw/metrics';
import { parseLDraw, type LDrawFile } from '../src/ldraw/parse';
import type { Plan } from '../src/plan/types';
import { bookletUrl, orderBooklets } from '../src/instructions/booklets';
import { planFromBooklets, type Flag } from '../src/instructions/buildPlan';
import { loadSetParts, resolveSetPart, type Resolved, type SetPart } from '../src/instructions/rebrickable';
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
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === '--pdf' && v) (pdfs.push(v), i++);
    else if (argv[i] === '--name' && v) (name = v, i++);
    else if (argv[i] === '--set' && v) (set = v, i++);
    else if (argv[i] === '--out' && v) (out = v, i++);
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  if (!name || !set || !pdfs.length) throw new Error('Usage: npm run instructions -- --name <name> --set <set_num e.g. 40859-1> --pdf <id|url|path> [--pdf …] [--out file.mpd]');
  return { name, set, pdfs, out };
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
  const file = join(PDF_CACHE, /^\d+$/.test(spec.trim()) ? `${spec.trim()}.pdf` : basename(new URL(url).pathname) || 'booklet.pdf');
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

/** Booklet inventory counts vs the Rebrickable inventory (spares ignored). */
function inventoryDiffs(booklets: Booklet[], parts: SetPart[]): Flag[] {
  const booklet = new Map<string, number>();
  for (const b of booklets) for (const e of b.inventory) booklet.set(e.element, (booklet.get(e.element) ?? 0) + e.count);
  if (!booklet.size) return [];
  const api = new Map<string, number>();
  for (const p of parts) if (!p.spare && p.element) api.set(p.element, (api.get(p.element) ?? 0) + p.quantity);
  const flags: Flag[] = [];
  for (const e of new Set([...booklet.keys(), ...api.keys()])) {
    const a = booklet.get(e) ?? 0;
    const b = api.get(e) ?? 0;
    if (a !== b) flags.push({ message: `inventory: element ${e} is ${a}× in the booklet but ${b}× on Rebrickable` });
  }
  return flags;
}

async function main() {
  const { name, set, pdfs, out } = parseArgs(process.argv.slice(2));
  const work = join(ROOT, '.cache', 'instructions', name);
  const bookletDir = join(work, 'booklets');
  rmSync(bookletDir, { recursive: true, force: true });
  mkdirSync(bookletDir, { recursive: true });

  const extracted: Booklet[] = [];
  for (const spec of pdfs) {
    const pdf = await localPdf(spec);
    const id = basename(pdf).replace(/\.pdf$/i, '');
    await python(['-m', 'instructions_pdf', 'extract', pdf, join(bookletDir, id)]);
    extracted.push(JSON.parse(readFileSync(join(bookletDir, id, 'booklet.json'), 'utf8')) as Booklet);
  }
  const { booklets, models, flags: orderFlags } = orderBooklets(extracted);
  for (const b of extracted) if (!booklets.includes(b)) rmSync(join(bookletDir, b.id), { recursive: true, force: true });

  const parts = await loadSetParts(set, join(work, 'rebrickable-parts.json'));
  if (!booklets.some((b) => b.inventory.length)) {
    const dir = join(bookletDir, 'rb-images');
    mkdirSync(dir, { recursive: true });
    for (const p of parts) if (!p.spare && p.element && p.image) await download(p.image, join(dir, `${p.element}.jpg`));
  }
  await python(['-m', 'instructions_pdf', 'match', bookletDir]);
  const matches = JSON.parse(readFileSync(join(bookletDir, 'matches.json'), 'utf8')) as Matches;

  const byElement = new Map(parts.filter((p) => p.element).map((p) => [p.element!, p]));
  const hasPart = (id: string) => existsSync(join(LDRAW, 'parts', `${id.toLowerCase()}.dat`));
  const resolveElement = (element: string): Resolved => {
    const p = byElement.get(element);
    return p ? resolveSetPart(p, hasPart) : { part: '', color: null, flags: [`element ${element} not in Rebrickable inventory for ${set}`] };
  };
  const byId = new Map(booklets.map((b) => [b.id, b]));
  const { plan, flags } = planFromBooklets(name, models.map((m) => m.map((id) => byId.get(id)!)), matches, resolveElement);
  const allFlags = [...orderFlags.map((message) => ({ message })), ...inventoryDiffs(booklets, parts), ...flags];

  const colors = parseLDConfig(readFileSync(join(LDRAW, 'LDConfig.ldr'), 'utf8'));
  const mpdPath = resolve(out || join(work, `${name}.mpd`));
  writeFileSync(mpdPath, exportLDraw(plan, partMetrics(plan), colors));
  const reportPath = join(work, 'report.md');
  writeFileSync(reportPath, instructionsReport(name, plan, allFlags, matches));
  const steps = models.length > 1 ? Object.values(plan.submodels ?? {}).reduce((n, s) => n + s.steps.length, 0) : plan.steps.length;
  console.log(`✓ ${name}: ${models.length} model(s), ${steps} steps, ${allFlags.length} flags`);
  console.log(`  MPD:    ${mpdPath}`);
  console.log(`  Report: ${reportPath}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
