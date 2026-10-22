import { parseMpd, type LDrawFile } from '../ldraw/parse';
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

/** Converts an LDraw .ldr/.mpd model into a plan. Every piece keeps its exact placement. */
export function importLDraw(text: string, fileName: string): Plan {
  const { main, files, raw } = parseMpd(text);
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
