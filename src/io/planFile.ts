import { parsePlan } from '../plan/schema';
import type { Plan } from '../plan/types';
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
    return parsePlan(json);
  }
  if (ext === 'ldr' || ext === 'mpd') {
    const plan = importLDraw(text, fileName);
    const count = plan.steps.reduce((n, s) => n + s.pieces.length, 0);
    if (count === 0 && !plan.submodels) return { ok: false, errors: ['The file has no pieces'] };
    return { ok: true, plan };
  }
  return { ok: false, errors: [`Unsupported file type ".${ext}" — use .json, .ldr or .mpd`] };
}
