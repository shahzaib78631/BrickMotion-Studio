import { parsePlan } from '../plan/schema';
import type { Plan } from '../plan/types';
import { aiPlanToPlan, AiPlanSchema } from './schema';

/** Pulls the JSON object out of a chat reply (code fence or surrounding prose). */
function extractJson(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  return a >= 0 && b > a ? body.slice(a, b + 1) : null;
}

export function parsePastedPlan(text: string): { ok: true; plan: Plan } | { ok: false; error: string } {
  const json = extractJson(text);
  if (!json) return { ok: false, error: 'No JSON plan found in the pasted text.' };
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `The JSON could not be read: ${(e as Error).message}` };
  }
  if (obj && typeof obj === 'object' && (obj as { format?: unknown }).format === 'brickmotion-plan') {
    const r = parsePlan(obj);
    return r.ok ? r : { ok: false, error: r.errors.slice(0, 5).join('\n') };
  }
  const withDefaults = { name: 'Pasted set', description: '', submodels: [], ...(obj as object) };
  const ai = AiPlanSchema.safeParse(withDefaults);
  if (!ai.success) return { ok: false, error: ai.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`).join('\n') };
  const r = parsePlan(aiPlanToPlan(ai.data));
  return r.ok ? r : { ok: false, error: r.errors.slice(0, 5).join('\n') };
}
