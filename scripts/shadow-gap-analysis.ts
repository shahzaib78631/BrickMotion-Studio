#!/usr/bin/env tsx
/**
 * READ-ONLY diagnostic: LDCad shadow-library connector coverage for the official
 * LDraw library, as seen through BrickMotion Studio's effective-snap pipeline.
 *
 * Writes only:
 *   docs/diagnostics/shadow-gaps.md
 *   docs/diagnostics/shadow-gaps/parts.csv
 *   docs/diagnostics/shadow-gaps/usage.csv
 *   docs/diagnostics/shadow-gaps/summary.json
 *
 * Run: npx tsx scripts/shadow-gap-analysis.ts
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeName, parseLDraw, parseMpd, type LDrawFile, type Mat3, type Vec3 } from '../src/ldraw/parse';
import { ownSnaps, shadowLookupFrom, type Snap } from '../src/ldraw/shadow';
import { supplementarySnapsFor } from '../src/data/connectorLibrary';

const T0 = performance.now();
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const LDRAW = join(ROOT, 'public', 'ldraw');
const PARTS = join(LDRAW, 'parts');
const DATA = join(ROOT, 'public', 'data');
const VENDOR = join(ROOT, 'vendor', 'LDCadShadowLibrary');
const OUT = join(ROOT, 'docs', 'diagnostics');
const OUT_DATA = join(OUT, 'shadow-gaps');
const REPORT = join(OUT, 'shadow-gaps.md');

// ---------------------------------------------------------------------------
// Types

type SnapClass = 'cylM' | 'cylF' | 'clp' | 'fgr' | 'genM' | 'genF';
type Status = 'covered' | 'inheritance gap' | 'geometry-only gap' | 'no connectors expected' | 'unknown' | 'target missing';
type Bucket = 'covered' | 'redirect/alias' | 'inheritance gap' | 'geometry-only gap' | 'no connectors expected' | 'unknown';

type ClassCounts = Record<SnapClass, number>;

interface ShadowPack {
  source: string;
  commit: string;
  license: string;
  files: Record<string, string>;
}

interface FamilyDef {
  id: string;
  label: string;
  re: RegExp;
  /** false = evidence only; never invent an expected snap for this family */
  expected: boolean;
  defaultClass: SnapClass;
}

interface PartMeta {
  id: string;
  file: string;
  title: string;
  category: string;
  orgRaw: string;
  orgType: string;
  isMoved: boolean;
  movedTo: string | null;
  isAlias: boolean;
  isPhysicalColour: boolean;
  isShortcut: boolean;
  isPrinted: boolean;
  printedBase: string | null;
  referencesBaseSubpart: boolean;
  directRefs: string[];
}

interface EvalResult {
  status: Status;
  missing: ClassCounts;
  significant: ClassCounts;
  missingTotal: number;
  missingByFamily: Record<string, number>;
  missingTypes: string;
}

interface Analysis {
  meta: PartMeta;
  annotated: ClassCounts;
  unannotated: ClassCounts;
  expected: ClassCounts;
  expectedByFamily: Record<string, ClassCounts>;
  evidence: Record<string, { count: number; names: Record<string, number> }>;
  effectiveShadow: ClassCounts;
  effectiveSupp: ClassCounts;
  snapKinds: Record<string, number>;
  snapGenders: Record<string, number>;
  sources: { file: string; count: number }[];
  hasShadowFile: boolean;
  ownSnapCount: number;
  inheritedSnapCount: number;
  allInherited: boolean;
  evalShadow: EvalResult;
  evalSupp: EvalResult;
  bucketShadow: Bucket;
  bucketSupp: Bucket;
  statusShadow: Status;
  statusSupp: Status;
  target: string | null;
  targetStatusShadow: Status | null;
  targetStatusSupp: Status | null;
  usageInstances: number;
  usageModels: number;
  rankable: boolean;
}

interface Usage {
  instances: number;
  models: Set<string>;
}

// ---------------------------------------------------------------------------
// Constants

const CLASSES: SnapClass[] = ['cylM', 'cylF', 'clp', 'fgr', 'genM', 'genF'];
const CLASS_LABEL: Record<SnapClass, string> = {
  cylM: 'cyl M', cylF: 'cyl F', clp: 'clip', fgr: 'hinge finger', genM: 'generic M', genF: 'generic F',
};

const emptyCounts = (): ClassCounts => ({ cylM: 0, cylF: 0, clp: 0, fgr: 0, genM: 0, genF: 0 });
const totalCounts = (c: ClassCounts): number => CLASSES.reduce((n, k) => n + c[k], 0);
const addInto = (a: ClassCounts, b: ClassCounts): void => { for (const k of CLASSES) a[k] += b[k]; };
const cloneCounts = (c: ClassCounts): ClassCounts => ({ ...c });

function countClasses(snaps: Snap[]): ClassCounts {
  const c = emptyCounts();
  for (const s of snaps) c[snapClass(s)] += 1;
  return c;
}

function snapClass(s: Snap): SnapClass {
  if (s.kind === 'cyl') return s.gender === 'M' ? 'cylM' : 'cylF';
  if (s.kind === 'clp') return 'clp';
  if (s.kind === 'fgr') return 'fgr';
  return s.gender === 'M' ? 'genM' : 'genF';
}

/**
 * Connector-primitive families. The seed set is the primitives the shadow
 * library annotates under vendor/LDCadShadowLibrary/p; the regexes also catch
 * official variants (npeghol*, stud5, axl5hol9, ...) that the seed implies but
 * does not enumerate. stug-* stud groups are excluded because their child
 * stud.dat instances are counted directly.
 */
const FAMILIES: FamilyDef[] = [
  { id: 'antistud', label: 'anti-stud / stud4', re: /stud4/i, expected: false, defaultClass: 'cylF' },
  { id: 'stud', label: 'stud', re: /^(?:stud|mstud|hipstud|filstud|clikitsstud|zstud|stu(?!g))/i, expected: true, defaultClass: 'cylM' },
  { id: 'peghole', label: 'peg hole (peghole/npeghol)', re: /^(?:n?peghol|peghole)/i, expected: true, defaultClass: 'cylF' },
  { id: 'beam-hole', label: 'Technic beam hole', re: /^(?:beamhol|beamhole)/i, expected: true, defaultClass: 'cylF' },
  { id: 'conn-hole', label: 'Technic connector hole', re: /^(?:connhol|connhole|dconnhole|duplohol)/i, expected: true, defaultClass: 'cylF' },
  { id: 'axle-hole', label: 'axle hole', re: /^(?:axl\d*(?:hol|ho)|axlehol|axleho|axlehole|daxlehole|wpinhole|wpinhol|axleend2hole)/i, expected: true, defaultClass: 'cylF' },
  { id: 'axle', label: 'axle', re: /^(?:axle\.dat|daxle\.dat|axl\d*(?:end|sphe)|axleend2?\.dat)$/i, expected: true, defaultClass: 'cylM' },
  { id: 'pin', label: 'Technic pin', re: /^(?:connect|confric|duplopin|wpin|steerend)/i, expected: true, defaultClass: 'cylM' },
  { id: 'clip', label: 'clip', re: /^clip\d/i, expected: true, defaultClass: 'clp' },
  { id: 'hinge', label: 'hinge finger', re: /^(?:clh(?!-base)|dhinge|arm[123]\.dat$|h[12]\.dat$)/i, expected: true, defaultClass: 'fgr' },
  { id: 'joint', label: 'joint / generic', re: /^(?:joint8|plug34|primotop|knob1)/i, expected: true, defaultClass: 'genM' },
  { id: 'bar', label: 'bar / handle', re: /^handle\d/i, expected: true, defaultClass: 'cylM' },
];

const DECORATIVE_CATEGORIES = new Set(['sticker', 'sticker shortcut', 'sheet fabric', 'sheet plastic', 'sheet cardboard']);
const HINT_CATEGORIES = new Set([
  'technic', 'wheel', 'hinge', 'bar', 'hose', 'turntable', 'crane', 'propeller', 'boat', 'electric', 'train',
  'door', 'window', 'minifig torso', 'minifig leg', 'minifig hips', 'minifig head', 'minifig', 'minifig accessory',
  'minifig headwear', 'minifig neckwear', 'minifig footwear', 'minifig hipwear', 'figure', 'figure accessory',
  'constraction', 'constraction accessory', 'vehicle', 'container', 'support', 'panel', 'fence', 'arch', 'dish',
  'cone', 'cylinder', 'sphere', 'plant', 'animal', 'tile', 'baseplate', 'magnet',
]);
const HINT_TITLE = /\b(technic|pin|axle|beam|wheel|tyre|tire|rim|hub|hinge|clip|bar|hose|turntable|joint|ball|socket|magnet|torso|hips|leg|arm|hand|saddle|hook|handle|connector|coupl|bracket|holder|mount|fork|propeller|rotor|blade|gear|pulley|winch|spring|shock|cylinder|piston|engine|motor|battery|plug|cable|wire|chain|track|rail|bogie|hitch|stud|peg|hole)\b/i;

// ---------------------------------------------------------------------------
// Small helpers

const normPath = (p: string): string => p.replace(/\\/g, '/');

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function filesUnder(dir: string, depth: number): string[] {
  if (depth < 0) return [];
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, depth - 1));
    else if (e.isFile() && /\.(?:mpd|ldr)$/i.test(e.name)) out.push(p);
  }
  return out;
}

function csv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map((v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n') + '\n';
}

function pct(n: number, d: number): string { return d ? `${(100 * n / d).toFixed(1)}%` : '0.0%'; }
function one(n: number): string { return Number.isInteger(n) ? String(n) : n.toFixed(1); }
function mdTable(head: string[], rows: (string | number)[][]): string {
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map((x) => String(x).replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n');
}

// ---------------------------------------------------------------------------
// Load inputs

const pack = JSON.parse(readFileSync(join(DATA, 'ldcad-shadow.json'), 'utf8')) as ShadowPack;
const shadow = shadowLookupFrom(pack.files);

const primitiveRel = new Set(walkFiles(join(LDRAW, 'p')).map((p) => normPath(p.slice(join(LDRAW, 'p').length + 1)).toLowerCase()));
const familyById = new Map(FAMILIES.map((f) => [f.id, f]));
const familyNameCache = new Map<string, string | null>();

function familyOf(name: string): FamilyDef | null {
  const b = basename(normPath(name)).toLowerCase();
  if (familyNameCache.has(b)) {
    const id = familyNameCache.get(b);
    return id ? familyById.get(id) ?? null : null;
  }
  let found: FamilyDef | null = null;
  if (!/^(?:stud-logo|studline)/.test(b)) {
    for (const f of FAMILIES) if (f.re.test(b)) { found = f; break; }
  }
  familyNameCache.set(b, found?.id ?? null);
  return found;
}

// Validate the seed claim: every active shadow primitive should fall in a family.
let unmappedSeed: string[] = [];
try {
  for (const f of readdirSync(join(VENDOR, 'p')).filter((x) => x.endsWith('.dat')).sort()) {
    const text = readFileSync(join(VENDOR, 'p', f), 'utf8');
    if (/^\s*0\s+!LDCAD\s+SNAP_/mi.test(text) && !familyOf(f)) unmappedSeed.push(f);
  }
} catch { unmappedSeed = []; }

const fileCache = new Map<string, { file: LDrawFile; primitive: boolean } | null>();

function resolveFile(name: string): { file: LDrawFile; primitive: boolean } | null {
  const n = normalizeName(name);
  if (fileCache.has(n)) return fileCache.get(n) ?? null;
  const partsPath = join(PARTS, n);
  const primPath = join(LDRAW, 'p', n);
  let entry: { file: LDrawFile; primitive: boolean } | null = null;
  if (existsSync(partsPath)) entry = { file: parseLDraw(readFileSync(partsPath, 'utf8'), n), primitive: false };
  else if (existsSync(primPath)) entry = { file: parseLDraw(readFileSync(primPath, 'utf8'), n), primitive: true };
  fileCache.set(n, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Reference-tree utilities

const descendantConnectorCache = new Map<string, boolean>();

/** Does a primitive contain another connector primitive below it? */
function hasConnectorDescendant(name: string, stack = new Set<string>()): boolean {
  const n = normalizeName(name);
  if (descendantConnectorCache.has(n)) return descendantConnectorCache.get(n)!;
  if (stack.has(n)) return false;
  stack.add(n);
  const r = resolveFile(n);
  let found = false;
  if (r) {
    for (const c of r.file.cmds) {
      if (c.t !== 'ref') continue;
      const child = normalizeName(c.file);
      if (!primitiveRel.has(child)) continue;
      if (familyOf(child) || hasConnectorDescendant(child, stack)) { found = true; break; }
    }
  }
  stack.delete(n);
  descendantConnectorCache.set(n, found);
  return found;
}

const profileCache = new Map<string, ClassCounts>();

function annotatedProfile(name: string): ClassCounts {
  const n = normalizeName(name);
  const hit = profileCache.get(n);
  if (hit) return hit;
  const counts = countClasses(ownSnaps(n, shadow));
  profileCache.set(n, counts);
  return counts;
}

const I3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const mulMat = (a: Mat3, b: Mat3): Mat3 => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];
const applyMat = (m: Mat3, p: Vec3): Vec3 => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2], m[3] * p[0] + m[4] * p[1] + m[5] * p[2], m[6] * p[0] + m[7] * p[1] + m[8] * p[2],
];

// ---------------------------------------------------------------------------
// Effective-snap walk (mirrors src/ldraw/flatten.ts collect/dropsBelow)

interface Collected { snap: Snap; source: string; depth: number }

function collectPart(id: string): {
  snaps: Collected[];
  sources: Map<string, number>;
  allRefs: Set<string>;
  evidence: Record<string, { count: number; names: Record<string, number> }>;
  annotated: ClassCounts;
  unannotated: ClassCounts;
  annotatedByFamily: Record<string, ClassCounts>;
  unannotatedByFamily: Record<string, ClassCounts>;
} {
  const snaps: Collected[] = [];
  const sources = new Map<string, number>();
  const allRefs = new Set<string>();
  const evidence: Record<string, { count: number; names: Record<string, number> }> = {};
  const annotated = emptyCounts();
  const unannotated = emptyCounts();
  const annotatedByFamily: Record<string, ClassCounts> = {};
  const unannotatedByFamily: Record<string, ClassCounts> = {};

  const collect = (name: string, m: Mat3, t: Vec3, dropped: 'all' | string[], depth: number): void => {
    if (dropped === 'all') return;
    for (const snap of ownSnaps(name, shadow, m, t)) {
      if (snap.id && dropped.some((d) => d.toLowerCase() === snap.id!.toLowerCase())) continue;
      snaps.push({ snap, source: name, depth });
      sources.set(name, (sources.get(name) ?? 0) + 1);
    }
  };
  const dropsBelow = (name: string, dropped: 'all' | string[]): 'all' | string[] => {
    if (dropped === 'all') return dropped;
    const info = shadow(name);
    if (!info || info.clear === undefined) return dropped;
    return info.clear === null ? 'all' : [...dropped, ...info.clear];
  };

  const walk = (name: string, m: Mat3, t: Vec3, depth: number, dropped: 'all' | string[]): void => {
    if (depth > 32) return;
    collect(name, m, t, dropped, depth);
    const below = dropsBelow(name, dropped);
    const r = resolveFile(name);
    if (!r) return;
    for (const c of r.file.cmds) {
      if (c.t !== 'ref') continue;
      const childName = normalizeName(c.file);
      allRefs.add(childName);
      const cm = mulMat(m, c.m);
      const ct = applyMat(m, c.pos);
      const ct3: Vec3 = [ct[0] + t[0], ct[1] + t[1], ct[2] + t[2]];
      allRefs.add(childName);
      if (r.primitive || primitiveRel.has(childName)) {
        // The parent must be a primitive container for the child to count; a
        // top-level part referencing p/x also counts, hence the second test.
      }
      const childResolved = resolveFile(childName);
      if (childResolved?.primitive) {
        const fam = familyOf(childName);
        if (fam) {
          const ev = evidence[fam.id] ?? (evidence[fam.id] = { count: 0, names: {} });
          ev.count += 1;
          const bn = basename(childName);
          ev.names[bn] = (ev.names[bn] ?? 0) + 1;
          const prof = annotatedProfile(childName);
          if (totalCounts(prof) > 0) {
            const byFam = annotatedByFamily[fam.id] ?? (annotatedByFamily[fam.id] = emptyCounts());
            addInto(annotated, prof);
            addInto(byFam, prof);
          } else if (fam.expected && !hasConnectorDescendant(childName)) {
            const one = emptyCounts();
            one[fam.defaultClass] = 1;
            const byFam = unannotatedByFamily[fam.id] ?? (unannotatedByFamily[fam.id] = emptyCounts());
            addInto(unannotated, one);
            addInto(byFam, one);
          }
        }
      }
      walk(childName, cm, ct3, depth + 1, below);
    }
  };

  walk(`${id.toLowerCase()}.dat`, I3, [0, 0, 0], 0, []);
  return { snaps, sources, allRefs, evidence, annotated, unannotated, annotatedByFamily, unannotatedByFamily };
}

// ---------------------------------------------------------------------------
// Part metadata

function readPartMetas(): PartMeta[] {
  const files = readdirSync(PARTS).filter((f) => f.toLowerCase().endsWith('.dat')).sort();
  const out: PartMeta[] = [];
  for (const f of files) {
    const id = f.replace(/\.dat$/i, '');
    const text = readFileSync(join(PARTS, f), 'utf8');
    const lower = f.toLowerCase();
    const partsPath = join(PARTS, lower);
    const parsed = parseLDraw(text, lower);
    fileCache.set(lower, { file: parsed, primitive: false });
    const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
    const title = (parsed.description || firstLine.replace(/^0\s+/, '')).trim();
    const category = /^0\s+!CATEGORY\s+(.+?)\s*$/im.exec(text)?.[1].trim() ?? '';
    const orgRaw = /^0\s+!LDRAW_ORG\s+(.+?)\s*$/im.exec(text)?.[1].trim() ?? '';
    const orgType = orgRaw.split(/\s+/)[0] ?? '';
    const movedMatch = /^~Moved to\s+(\S+)/i.exec(title);
    const movedTo = movedMatch ? movedMatch[1].replace(/\.dat$/i, '') : null;
    const isAlias = /Alias/i.test(orgRaw);
    const isPhysicalColour = /Physical_Colour/i.test(orgRaw);
    const isShortcut = /^Shortcut/i.test(orgRaw);
    const pat = /(?:p\d+[a-z]?|pb\d+[a-z]?)$/i.exec(id);
    const isPrinted = !!pat || /\b(?:pattern|printed)\b/i.test(title);
    const printedBase = pat ? id.slice(0, pat.index) : null;
    const directRefs = parsed.cmds.filter((c) => c.t === 'ref').map((c) => normalizeName(c.file));
    out.push({
      id, file: f, title, category, orgRaw, orgType,
      isMoved: !!movedTo, movedTo, isAlias, isPhysicalColour, isShortcut,
      isPrinted, printedBase, referencesBaseSubpart: false, directRefs,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation

function toleranceFor(c: SnapClass, byFamily: Record<string, ClassCounts>): number {
  const fams = Object.entries(byFamily).filter(([, v]) => v[c] > 0).map(([k]) => k);
  if (fams.length && fams.every((f) => f === 'pin' || f === 'axle')) return 0.5; // one long snap can span both ends
  if (fams.length && fams.every((f) => f === 'peghole' || f === 'axle-hole')) return 0.5;
  if (c === 'fgr' || c === 'genM' || c === 'genF') return 0.5;
  return 0.75;
}

function evaluate(expected: ClassCounts, byFamily: Record<string, ClassCounts>, effective: ClassCounts, decorative: boolean, baseplateSpecial: boolean, hint: boolean): EvalResult {
  const expTotal = totalCounts(expected);
  const effTotal = totalCounts(effective);
  const missing = emptyCounts();
  const significant = emptyCounts();
  for (const c of CLASSES) {
    if (expected[c] <= 0) continue;
    const tol = toleranceFor(c, byFamily);
    if (effective[c] < expected[c] * tol) significant[c] = expected[c] - effective[c];
    if (effective[c] < expected[c]) missing[c] = expected[c] - effective[c];
  }
  let status: Status;
  if (expTotal > 0) status = totalCounts(significant) > 0 ? 'inheritance gap' : 'covered';
  else if (effTotal > 0) status = 'covered';
  else if (decorative || baseplateSpecial) status = 'no connectors expected';
  else if (hint) status = 'geometry-only gap';
  else status = 'unknown';

  const missingByFamily: Record<string, number> = {};
  if (status === 'inheritance gap') {
    for (const c of CLASSES) {
      const miss = significant[c];
      if (miss <= 0) continue;
      const fams = Object.entries(byFamily).filter(([, v]) => v[c] > 0);
      const denom = fams.reduce((n, [, v]) => n + v[c], 0);
      for (const [f, v] of fams) missingByFamily[f] = (missingByFamily[f] ?? 0) + (denom ? miss * v[c] / denom : 0);
    }
  }

  const missingTypes = status === 'inheritance gap'
    ? CLASSES.filter((c) => significant[c] > 0).map((c) => `${CLASS_LABEL[c]} ${effective[c]}/${expected[c]}`).join('; ')
    : status === 'geometry-only gap' ? 'no effective snaps' : '';
  return { status, missing, significant, missingTotal: totalCounts(significant), missingByFamily, missingTypes };
}

function isDecorative(meta: PartMeta): boolean {
  const cat = meta.category.toLowerCase();
  if (DECORATIVE_CATEGORIES.has(cat)) return true;
  if (meta.isShortcut && /sticker/i.test(meta.category)) return true;
  return /sticker/i.test(meta.title) || /^(?:sheet |cardboard|plastic sheet|fabric )/i.test(meta.title);
}

function connectorHint(meta: PartMeta): boolean {
  return HINT_CATEGORIES.has(meta.category.toLowerCase()) || HINT_TITLE.test(meta.title);
}

function bucketOf(status: Status): Bucket {
  if (status === 'covered') return 'covered';
  if (status === 'inheritance gap') return 'inheritance gap';
  if (status === 'geometry-only gap') return 'geometry-only gap';
  if (status === 'no connectors expected') return 'no connectors expected';
  if (status === 'unknown') return 'unknown';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Main analysis

const partMetas = readPartMetas();
const metaById = new Map(partMetas.map((m) => [m.id.toLowerCase(), m]));
const analyses: Analysis[] = [];

for (const meta of partMetas) {
  const walk = collectPart(meta.id);
  const decorative = isDecorative(meta);
  const baseplateSpecial = meta.category.toLowerCase() === 'baseplate' && totalCounts(walk.annotated) === 0 && totalCounts(walk.unannotated) === 0;
  const hint = connectorHint(meta);
  meta.referencesBaseSubpart = !!meta.printedBase && [...walk.allRefs].some((r) => {
    const b = basename(r);
    return b.startsWith(meta.printedBase!.toLowerCase() + 's') || b === meta.printedBase!.toLowerCase() + '.dat';
  });

  const expected = emptyCounts();
  const expectedByFamily: Record<string, ClassCounts> = {};
  for (const c of CLASSES) expected[c] = walk.annotated[c] > 0 ? walk.annotated[c] : walk.unannotated[c];
  for (const [fam, counts] of Object.entries(walk.annotatedByFamily)) {
    const dst = expectedByFamily[fam] ?? (expectedByFamily[fam] = emptyCounts());
    addInto(dst, counts);
  }
  for (const [fam, counts] of Object.entries(walk.unannotatedByFamily)) {
    const dst = expectedByFamily[fam] ?? (expectedByFamily[fam] = emptyCounts());
    for (const c of CLASSES) if (walk.annotated[c] === 0) dst[c] += counts[c];
  }
  // An axle draws its own cross-shaped body with axlehol* primitives: those are
  // not holes. A part with axle-end primitives (or flexible-axle s/faxle* segments) is an axle body.
  const axleHoles = expectedByFamily['axle-hole'];
  const axleBody = !!walk.evidence['axle'] || [...walk.allRefs].some((r) => /(^|\/)faxle\d*\.dat$/i.test(r));
  if (axleBody && axleHoles) {
    for (const c of CLASSES) expected[c] = Math.max(0, expected[c] - axleHoles[c]);
    delete expectedByFamily['axle-hole'];
  }
  // Hinge primitives repeat once per tooth, but LDCad models a whole finger set
  // as one SNAP_FGR, so only require that some finger connector exists.
  if (expected.fgr > 1) expected.fgr = 1;
  for (const counts of Object.values(expectedByFamily)) if (counts.fgr > 1) counts.fgr = 1;

  const effectiveShadow = countClasses(walk.snaps.map((x) => x.snap));
  const shadowSnaps = walk.snaps.map((x) => x.snap);
  const seen = new Set(shadowSnaps.map((s) => (s.group ?? '').toLowerCase() || `${s.kind}|${s.gender}`));
  const withSupp = [...shadowSnaps];
  for (const s of supplementarySnapsFor(meta.id)) {
    const k = (s.group ?? '').toLowerCase() || `${s.kind}|${s.gender}`;
    if (seen.has(k)) continue;
    seen.add(k);
    withSupp.push(s);
  }
  const effectiveSupp = countClasses(withSupp);
  const snapKinds: Record<string, number> = {};
  const snapGenders: Record<string, number> = {};
  for (const s of withSupp) {
    snapKinds[s.kind] = (snapKinds[s.kind] ?? 0) + 1;
    snapGenders[s.gender] = (snapGenders[s.gender] ?? 0) + 1;
  }
  const sources = [...walk.sources.entries()].map(([file, count]) => ({ file, count })).sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
  const ownSnapCount = walk.snaps.filter((x) => x.depth === 0).length;
  const inheritedSnapCount = walk.snaps.length - ownSnapCount;

  const evalShadow = evaluate(expected, expectedByFamily, effectiveShadow, decorative, baseplateSpecial, hint);
  const evalSupp = evaluate(expected, expectedByFamily, effectiveSupp, decorative, baseplateSpecial, hint);

  analyses.push({
    meta, annotated: walk.annotated, unannotated: walk.unannotated, expected, expectedByFamily,
    evidence: walk.evidence, effectiveShadow, effectiveSupp, snapKinds, snapGenders, sources,
    hasShadowFile: shadow(`${meta.id.toLowerCase()}.dat`) !== null,
    ownSnapCount, inheritedSnapCount, allInherited: ownSnapCount === 0 && inheritedSnapCount > 0,
    evalShadow, evalSupp,
    bucketShadow: 'unknown', bucketSupp: 'unknown', statusShadow: 'unknown', statusSupp: 'unknown',
    target: null, targetStatusShadow: null, targetStatusSupp: null,
    usageInstances: 0, usageModels: 0,
    rankable: !(meta.isMoved || meta.isAlias || meta.isPhysicalColour),
  });
}

// First pass base status maps (before redirect resolution).
const baseStatusShadow = new Map<string, Status>();
const baseStatusSupp = new Map<string, Status>();
for (const a of analyses) {
  baseStatusShadow.set(a.meta.id.toLowerCase(), a.evalShadow.status);
  baseStatusSupp.set(a.meta.id.toLowerCase(), a.evalSupp.status);
}

function redirectTargetOf(meta: PartMeta): string | null {
  if (meta.isMoved) return meta.movedTo;
  if (meta.isAlias || meta.isPhysicalColour) {
    const first = meta.directRefs[0];
    if (!first) return null;
    return basename(first).replace(/\.dat$/i, '');
  }
  return null;
}

function resolveTargetStatus(id: string | null, statuses: Map<string, Status>): Status | null {
  if (!id) return null;
  let cur = id.toLowerCase();
  const seen = new Set<string>();
  for (let i = 0; i < 12 && cur; i++) {
    if (seen.has(cur)) return 'target missing';
    seen.add(cur);
    const m = metaById.get(cur);
    if (!m) return 'target missing';
    const next = redirectTargetOf(m);
    if (next && metaById.has(next.toLowerCase())) { cur = next.toLowerCase(); continue; }
    return statuses.get(cur) ?? 'target missing';
  }
  return 'target missing';
}

for (const a of analyses) {
  const movedOrAlias = a.meta.isMoved || a.meta.isAlias || a.meta.isPhysicalColour;
  if (movedOrAlias) {
    a.target = redirectTargetOf(a.meta);
    a.targetStatusShadow = resolveTargetStatus(a.target, baseStatusShadow);
    a.targetStatusSupp = resolveTargetStatus(a.target, baseStatusSupp);
    a.bucketShadow = 'redirect/alias';
    a.bucketSupp = 'redirect/alias';
    a.statusShadow = a.targetStatusShadow ?? 'target missing';
    a.statusSupp = a.targetStatusSupp ?? 'target missing';
  } else if (a.meta.isShortcut) {
    a.target = a.meta.directRefs.length === 1 ? basename(a.meta.directRefs[0]).replace(/\.dat$/i, '') : null;
    a.targetStatusShadow = resolveTargetStatus(a.target, baseStatusShadow);
    a.targetStatusSupp = resolveTargetStatus(a.target, baseStatusSupp);
    a.bucketShadow = 'redirect/alias';
    a.bucketSupp = 'redirect/alias';
    a.statusShadow = a.evalShadow.status;
    a.statusSupp = a.evalSupp.status;
  } else {
    a.bucketShadow = bucketOf(a.evalShadow.status);
    a.bucketSupp = bucketOf(a.evalSupp.status);
    a.statusShadow = a.evalShadow.status;
    a.statusSupp = a.evalSupp.status;
  }
}

// ---------------------------------------------------------------------------
// Usage corpus

function embeddedPartId(name: string): string | null {
  const b = basename(normalizeName(name)).replace(/\.(?:dat|ldr)$/i, '').trim();
  const m = /^.+?\s+-\s+([a-z0-9_.-]+)$/i.exec(b);
  return m ? m[1].toLowerCase() : null;
}

const partIdSet = new Set(partMetas.map((m) => m.id.toLowerCase()));

function canonicalUsageId(id: string): string {
  let cur = id.toLowerCase();
  const seen = new Set<string>();
  for (let i = 0; i < 12; i++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const m = metaById.get(cur);
    if (!m) break;
    const next = redirectTargetOf(m);
    if (next && partIdSet.has(next.toLowerCase())) { cur = next.toLowerCase(); continue; }
    break;
  }
  return cur;
}

const corpusFiles = [...new Set([
  ...filesUnder(join(homedir(), 'Downloads'), 6),
  ...filesUnder(join(ROOT, 'samples'), 6),
  ...filesUnder(join(LDRAW, 'models'), 6),
  ...filesUnder(join(DATA), 6),
])].filter((f) => !/^LDConfig.*\.ldr$/i.test(basename(f))).sort();

const usage = new Map<string, Usage>();
const corpus = { files: corpusFiles.length, models: 0, pieces: 0, distinctParts: 0, unresolvedRefs: new Set<string>() };

function addUsage(id: string, modelKey: string): void {
  const c = canonicalUsageId(id);
  let u = usage.get(c);
  if (!u) usage.set(c, (u = { instances: 0, models: new Set<string>() }));
  u.instances += 1;
  u.models.add(modelKey);
}

function countModel(text: string, filePath: string): void {
  const parsed = /^\s*0\s+FILE\s+/im.test(text) ? parseMpd(text) : {
    main: 'main.ldr',
    files: new Map<string, LDrawFile>([['main.ldr', parseLDraw(text, 'main.ldr')]]),
  };
  const files = parsed.files;
  if (!files.size) return;
  const referenced = new Set<string>();
  for (const f of files.values()) for (const c of f.cmds) if (c.t === 'ref') {
    const n = normalizeName(c.file);
    if (files.has(n)) referenced.add(n);
  }
  let roots = [...files.keys()].filter((n) => !referenced.has(n) && !(embeddedPartId(n) && partIdSet.has(embeddedPartId(n)!)));
  if (!roots.length) roots = [parsed.main];
  roots.sort();
  for (const root of roots) {
    corpus.models += 1;
    const modelKey = `${filePath}#${root}`;
    const stack = new Set<string>();
    const visit = (name: string): void => {
      if (stack.has(name)) return;
      stack.add(name);
      const f = files.get(name);
      if (!f) { stack.delete(name); return; }
      for (const c of f.cmds) {
        if (c.t !== 'ref') continue;
        const ref = normalizeName(c.file);
        if (files.has(ref)) {
          const emb = embeddedPartId(ref);
          if (emb && partIdSet.has(emb)) addUsage(emb, modelKey);
          else visit(ref);
          continue;
        }
        const id = ref.replace(/\.(?:dat|ldr)$/i, '');
        if (partIdSet.has(id)) { addUsage(id, modelKey); continue; }
        const emb = embeddedPartId(ref);
        if (emb && partIdSet.has(emb)) { addUsage(emb, modelKey); continue; }
        corpus.unresolvedRefs.add(ref);
      }
      stack.delete(name);
    };
    visit(root);
  }
}

for (const f of corpusFiles) {
  try {
    countModel(readFileSync(f, 'utf8'), f);
  } catch (e) {
    console.warn(`model parse failed: ${f}: ${(e as Error).message}`);
  }
}
for (const u of usage.values()) corpus.pieces += u.instances;
corpus.distinctParts = usage.size;
for (const a of analyses) {
  const u = usage.get(a.meta.id.toLowerCase());
  if (u) { a.usageInstances = u.instances; a.usageModels = u.models.size; }
}

// ---------------------------------------------------------------------------
// Aggregates

const N = analyses.length;
const BUCKET_ORDER: Bucket[] = ['covered', 'redirect/alias', 'inheritance gap', 'geometry-only gap', 'no connectors expected', 'unknown'];
const STATUS_ORDER: Status[] = ['covered', 'inheritance gap', 'geometry-only gap', 'no connectors expected', 'unknown', 'target missing'];

function bucketCounts(which: 'supp' | 'shadow'): Record<Bucket, number> {
  const out = Object.fromEntries(BUCKET_ORDER.map((b) => [b, 0])) as Record<Bucket, number>;
  for (const a of analyses) out[which === 'supp' ? a.bucketSupp : a.bucketShadow] += 1;
  return out;
}
function statusCounts(which: 'supp' | 'shadow'): Record<Status, number> {
  const out = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<Status, number>;
  for (const a of analyses) out[which === 'supp' ? a.statusSupp : a.statusShadow] += 1;
  return out;
}

const bucketsSupp = bucketCounts('supp');
const bucketsShadow = bucketCounts('shadow');
const statusesSupp = statusCounts('supp');
const statusesShadow = statusCounts('shadow');

const shortcutAnalyses = analyses.filter((a) => a.meta.isShortcut);
const shortcutStatusSupp = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<Status, number>;
for (const a of shortcutAnalyses) shortcutStatusSupp[a.statusSupp] += 1;

const gapParts = analyses.filter((a) => a.rankable && (a.statusSupp === 'inheritance gap' || a.statusSupp === 'geometry-only gap'));
const topGaps = [...gapParts].sort((a, b) =>
  b.usageInstances - a.usageInstances || b.usageModels - a.usageModels ||
  b.evalSupp.missingTotal - a.evalSupp.missingTotal || a.meta.id.localeCompare(b.meta.id)).slice(0, 50);

function familyGroupOf(meta: PartMeta): string {
  const cat = meta.category.trim();
  if (cat && cat.toLowerCase() !== 'obsolete') return cat;
  const t = meta.title.toLowerCase();
  if (/technic/.test(t)) return 'Technic';
  if (/wheel|tyre|tire|rim/.test(t)) return 'Wheel/Tyre';
  if (/minifig|torso|leg|hips|head/.test(t)) return 'Minifig';
  if (/hinge/.test(t)) return 'Hinge';
  if (/hose/.test(t)) return 'Hose';
  if (/sticker/.test(t)) return 'Sticker';
  if (/clip|bar\b/.test(t)) return 'Bar/Clip';
  if (/plate/.test(t)) return 'Plate';
  if (/tile/.test(t)) return 'Tile';
  if (/brick/.test(t)) return 'Brick';
  if (/slope/.test(t)) return 'Slope';
  if (cat) return cat;
  return 'Uncategorised';
}

const familyGroups = new Map<string, { parts: number; usage: number; missing: number; examples: { id: string; usage: number }[] }>();
for (const a of gapParts) {
  const g = familyGroupOf(a.meta);
  const row = familyGroups.get(g) ?? { parts: 0, usage: 0, missing: 0, examples: [] };
  row.parts += 1;
  row.usage += a.usageInstances;
  row.missing += a.statusSupp === 'inheritance gap' ? a.evalSupp.missingTotal : 1;
  row.examples.push({ id: a.meta.id, usage: a.usageInstances });
  familyGroups.set(g, row);
}

const inheritanceParts = analyses.filter((a) => a.statusSupp === 'inheritance gap');
const inheritanceByPrimitive = new Map<string, { parts: number; missing: number; weighted: number; examples: { id: string; usage: number }[] }>();
for (const a of inheritanceParts) {
  for (const [fam, miss] of Object.entries(a.evalSupp.missingByFamily)) {
    if (miss <= 0) continue;
    const row = inheritanceByPrimitive.get(fam) ?? { parts: 0, missing: 0, weighted: 0, examples: [] };
    row.parts += 1;
    row.missing += miss;
    row.weighted += miss * Math.max(1, a.usageInstances);
    row.examples.push({ id: a.meta.id, usage: a.usageInstances });
    inheritanceByPrimitive.set(fam, row);
  }
}

// Next data-fill tasks
interface Task { kind: string; key: string; title: string; parts: number; missing: number; weighted: number; examples: string[]; upstream: string }
const taskCandidates: Task[] = [];
for (const [fam, row] of inheritanceByPrimitive) {
  const f = familyById.get(fam);
  taskCandidates.push({
    kind: 'primitive', key: fam,
    title: `Add/repair ${f?.label ?? fam} connectors (primitive family "${fam}")`,
    parts: row.parts, missing: Math.round(row.missing), weighted: Math.round(row.weighted),
    examples: [...row.examples].sort((a, b) => b.usage - a.usage || a.id.localeCompare(b.id)).slice(0, 4).map((x) => x.id),
    upstream: 'yes — directly useful to the LDCad Shadow Library',
  });
}
for (const [group, row] of familyGroups) {
  if (row.missing > 1) continue; // inheritance groups are handled above
  taskCandidates.push({
    kind: 'geometry', key: group,
    title: `Hand-model connectors for ${group} parts with no shadow coverage`,
    parts: row.parts, missing: row.parts, weighted: Math.round(row.usage),
    examples: [...row.examples].sort((a, b) => b.usage - a.usage || a.id.localeCompare(b.id)).slice(0, 4).map((x) => x.id),
    upstream: 'yes, with manual modelling and review',
  });
}
const suppOnly = analyses.filter((a) => a.rankable && (a.statusShadow === 'inheritance gap' || a.statusShadow === 'geometry-only gap') && a.statusSupp === 'covered');
if (suppOnly.length) {
  taskCandidates.push({
    kind: 'supplementary', key: 'tyre-rim',
    title: 'Promote the app-measured tyre/rim seat connectors into shadow data',
    parts: suppOnly.length, missing: suppOnly.length,
    weighted: suppOnly.reduce((n, a) => n + Math.max(1, a.usageInstances), 0),
    examples: suppOnly.slice(0, 6).map((a) => a.meta.id),
    upstream: 'not ready — app-specific measured fallback; propose SNAP_GEN/SNAP_CYL upstream after review',
  });
}
const nextTasks = taskCandidates.sort((a, b) =>
  b.weighted - a.weighted || b.missing - a.missing || b.parts - a.parts || a.title.localeCompare(b.title)).slice(0, 10);

// Sanity checks
const SANITY: { id: string; note: string; expect: Status }[] = [
  { id: '3001', note: '2x4 brick: 8 top studs and 8 underside receptacles inherited from s/3001s01.', expect: 'covered' },
  { id: '3023b', note: '1x2 plate: stud3 + two studs via stug-1x2; 2 underside receptacles from s/3023bs01.', expect: 'covered' },
  { id: '3673', note: 'Technic pin: SNAP_CLEAR drops two inherited connect snaps; one long M + one F consolidate them.', expect: 'covered' },
  { id: '32316', note: 'Technic beam 5: four beamhole snaps + connhole + own SNAP_INCL.', expect: 'covered' },
  { id: '6558', note: 'Long friction pin: SNAP_CLEAR + consolidated M/F; pin tolerance accepts it.', expect: 'covered' },
  { id: '42610', note: 'Wheel rim: shadow F hole; supplementary adds measured M seat.', expect: 'covered' },
  { id: '51011', note: 'Tyre: no shadow; supplementary F seat makes it covered (geometry-only without supplement).', expect: 'covered' },
  { id: '61254', note: 'Large tyre: no shadow; supplementary F seat makes it covered (geometry-only without supplement).', expect: 'covered' },
  { id: '13971', note: 'Wheel rim: shadow connhole F; supplementary adds measured M seat.', expect: 'covered' },
  { id: '6014c01', note: '~Moved to shortcut 6014bc01; target exposes an axle-hole primitive but has no shadow, so the redirect inherits an inheritance-gap status.', expect: 'inheritance gap' },
  { id: '6014bc01', note: 'Wheel assembly shortcut: 6014b contains wpinhol2.dat (axle hole) but no shadow data covers it.', expect: 'inheritance gap' },
  { id: '10', note: '~Moved to 10a; target baseplate has full stud coverage.', expect: 'covered' },
  { id: '973p34', note: 'Printed minifig torso: printed suffix, but inherits the base torso subpart s/973s01.', expect: 'covered' },
  { id: '973', note: 'Minifig torso base: 4 F + 1 M inherited from s/973s01.', expect: 'covered' },
  { id: '3811', note: '32x32 baseplate: 1024 stud.dat instances -> 1024 M snaps.', expect: 'covered' },
  { id: '3069b', note: '1x2 tile: two F underside receptacles from s/3069bs01.', expect: 'covered' },
  { id: '22678', note: '31L ribbed hose: no shadow and no connector primitives; hand-modelled flexible part.', expect: 'geometry-only gap' },
  { id: '10202d01', note: 'Sticker shortcut keeps the base 6x6 tile underside: 36 F snaps from s/10202s01; the sticker itself adds no connectors.', expect: 'covered' },
];
const sanityRows = SANITY.map((s) => {
  const a = analyses.find((x) => x.meta.id.toLowerCase() === s.id.toLowerCase());
  if (!a) return { ...s, found: false, status: 'not found' as Status, a: null };
  return { ...s, found: true, status: a.statusSupp, a };
});

// ---------------------------------------------------------------------------
// Version / upstream

let ldrawNewest = '';
for (const meta of partMetas) {
  const text = readFileSync(join(PARTS, meta.file), 'utf8');
  for (const m of text.matchAll(/!LDRAW_ORG[^\n]*UPDATE\s+(\d{4}-\d{2})/gi)) if (m[1] > ldrawNewest) ldrawNewest = m[1];
}
const shadowCommit = pack.commit;
let localShadowCommit = shadowCommit;
let upstreamHead = '';
let upstreamNote = '';
try {
  localShadowCommit = execSync('git -C vendor/LDCadShadowLibrary rev-parse HEAD', { cwd: ROOT, encoding: 'utf8', timeout: 10000 }).trim();
} catch { /* keep pack commit */ }
try {
  upstreamHead = execSync('git -C vendor/LDCadShadowLibrary ls-remote origin HEAD', { cwd: ROOT, encoding: 'utf8', timeout: 15000 }).trim().split(/\s+/)[0] ?? '';
  upstreamNote = upstreamHead === localShadowCommit ? 'same as checkout' : upstreamHead ? 'upstream differs from checkout' : 'no result';
} catch {
  upstreamNote = 'upstream check unavailable (offline or git error)';
}

// ---------------------------------------------------------------------------
// Write outputs

mkdirSync(OUT_DATA, { recursive: true });

const partsHeader = [
  'id', 'title', 'category', 'org_type', 'is_moved', 'redirect_target', 'is_shortcut', 'is_printed', 'printed_base',
  'references_base_subpart', 'bucket_with_supp', 'bucket_shadow_only', 'status_with_supp', 'status_shadow_only',
  'expected_total', 'effective_with_supp', 'effective_shadow_only',
  'expected_cylM', 'expected_cylF', 'expected_clp', 'expected_fgr', 'expected_genM', 'expected_genF',
  'effective_cylM', 'effective_cylF', 'effective_clp', 'effective_fgr', 'effective_genM', 'effective_genF',
  'has_shadow_file', 'own_snaps', 'inherited_snaps', 'all_snaps_inherited', 'connection_primitives', 'missing_feature_types',
  'snap_sources', 'usage_instances', 'usage_models',
];
const partsRows: (string | number)[][] = [partsHeader];
for (const a of analyses) {
  const primitives = Object.entries(a.evidence).sort((x, y) => y[1].count - x[1].count || x[0].localeCompare(y[0]))
    .map(([f, v]) => `${f}:${v.count}`).join('; ');
  const sources = a.sources.slice(0, 8).map((s) => `${s.file}:${s.count}`).join('; ');
  partsRows.push([
    a.meta.id, a.meta.title, a.meta.category, a.meta.orgType, a.meta.isMoved ? 'yes' : 'no', a.meta.movedTo ?? '',
    a.meta.isShortcut ? 'yes' : 'no', a.meta.isPrinted ? 'yes' : 'no', a.meta.printedBase ?? '',
    a.meta.referencesBaseSubpart ? 'yes' : 'no', a.bucketSupp, a.bucketShadow, a.statusSupp, a.statusShadow,
    totalCounts(a.expected), totalCounts(a.effectiveSupp), totalCounts(a.effectiveShadow),
    a.expected.cylM, a.expected.cylF, a.expected.clp, a.expected.fgr, a.expected.genM, a.expected.genF,
    a.effectiveSupp.cylM, a.effectiveSupp.cylF, a.effectiveSupp.clp, a.effectiveSupp.fgr, a.effectiveSupp.genM, a.effectiveSupp.genF,
    a.hasShadowFile ? 'yes' : 'no', a.ownSnapCount, a.inheritedSnapCount, a.allInherited ? 'yes' : 'no',
    primitives, a.evalSupp.missingTypes, sources, a.usageInstances, a.usageModels,
  ]);
}
writeFileSync(join(OUT_DATA, 'parts.csv'), csv(partsRows));

const usageRows: (string | number)[][] = [['part_id', 'title', 'category', 'bucket', 'status', 'instances', 'models']];
const usageSorted = [...usage.entries()].sort((a, b) => b[1].instances - a[1].instances || a[0].localeCompare(b[0]));
for (const [id, u] of usageSorted) {
  const a = analyses.find((x) => x.meta.id.toLowerCase() === id);
  usageRows.push([id, a?.meta.title ?? '', a?.meta.category ?? '', a?.bucketSupp ?? '', a?.statusSupp ?? '', u.instances, u.models.size]);
}
writeFileSync(join(OUT_DATA, 'usage.csv'), csv(usageRows));

const summary = {
  scope: 'Read-only LDCad shadow-library connector coverage gap analysis for the official LDraw library',
  inputs: {
    ldrawParts: N,
    ldrawNewestUpdate: ldrawNewest,
    shadowPackSource: pack.source,
    shadowPackCommit: shadowCommit,
    shadowPackLicense: pack.license,
    shadowFilesInPack: Object.keys(pack.files).length,
    vendorShadowCommit: localShadowCommit,
    upstreamHead: upstreamHead || null,
    upstreamStatus: upstreamNote,
    primitiveFamilies: FAMILIES.map((f) => ({ id: f.id, label: f.label, expected: f.expected, defaultClass: f.defaultClass })),
    unmappedSeedPrimitives: unmappedSeed,
  },
  rules: {
    effectiveSnaps: 'ownSnaps + SNAP_INCL expansion + SNAP_CLEAR, exactly as src/ldraw/flatten.ts',
    expectedSnaps: 'per referenced connector primitive: active shadow snaps; otherwise one inferred snap for a leaf unannotated variant; per class, annotated evidence overrides unannotated evidence',
    tolerance: '25% missing allowed for stud/hole/clip families; 50% for pins, axles, hinges and generic joints; sole-source peghole/axle-hole families use 50%; hinge fingers need at least one finger snap; axle-hole primitives inside an axle body are not expected holes',
    buckets: 'covered; redirect/alias (moved, alias, physical colour, all shortcuts); inheritance gap; geometry-only gap; no connectors expected (stickers/sheets/baseplate special); unknown',
  },
  totals: {
    parts: N,
    bucketsWithSupplementary: bucketsSupp,
    bucketsShadowOnly: bucketsShadow,
    statusWithSupplementary: statusesSupp,
    statusShadowOnly: statusesShadow,
    shortcuts: { parts: shortcutAnalyses.length, statusWithSupplementary: shortcutStatusSupp },
  },
  corpus: {
    files: corpus.files,
    models: corpus.models,
    pieceInstances: corpus.pieces,
    distinctPartsUsed: corpus.distinctParts,
    unresolvedRefs: [...corpus.unresolvedRefs].sort(),
    filesScanned: corpusFiles,
    caveat: 'Small local corpus (downloads, samples and bundled models). The LDraw Official Model Repository (OMR) would make usage ranking representative; it was not downloaded.',
  },
  topGaps: topGaps.map((a) => ({
    id: a.meta.id, title: a.meta.title, category: a.meta.category, bucket: a.bucketSupp, status: a.statusSupp,
    instances: a.usageInstances, models: a.usageModels, missing: a.evalSupp.missingTypes,
    expected: totalCounts(a.expected), effective: totalCounts(a.effectiveSupp),
  })),
  familyGroups: [...familyGroups.entries()].sort((a, b) => b[1].usage - a[1].usage || b[1].parts - a[1].parts || a[0].localeCompare(b[0]))
    .map(([family, v]) => ({ family, parts: v.parts, usageInstances: v.usage, missingOrUnmodelled: Math.round(v.missing) })),
  inheritanceByPrimitive: [...inheritanceByPrimitive.entries()]
    .sort((a, b) => b[1].weighted - a[1].weighted || b[1].parts - a[1].parts || a[0].localeCompare(b[0]))
    .map(([family, v]) => ({ family, label: familyById.get(family)?.label ?? family, parts: v.parts, missing: Math.round(v.missing), usageWeightedMissing: Math.round(v.weighted) })),
  nextTasks: nextTasks.map((t) => ({ kind: t.kind, title: t.title, parts: t.parts, missing: t.missing, usageWeighted: t.weighted, examples: t.examples, upstream: t.upstream })),
  sanityChecks: sanityRows.map((r) => ({
    id: r.id, title: r.a?.meta.title ?? '', category: r.a?.meta.category ?? '', bucket: r.a?.bucketSupp ?? '',
    status: r.status, expected: r.expect, ok: r.found && r.status === r.expect,
    expectedSnaps: r.a ? totalCounts(r.a.expected) : 0, effectiveSnaps: r.a ? totalCounts(r.a.effectiveSupp) : 0,
    missing: r.a?.evalSupp.missingTypes ?? '', note: r.note,
  })),
};
writeFileSync(join(OUT_DATA, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

// ---------------------------------------------------------------------------
// Markdown report

function statusLabel(s: Status): string {
  return s === 'target missing' ? 'target missing' : s;
}

const bucketTableRows = BUCKET_ORDER.map((b) => [b, bucketsSupp[b], pct(bucketsSupp[b], N), bucketsShadow[b], pct(bucketsShadow[b], N)]);
const statusTableRows = STATUS_ORDER.map((s) => [statusLabel(s), statusesSupp[s], pct(statusesSupp[s], N), statusesShadow[s], pct(statusesShadow[s], N)]);
const topGapRows = topGaps.map((a, i) => [
  i + 1, a.meta.id, a.meta.title, a.meta.category || '—', a.bucketSupp, a.usageInstances, a.usageModels,
  a.evalSupp.missingTypes || '—',
]);
const familyRows = [...familyGroups.entries()]
  .sort((a, b) => b[1].usage - a[1].usage || b[1].parts - a[1].parts || a[0].localeCompare(b[0]))
  .map(([g, v]) => [g, v.parts, v.usage, Math.round(v.missing), [...v.examples].sort((a, b) => b.usage - a.usage || a.id.localeCompare(b.id)).slice(0, 4).map((x) => x.id).join(', ')]);
const inheritanceRows = [...inheritanceByPrimitive.entries()]
  .sort((a, b) => b[1].weighted - a[1].weighted || b[1].parts - a[1].parts || a[0].localeCompare(b[0]))
  .map(([fam, v]) => [familyById.get(fam)?.label ?? fam, fam, v.parts, Math.round(v.missing), Math.round(v.weighted), [...v.examples].sort((a, b) => b.usage - a.usage || a.id.localeCompare(b.id)).slice(0, 4).map((x) => x.id).join(', ')]);
const sanityTableRows = sanityRows.map((r) => [
  r.id, r.a?.meta.title ?? '', r.a?.meta.category ?? '—', r.a?.bucketSupp ?? '—', statusLabel(r.status), r.expect,
  r.a ? `${totalCounts(r.a.expected)} / ${totalCounts(r.a.effectiveSupp)}` : '—', r.a?.evalSupp.missingTypes || '—',
  r.found && r.status === r.expect ? 'OK' : 'REVIEW', r.note,
]);
const taskRows = nextTasks.map((t, i) => [i + 1, t.title, t.parts, t.missing, t.weighted, t.examples.join(', '), t.upstream]);
const unmappedNote = unmappedSeed.length ? unmappedSeed.join(', ') : 'none';
const shadowOnlyTyre = analyses.filter((a) => a.rankable && a.statusShadow === 'geometry-only gap' && a.statusSupp === 'covered').map((a) => a.meta.id);
const shortcutBreakdown = STATUS_ORDER.map((s) => `${statusLabel(s)} ${shortcutStatusSupp[s]}`).filter((x) => !x.endsWith(' 0')).join(', ');

const md = `# LDCad shadow-library connector coverage gaps

Read-only diagnostic for **BrickMotion Studio**. It measures the connectors the app actually sees after \`ownSnaps\`, \`SNAP_INCL\` expansion and \`SNAP_CLEAR\`, not merely the number of shadow files. No source file was modified.

## Versions and inputs

| Input | Value |
| --- | --- |
| Official LDraw library | \`public/ldraw\`, ${N.toLocaleString('en-US')} top-level parts, newest \`!LDRAW_ORG ... UPDATE\` stamp **${ldrawNewest || 'unknown'}** |
| LDCad Shadow Library checkout | \`vendor/LDCadShadowLibrary\` at \`${localShadowCommit}\` |
| Packed shadow copy | \`public/data/ldcad-shadow.json\` at \`${shadowCommit}\`, ${Object.keys(pack.files).length.toLocaleString('en-US')} files, ${pack.license} |
| Upstream check | ${upstreamHead ? `\`${upstreamHead}\` — ${upstreamNote}` : upstreamNote} |
| Connector-primitive seed | ${FAMILIES.length} families derived from the ${Object.keys(pack.files).length ? '86' : '86'} SNAP-annotated primitives in \`vendor/LDCadShadowLibrary/p\`; unmapped seed primitives: ${unmappedNote} |
| Local usage corpus | ${corpus.files} model files, ${corpus.models} models, ${corpus.pieces.toLocaleString('en-US')} piece instances, ${corpus.distinctParts.toLocaleString('en-US')} distinct part ids |

The upstream check is read-only (\`git ls-remote\`). A result of “same as checkout” means the local vendor copy is current as of this run; “differs” means upstream has newer or rewritten history.

## Method

### Effective snaps (app pipeline)

For each official top-level part, the script walks the same reference tree as \`src/ldraw/flatten.ts\`:

- every referenced file contributes its own shadow snaps via \`ownSnaps()\` (which also expands \`SNAP_INCL\`);
- an including file's \`SNAP_CLEAR\` drops inherited snaps, either all of them or the named connector ids;
- transforms place each snap in the part's coordinate space;
- provenance is recorded as the source file that defined the snap, so “own” versus “inherited” is observable.

The two tyre/rim pairs are reported both ways: **shadow data alone** (the upstream-relevant number) and **with the app's supplementary connector library** (\`src/data/connectorLibrary.ts\`). Supplementary snaps are tagged and deduplicated by group exactly as \`PartLibrary.loadPart()\` does.

### Expected connectors (independent of shadow data)

The expected side is a data-driven primitive model, not a count of shadow files:

1. The seed families come from the primitives the shadow library annotates in \`vendor/LDCadShadowLibrary/p\` (studs, stud4 anti-studs, pegholes, beam/connector holes, axle holes, axles, pins, clips, hinge fingers, joints, bars). Regex variants catch official family members the seed implies but does not list (for example \`npeghol7\`, \`stud5\`, \`axl5hol9\`, \`clip15\`, \`confricrib1\`).
2. For every instance of an annotated primitive in the part's reference tree, its **own active snap counts** are added to the expected class totals. This is what the app would inherit if no \`SNAP_CLEAR\` removed anything.
3. An unannotated connector variant contributes **one inferred snap** only when it is a leaf in the primitive tree (so \`npeghol2\` -> two \`npeghol7\` leaves, not three snaps) and only for a class with no annotated evidence. \`stug-*\` stud groups are excluded because their \`stud.dat\` children are counted directly. \`stud4\` anti-studs are evidence-only because they are structural underside tubes; the parent shadow normally represents the seating positions as F snaps.
4. Per class, annotated evidence overrides unannotated evidence. This prevents a \`beamhole\` annotation plus its internal \`npeghol\` geometry from being double-counted.
5. A part with axle-end primitives (or flexible-axle \`s/faxle*\` segments) is an axle body: its \`axlehol*\` primitives draw the axle's own cross shape, so they add no expected holes.
6. Hinge primitives repeat once per tooth, but LDCad models a whole finger set as one \`SNAP_FGR\` with a \`seq\` of widths, so a hinge part needs at least one finger snap, not one per tooth.

Missing counts are compared per snap class (\`cyl M\`, \`cyl F\`, \`clip\`, \`hinge finger\`, \`generic M/F\`) with documented tolerance:

- 25% missing allowed for stud/hole/clip families;
- 50% for pins, axles, hinges and generic joints, where one long snap can consolidate several primitive segments;
- 50% when the only expected source is a peghole/axle-hole family (a long slide snap can cover several segments).

A part is an **inheritance gap** when an expected class falls below that tolerance. This catches both unannotated primitives and over-aggressive \`SNAP_CLEAR\`.

### Bucket rules (exactly one bucket per part)

| Bucket | Rule |
| --- | --- |
| **covered** | Expected connectors are present within tolerance, or the part has effective snaps but no primitive-derived expectation. |
| **redirect/alias** | \`~Moved to\`, \`Part Alias\`, \`Part Physical_Colour\`, or any \`Shortcut\`. For redirects the status is the target's status; for shortcuts the status is computed from the component-derived snaps. Report the target status. |
| **inheritance gap** | Has connector-primitive evidence but a snap class is below tolerance (unannotated primitive or over-clearing \`SNAP_CLEAR\`). |
| **geometry-only gap** | No or too little primitive evidence to derive an expectation, but the category/title says the part connects (Technic, wheel, tyre, hinge, clip, bar, minifig, hose, etc.) and effective snaps are absent. These need hand modelling/review. |
| **no connectors expected** | Sticker or sticker-sheet titles/categories, sheet fabric/plastic/cardboard, and the baseplate special case **only when there are no effective snaps**. Sticker shortcuts that include a base part keep that part's connectors, and printed variants of ordinary parts are **not** automatically excluded. |
| **unknown** | Neither connector evidence nor a decorative/connector hint. Listed rather than guessed. |

### Usage ranking

Every \`*.mpd\`/\`*.ldr\` file under \`~/Downloads\`, \`samples/\`, \`public/ldraw/models/\` and \`public/data/\` was parsed (${corpus.files} files). MPD submodels are resolved recursively; embedded copies whose names follow \`<title> - <partId>\` are mapped to the library id (for example \`31039 - 13971\` -> \`13971\`) and not recursed into as submodels. Duplicate/derived 31039 instruction files and two copies of 10156 are counted as separate models, so the ranking is a usage signal, not a market survey.

**The corpus is small.** It contains ${corpus.models} models and ${corpus.pieces.toLocaleString('en-US')} piece instances, mostly one jet family plus demos. The **LDraw Official Model Repository (OMR)** is the right larger corpus for a representative ranking; it was not downloaded for this analysis. Recounting against OMR is the single highest-value follow-up for prioritisation.

## Totals

### Buckets (all ${N.toLocaleString('en-US')} parts)

| Bucket | With supplementary | % | Shadow data only | % |
| --- | ---: | ---: | ---: | ---: |
${bucketTableRows.map((r) => `| ${r[0]} | ${Number(r[1]).toLocaleString('en-US')} | ${r[2]} | ${Number(r[3]).toLocaleString('en-US')} | ${r[4]} |`).join('\n')}

### Coverage status (same parts, status is finer-grained for redirects/shortcuts)

| Status | With supplementary | % | Shadow data only | % |
| --- | ---: | ---: | ---: | ---: |
${statusTableRows.map((r) => `| ${r[0]} | ${Number(r[1]).toLocaleString('en-US')} | ${r[2]} | ${Number(r[3]).toLocaleString('en-US')} | ${r[4]} |`).join('\n')}

Shortcuts (${shortcutAnalyses.length.toLocaleString('en-US')} parts) break down as: ${shortcutBreakdown || 'none'}. Redirects are not themselves ranked as gaps; they inherit the target's status. Supplementary data changes the status of ${shadowOnlyTyre.length} part(s): ${shadowOnlyTyre.join(', ') || 'none'}.

## Top 50 gaps by usage

Only rankable gaps are shown (moved/alias redirects excluded). “Missing” lists the deficient snap classes as effective/expected. Usage is instances in the local corpus; models is the number of distinct models containing the part.

${topGapRows.length ? mdTable(['#', 'Part', 'Title', 'Category', 'Bucket', 'Uses', 'Models', 'Missing feature types'], topGapRows) : '_No rankable gaps found._'}

## Gaps grouped by family

Family is the part's \`!CATEGORY\`, or a title-derived family when the category is missing or \`Obsolete\`. “Missing/unmodelled” counts missing snaps for inheritance gaps and one placeholder per geometry-only part.

${mdTable(['Family', 'Gap parts', 'Uses', 'Missing/unmodelled', 'Example parts'], familyRows)}

## Inheritance gaps by primitive responsible

A part can appear under more than one primitive when several classes are deficient. “Usage-weighted missing” is missing snaps multiplied by local usage (at least 1), a rough priority signal.

${inheritanceRows.length ? mdTable(['Primitive family', 'Id', 'Parts', 'Missing snaps', 'Usage-weighted missing', 'Example parts'], inheritanceRows) : '_No inheritance gaps found._'}

## Sanity checks (hand-reviewed)

These parts span the buckets and the requested spot-check list (brick, plate, pin, beam, rim, tyres, shortcut, moved part, printed torso, hose, sticker, baseplate, tile). “Expected / effective” is total snaps; the verdict compares the rule's status with the hand expectation.

${mdTable(['Part', 'Title', 'Category', 'Bucket', 'Status', 'Hand expectation', 'Expected / effective', 'Missing', 'Verdict', 'Note'], sanityTableRows)}

## Next 10 data-fill tasks

Ranked by usage-weighted expected gain. Primitive-family tasks benefit every part that references that primitive; geometry tasks group parts that need hand modelling. “Upstream” says whether the work belongs in the LDCad Shadow Library (CC BY-SA 4.0) or is app-specific.

${mdTable(['#', 'Task', 'Parts', 'Missing/assumed', 'Usage-weighted', 'Examples', 'Upstream suitability'], taskRows)}

## Uncertainties and limitations

- The local corpus is small and skewed to 31039 variants. Treat the ordering as a directional signal only until re-run against OMR.
- Expected counts are a model of the shadow library's own primitive annotations, not ground truth for every physical joint. Tolerance values are documented and deliberately conservative; parts near a threshold are marked “REVIEW” in the sanity table if hand inspection disagrees.
- \`SNAP_CLEAR\` can be intentional consolidation (for example \`3673\` and \`6558\`). The 50% pin tolerance accepts those; a part with a genuinely missing pin class can still fall below it.
- The connection-primitive seed covers the currently annotated upstream primitives plus obvious official variants. A primitive that is both unannotated and absent from the seed will show as geometry-only or unknown rather than inheritance gap.
- Embedded part copies are mapped by name pattern only when the extracted id is an official top-level part; geometry equality is not re-verified here (the app does that separately).
- Upstream check: ${upstreamHead ? `\`${upstreamHead}\` (${upstreamNote})` : upstreamNote}. Re-run the script to refresh.

## Outputs

- \`docs/diagnostics/shadow-gaps/parts.csv\` — one row per official top-level part with metadata, buckets, expected/effective class counts, primitive evidence, provenance and usage.
- \`docs/diagnostics/shadow-gaps/usage.csv\` — canonical part id, usage instances/models and classification.
- \`docs/diagnostics/shadow-gaps/summary.json\` — machine-readable versions, totals, top gaps, family/primitive groups, tasks and sanity checks.
`;

writeFileSync(REPORT, md);

// ---------------------------------------------------------------------------
// Console summary

const elapsed = (performance.now() - T0) / 1000;
console.log(`parts: ${N}`);
console.log(`buckets (with supplementary): ${BUCKET_ORDER.map((b) => `${b}=${bucketsSupp[b]}`).join(', ')}`);
console.log(`buckets (shadow only): ${BUCKET_ORDER.map((b) => `${b}=${bucketsShadow[b]}`).join(', ')}`);
console.log(`inheritance gaps: ${inheritanceParts.length}; geometry-only gaps: ${analyses.filter((a) => a.rankable && a.statusSupp === 'geometry-only gap').length}; rankable gaps: ${gapParts.length}`);
console.log(`usage: ${corpus.files} files, ${corpus.models} models, ${corpus.pieces} pieces, ${corpus.distinctParts} distinct parts`);
console.log(`upstream: ${upstreamHead || 'unavailable'} (${upstreamNote})`);
if (unmappedSeed.length) console.warn(`unmapped seed primitives: ${unmappedSeed.join(', ')}`);
for (const r of sanityRows) if (!r.found || r.status !== r.expect) console.warn(`sanity REVIEW ${r.id}: got ${r.found ? r.status : 'not found'}, expected ${r.expect}`);
console.log(`wrote ${REPORT}`);
console.log(`wrote ${OUT_DATA}/parts.csv, usage.csv, summary.json`);
console.log(`runtime: ${elapsed.toFixed(2)}s`);
