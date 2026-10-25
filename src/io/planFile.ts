import { parsePlan } from '../plan/schema';
import type { Plan } from '../plan/types';
import { isAssemblyArtifact, parseAssemblyArtifact } from '../anim/assemblyPlan/artifact';
import { importLDraw } from './ldrawImport';

export function planToJson(plan: Plan): string {
  return JSON.stringify(plan, null, 2);
}

export function readPlanFile(text: string, fileName: string): { ok: true; plan: Plan } | { ok: false; errors: string[] } {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'json') {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`] };
    }
    if (isAssemblyArtifact(json)) {
      // An artifact may carry the model plan it was planned for (`--app-plan`);
      // then one file opens the whole thing. Without it, artifacts attach to
      // the already open plan (see attachAssemblyArtifact below).
      const wrapped = (json as { appPlan?: unknown })?.appPlan;
      if (!wrapped || typeof wrapped !== 'object') return { ok: false, errors: ['This is an assembly plan artifact. Import the matching model first, then import this artifact to attach it — or plan it with `--app-plan` so the artifact carries the model inside.'] };
      const parsed = parsePlan(wrapped);
      if (!parsed.ok) return { ok: false, errors: [`The attached model plan is damaged: ${parsed.errors[0]}`] };
      return { ok: true, plan: { ...parsed.plan, assemblyPlan: json } };
    }
    return parsePlan(json);
  }
  if (ext === 'ldr' || ext === 'mpd') {
    const plan = importLDraw(text, fileName);
    const count = plan.steps.reduce((n, s) => n + s.pieces.length, 0);
    if (count === 0 && !plan.submodels) return { ok: false, errors: ['The file has no pieces'] };
    return { ok: true, plan };
  }
  if (ext === 'dat') {
    if (isPartFile(text)) return { ok: true, plan: singlePartPlan(text, fileName) };
    return readPlanFile(text, fileName.replace(/\.dat$/i, '.ldr'));
  }
  return { ok: false, errors: [`Unsupported file type ".${ext}" — use .brickmotion, .json, .ldr, .mpd or .dat`] };
}

/**
 * Attaches an assembly artifact to the plan that is already open. Importing the
 * model first, then the artifact, keeps the artifact's identity (the exact world
 * placements it was certified against) while the user keeps editing timelines.
 */
export function attachAssemblyArtifact(plan: Plan, json: unknown): { ok: true; plan: Plan } | { ok: false; errors: string[] } {
  const parsed = parseAssemblyArtifact(json);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  return { ok: true, plan: { ...plan, assemblyPlan: json } };
}

/**
 * True when an LDraw .dat is a part (its own geometry) rather than a model built
 * from parts. The !LDRAW_ORG header decides when present; otherwise any drawn
 * line, triangle or quad makes it a part.
 */
export function isPartFile(text: string): boolean {
  const org = /^\s*0\s+!LDRAW_ORG\s+(?:Unofficial_)?(\w+)/im.exec(text);
  if (org) return !/^model$/i.test(org[1]);
  return /^\s*[2-5]\s/m.test(text);
}

/** A set with one piece: the part in the file, kept inside the set so it draws without the library. */
function singlePartPlan(text: string, fileName: string): Plan {
  const base = (fileName.split(/[\\/]/).pop() ?? fileName).replace(/\.dat$/i, '').trim().toLowerCase() || 'part';
  const title = /^\s*0\s+(?!!|FILE\b|Name:|Author:|BFC\b)(.+?)\s*$/im.exec(text)?.[1]?.replace(/\s+/g, ' ');
  return {
    format: 'brickmotion-plan',
    version: 1,
    name: title || base,
    steps: [{ title: title || base, pieces: [{ part: base, color: 71, ldu: [0, 0, 0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] }] }],
    parts: { [`${base}.dat`]: text },
  };
}
