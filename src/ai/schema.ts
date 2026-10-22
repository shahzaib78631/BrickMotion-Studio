import { z } from 'zod';
import { ensureIds } from '../plan/ids';
import type { Plan, PlanItem } from '../plan/types';

const Rot = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
const GridPos = { x: z.number().int(), y: z.number().int(), z: z.number().int(), rot: Rot };
const AiPiece = z.object({ part: z.string(), color: z.union([z.string(), z.number()]), ...GridPos }).strict();
const AiSub = z.object({ submodel: z.string(), ...GridPos }).strict();
const AiStep = z.object({ pieces: z.array(z.union([AiPiece, AiSub])) });

/** What Claude returns: like a Plan, but submodels as an array and grid-only items without ids. */
export const AiPlanSchema = z.object({
  name: z.string(),
  description: z.string(),
  steps: z.array(AiStep),
  submodels: z.array(z.object({ name: z.string(), steps: z.array(AiStep) })),
});
export type AiPlan = z.infer<typeof AiPlanSchema>;

export function aiPlanToPlan(ai: AiPlan): Plan {
  const steps = (s: AiPlan['steps']) => s.map((st) => ({ pieces: st.pieces.map((p) => ({ ...p }) as PlanItem) }));
  const plan: Plan = { format: 'brickmotion-plan', version: 1, name: ai.name || 'AI set', steps: steps(ai.steps) };
  if (ai.description) plan.description = ai.description;
  if (ai.submodels.length) plan.submodels = Object.fromEntries(ai.submodels.map((m) => [m.name, { steps: steps(m.steps) }]));
  return ensureIds(plan);
}
