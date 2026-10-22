import { z } from 'zod';
import type { Plan } from './types';

const num = z.number().finite();
const GridShape = {
  x: num.int(),
  y: num.int(),
  z: num.int(),
  rot: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
};
const RawShape = {
  ldu: z.tuple([num, num, num]),
  matrix: z.tuple([num, num, num, num, num, num, num, num, num]),
};
const id = z.string().optional();
const color = z.union([z.string().min(1), num]);

const Item = z
  .custom<unknown>((v) => !(v && typeof v === 'object' && 'part' in v && 'submodel' in v), {
    message: 'an item cannot have both "part" and "submodel"',
  })
  .pipe(
    z.union([
      z.object({ id, part: z.string().min(1), color, ...GridShape }),
      z.object({ id, part: z.string().min(1), color, ...RawShape }),
      z.object({ id, submodel: z.string().min(1), ...GridShape }),
      z.object({ id, submodel: z.string().min(1), ...RawShape }),
    ]),
  );

const StepSchema = z.object({ pieces: z.array(Item) });

export const PlanSchema = z.object({
  format: z.literal('brickmotion-plan'),
  version: z.literal(1),
  name: z.string(),
  description: z.string().optional(),
  submodels: z.record(z.string(), z.object({ steps: z.array(StepSchema) })).optional(),
  parts: z.record(z.string(), z.string()).optional(),
  steps: z.array(StepSchema),
});

export function parsePlan(json: unknown): { ok: true; plan: Plan } | { ok: false; errors: string[] } {
  const r = PlanSchema.safeParse(json);
  if (r.success) return { ok: true, plan: r.data as Plan };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
