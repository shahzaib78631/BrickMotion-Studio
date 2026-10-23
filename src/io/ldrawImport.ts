import { parseMpd, type LDrawCmd, type LDrawFile } from '../ldraw/parse';
import type { Plan, PlanItem, Step } from '../plan/types';

const stripExt = (n: string) => n.replace(/\.(ldr|dat|mpd)$/i, '');

function toSteps(file: LDrawFile, submodelNames: Set<string>): Step[] {
  const steps: Step[] = [];
  let current: PlanItem[] = [];
  const flush = () => {
    if (current.length) steps.push({ pieces: current });
    current = [];
  };
  for (const c of file.cmds) {
    if (c.t === 'step') flush();
    else if (c.t === 'ref') {
      if (submodelNames.has(c.file)) current.push({ submodel: stripExt(c.file), ldu: c.pos, matrix: c.m });
      else current.push({ part: stripExt(c.file), color: c.color, ldu: c.pos, matrix: c.m });
    }
  }
  flush();
  return steps;
}

/**
 * Pieces an editor grouped (MLCAD BTG, LeoCAD GROUP) become submodels, each placed
 * where it was: a police station, a car and four minifigs in one flat .ldr become
 * one build each. Nothing happens unless there are at least two parts to split.
 */
function splitGroups(file: LDrawFile, taken: Set<string>): { main: LDrawFile; groups: [string, LDrawFile][] } | null {
  const refs = file.cmds.filter((c) => c.t === 'ref');
  const named = [...new Set(refs.map((c) => c.group).filter((g): g is string => !!g))];
  const loose = refs.some((c) => !c.group);
  if (!named.length || (named.length < 2 && !loose)) return null;
  const used = new Set(taken);
  const nameOf = new Map<string, string>();
  for (const g of named) {
    const base = g.toLowerCase().replace(/[\\/]/g, '-').replace(/\.(ldr|dat|mpd)$/i, '');
    let n = base, k = 2;
    while (used.has(n + '.ldr')) n = `${base} ${k++}`;
    used.add(n + '.ldr');
    nameOf.set(g, n + '.ldr');
  }
  const out = new Map(named.map((g) => [g, { name: nameOf.get(g)!, description: g, cmds: [] as LDrawCmd[] } as LDrawFile]));
  const main: LDrawFile = { ...file, cmds: [] };
  for (const c of file.cmds) {
    if (c.t === 'step') { main.cmds.push(c); for (const f of out.values()) f.cmds.push(c); }
    else if (c.t === 'ref' && c.group) out.get(c.group)!.cmds.push(c);
    else main.cmds.push(c);
  }
  // each group goes on in its own step, in the order the file first names it
  for (const g of named) main.cmds.push({ t: 'step' }, { t: 'ref', color: 16, pos: [0, 0, 0], m: [1, 0, 0, 0, 1, 0, 0, 0, 1], file: nameOf.get(g)!, invert: false });
  return { main, groups: named.map((g) => [nameOf.get(g)!, out.get(g)!]) };
}

/** Converts an LDraw .ldr/.mpd model into a plan. Every piece keeps its exact placement. */
export function importLDraw(text: string, fileName: string): Plan {
  const { main, files, raw } = parseMpd(text);
  const split = splitGroups(files.get(main)!, new Set(files.keys()));
  if (split) {
    files.set(main, split.main);
    for (const [k, f] of split.groups) files.set(k, f);
  }
  const isDat = (n: string) => n.endsWith('.dat');
  const names = new Set([...files.keys()].filter((n) => !isDat(n)));
  const plan: Plan = {
    format: 'brickmotion-plan',
    version: 1,
    name: stripExt(fileName.split(/[\\/]/).pop() ?? fileName),
    steps: toSteps(files.get(main)!, names),
  };
  const subs = [...files.entries()].filter(([k]) => k !== main && !isDat(k));
  const dats = [...raw.entries()].filter(([k]) => isDat(k));
  if (dats.length) plan.parts = Object.fromEntries(dats);
  if (subs.length) plan.submodels = Object.fromEntries(subs.map(([k, f]) => [stripExt(k), { steps: toSteps(f, names) }]));
  return plan;
}
