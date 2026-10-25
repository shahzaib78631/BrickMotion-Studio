/**
 * Reproduce Construction V2 failures against a real MPD and a local LDraw tree.
 * No browser, rendering, or global LDraw installation required.
 *
 * npx tsx scripts/diagnose-construction-mpd.ts path/to/model.mpd path/to/ldraw [truck|trailer|helicopter|full] [report.json] [--budget=standard|extended|diagnostic] [--engine=v2|v3]
 * For the minimal LEGO 5590 package, extract 5590-minimal-ldraw.zip so the
 * second argument points to the folder containing parts/, p/ and LDConfig.ldr.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { importLDraw } from '../src/io/ldrawImport';
import { parseLDraw, type LDrawFile } from '../src/ldraw/parse';
import { flattenPart } from '../src/ldraw/flatten';
import { measurePart } from '../src/ldraw/metrics';
import { shadowLookupFrom } from '../src/ldraw/shadow';
import { modelFromPlan, planConstruction } from '../src/anim/construction';
import type { Plan, Step } from '../src/plan/types';
import { CONSTRUCTION_BUDGET_PRESETS, isConstructionBudgetPreset } from '../src/anim/construction/budgetPresets';
import { buildMechanicalConstraintGraph, explainMissingMechanicalMate } from '../src/anim/construction/mechanicalConstraintGraph';
import { possibleFinalContacts } from '../src/anim/construction/contactBroadphase';

const args = process.argv.slice(2);
const inspectInterfaces = args.includes('--inspect-interfaces');
const auditOnly = args.includes('--audit-only');
const noConfigDetours = args.includes('--no-config-detours');
const useStepModules = args.includes('--step-modules') && !args.includes('--no-step-modules');
const noReviewedSurfaces = args.includes('--no-reviewed-surfaces');
const focusFlag = args.find(value => value.startsWith('--focus-parts='));
const focusParts = focusFlag?.slice('--focus-parts='.length).toLowerCase().split(',').filter(Boolean);
const engineFlag = args.find(value => value.startsWith('--engine='));
const engine = engineFlag?.split('=')[1] ?? 'v2';
if (engine !== 'v2' && engine !== 'v3') throw new Error('Specify --engine=v2 or --engine=v3');
const budgetFlags = args.filter(value => value.startsWith('--budget='));
if (budgetFlags.length > 1) throw new Error('Specify --budget only once.');
const requestedBudget = budgetFlags[0]?.slice('--budget='.length) ?? 'standard';
if (!isConstructionBudgetPreset(requestedBudget)) throw new Error('Unknown budget preset. Use --budget=standard, --budget=extended or --budget=diagnostic.');
const limits = CONSTRUCTION_BUDGET_PRESETS[requestedBudget];
const [mpdArg, libraryArg, modelScope = 'full', reportArg] = args.filter(value => !value.startsWith('--budget=') && !value.startsWith('--engine=') && value !== '--inspect-interfaces' && value !== '--audit-only' && value !== '--no-config-detours' && value !== '--no-step-modules' && value !== '--step-modules' && value !== '--no-reviewed-surfaces' && !value.startsWith('--focus-parts='));
if (!mpdArg || !libraryArg) {
  console.error('Usage: npx tsx scripts/diagnose-construction-mpd.ts <model.mpd> <ldraw-dir> [scope|full] [report.json] [--budget=standard|extended|diagnostic] [--engine=v2|v3] [--audit-only] [--no-reviewed-surfaces] [--inspect-interfaces] [--focus-parts=4073,4349]');
  process.exit(1);
}
const library = resolve(libraryArg);
if (!existsSync(join(library, 'parts')) || !existsSync(join(library, 'p'))) {
  console.error(`Missing LDraw library under ${library}. Expected parts/ and p/.`);
  process.exit(1);
}
const source = readFileSync(resolve(mpdArg), 'utf8');
let plan: Plan = importLDraw(source, mpdArg);
if (modelScope !== 'full') {
  const key = Object.keys(plan.submodels ?? {}).find(name => name.toLowerCase() === modelScope.toLowerCase());
  if (!key) throw new Error(`Unknown submodel ${modelScope}. Found: ${Object.keys(plan.submodels ?? {}).join(', ')}`);
  plan = { ...plan, steps: plan.submodels![key].steps };
}
const files = new Map<string, LDrawFile>();
const loadFiles = (folder: string) => {
  for (const entry of readdirSync(folder)) {
    const file = join(folder, entry);
    if (statSync(file).isDirectory()) loadFiles(file);
    else if (entry.toLowerCase().endsWith('.dat')) {
      const key = relative(library, file).replace(/\\/g, '/').toLowerCase();
      files.set(key, parseLDraw(readFileSync(file, 'utf8'), key));
    }
  }
};
loadFiles(library);
const lookup = (ref: string) => {
  const id = ref.replace(/\\/g, '/').toLowerCase();
  return files.get(`parts/${id}`) ?? files.get(`p/${id}`) ?? files.get(id) ?? null;
};
const missing = new Set<string>();
const shadowFiles: Record<string,string> = {};
const shadowRoot = resolve('vendor/LDCadShadowLibrary');
if (!existsSync(shadowRoot)) {
  console.error(`LDCad shadow library not found at ${shadowRoot}. Run this script from the BrickMotion-Studio project root to avoid misleading missing-connector diagnoses.`);
  process.exit(2);
}
for (const root of ['p', 'parts']) {
  const base = join(shadowRoot, root);
  if (!existsSync(base)) continue;
  const scan = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const file = join(dir, entry);
      if (statSync(file).isDirectory()) scan(file);
      else if (entry.toLowerCase().endsWith('.dat')) {
        const meta = readFileSync(file, 'utf8').split(/\r?\n/).filter(line => /^\s*0\s+!LDCAD\s+SNAP_/i.test(line));
        if (meta.length) shadowFiles[relative(base, file).replace(/\\/g, '/').toLowerCase()] = meta.join('\n');
      }
    }
  };
  scan(base);
}
const shadow = Object.keys(shadowFiles).length ? shadowLookupFrom(shadowFiles) : undefined;
const refs = new Set<string>();
const enumerate = (steps: Step[], stack: string[] = []) => {
  for (const step of steps) for (const item of step.pieces) {
    if ('part' in item) refs.add(item.part);
    else if (!stack.includes(item.submodel)) enumerate(plan.submodels?.[item.submodel]?.steps ?? [], [...stack,item.submodel]);
  }
};
enumerate(plan.steps);
const metrics = new Map([...refs].map(id => {
  const root = lookup(`${id}.dat`);
  const flattened = root ? flattenPart(id, root, lookup, n => missing.add(n), shadow) : null;
  return [id, measurePart(flattened, id)] as const;
}));
const placeholder = [...metrics.values()].filter(m => m.placeholder || !m.mesh?.length).map(m=>m.id);
if (placeholder.length || missing.size) {
  console.error('Missing part definitions:',placeholder);
  console.error('Missing referenced primitives:',[...missing]);
  process.exit(2);
}
const model = modelFromPlan(plan, id => {
  const item = metrics.get(id);
  if (!item) throw new Error(`Unmeasured part ${id}`);
  return item;
});
console.log(`Loaded ${model.parts.size} piece instances and ${refs.size} unique parts; ${files.size} LDraw DAT files; ${Object.keys(shadowFiles).length} shadow definitions.`);
console.log(`Engine: ${engine}; config detours: ${!noConfigDetours}; step modules: ${useStepModules}; budget: ${requestedBudget} — ${limits.maxMilliseconds/1000}s, ${limits.maxStates} states, ${limits.maxCandidates} candidates.`);
const start = performance.now();
if (inspectInterfaces) {
  const graph = buildMechanicalConstraintGraph(model);
  const types: Record<string,number> = {};
  for (const joint of graph.joints) types[joint.type] = (types[joint.type] ?? 0) + 1;
  const focus = focusParts?.length ? new Set(focusParts) : null;
  const joined = new Map<string, typeof graph.joints>();
  const joinKey = (a:string,b:string) => a < b ? `${a.length}:${a}${b.length}:${b}` : `${b.length}:${b}${a.length}:${a}`;
  for (const joint of graph.joints) { const k=joinKey(joint.male,joint.female); const list=joined.get(k)??[]; list.push(joint); joined.set(k,list); }
  const selectedPairs = [...possibleFinalContacts([...model.parts.values()])]
    .filter(([a,b]) => !!a.part && !!b.part && (!focus || (focus.has(a.part.toLowerCase()) && focus.has(b.part.toLowerCase()))))
    .map(([a,b]) => {
      const mates = joined.get(joinKey(a.id,b.id)) ?? [];
      return { a: { id: a.id, part: a.part }, b: { id: b.id, part: b.part },
        joints: mates.map(({type,axis,engagement,motion,region})=>({type,axis,engagement,motion,region})),
        explanation: explainMissingMechanicalMate(a,b,graph) };
    });
  const report = { inspection:'ldcad-mechanical-interfaces/v1', scope:modelScope,
    pieces:model.parts.size, closePairs:graph.pairsExamined, typedJoints:graph.joints.length, jointTypes:types, selectedPairs,
    note:'Joint classification is metadata-based. No static contact or swept-motion collision has been certified by this inspection.' };
  console.log(`Inferred ${graph.joints.length} joint(s) from ${graph.pairsExamined} close candidate pairs.`);
  console.log(`Selected ${selectedPairs.length} nearby pairs for inspection.`);
  if (reportArg) writeFileSync(resolve(reportArg),JSON.stringify(report,null,2)+'\n');
  else console.log(JSON.stringify(report,null,2));
  process.exit(0);
}
let last = start;
let contactAudit: { reviewedSurfaceContacts: number; contactAuditMilliseconds: number } | undefined;
let report: Record<string, unknown>;
try {
  const result = planConstruction(model, {
    ...limits, algorithm: engine === 'v3' ? 'guided-v3' : 'exhaustive-v2', supportMode: 'fixture',
    disableBundledSurfaceReviews: noReviewedSurfaces, enableConfigurationDetours: !noConfigDetours, enableStepModules: useStepModules,
    onContactAuditComplete: result => { contactAudit = result; },
    cancelled: () => auditOnly && contactAudit !== undefined,
    onProgress: p => {
      const t = performance.now();
      if (t-last>2000) { console.log(`  ${p.phase} ${p.completed}/${p.total} ${p.item??''}`); last=t; }
    },
  });
  report = { success: true, engine, enableConfigurationDetours: !noConfigDetours, enableStepModules: useStepModules, budget: requestedBudget, limits, scope: modelScope, pieces: model.parts.size, operations: result.operations.length, contactAudit, stats: result.stats, warnings: result.warnings };
  console.log(`Planned ${result.operations.length} operations.`);
} catch (error) {
  const e = error as Error & { code?: string; details?: {blockages?: {moving:string;obstacle:string;stage:string;detail:string}[];stats?:unknown} };
  if (auditOnly && e.code === 'cancelled' && contactAudit) {
    report = { success:true, contactAuditOnly:true, fullPlanCertified:false, engine,
      budget:requestedBudget, scope:modelScope, pieces:model.parts.size,
      contactAudit, stats:e.details?.stats,
      note:'Final-pose audit passed. Route search and animation replay were deliberately not run.' };
  } else {
  const blockages = e.details?.blockages?.map(c => ({ ...c, parts: [model.parts.get(c.moving)?.part, model.parts.get(c.obstacle)?.part] }));
  report = { success:false, engine, enableConfigurationDetours: !noConfigDetours, enableStepModules: useStepModules, budget: requestedBudget, limits, scope:modelScope, pieces:model.parts.size, code:e.code??e.name, message:e.message, stats:e.details?.stats, blockages };
  console.error(e.code ?? e.name, e.message);
  for (const b of blockages ?? []) console.error(`  ${b.parts.join(' / ')} | ${b.moving} / ${b.obstacle} | ${b.stage}`);
  process.exitCode = 2;
  }
}
report.elapsedMs = Math.round(performance.now()-start);
if (reportArg) {
  writeFileSync(resolve(reportArg),JSON.stringify(report,null,2)+'\n');
  console.log(`Saved report: ${resolve(reportArg)}`);
}
