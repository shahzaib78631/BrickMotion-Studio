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

const AssemblySpotSchema = z.object({
  x: num,
  z: num,
  angle: num,
});

const AssemblySchema = z.object({
  attachTo: z.string().min(1).optional(),
  after: z.array(z.string().min(1)).optional(),
  insertionAxis: z.tuple([num, num, num]).refine((v) => Math.hypot(...v) > 1e-8, 'insertionAxis must be non-zero').optional(),
  role: z.enum(['base', 'hips', 'leg', 'torso', 'arm', 'hand', 'head', 'headwear', 'generic']).optional(),
  root: z.boolean().optional(),
  floorShift: z.tuple([num, num]).optional(),
  buildSpot: AssemblySpotSchema.optional(),
}).optional();

const Item = z
  .custom<unknown>((v) => !(v && typeof v === 'object' && 'part' in v && 'submodel' in v), {
    message: 'an item cannot have both "part" and "submodel"',
  })
  .pipe(
    z.union([
      z.object({ id, assembly: AssemblySchema, part: z.string().min(1), color, ...GridShape }),
      z.object({ id, assembly: AssemblySchema, part: z.string().min(1), color, ...RawShape }),
      z.object({ id, assembly: AssemblySchema, submodel: z.string().min(1), ...GridShape }),
      z.object({ id, assembly: AssemblySchema, submodel: z.string().min(1), ...RawShape }),
    ]),
  );

const StepSchema = z.object({
  pieces: z.array(Item),
  title: z.string().max(80).optional(),
  notes: z.string().max(1000).optional(),
  pauseAfter: num.min(0).max(10).optional(),
  auto: z.boolean().optional(),
});

export const PlanSchema = z.object({
  format: z.literal('brickmotion-plan'),
  version: z.literal(1),
  name: z.string(),
  description: z.string().optional(),
  submodels: z.record(z.string(), z.object({ steps: z.array(StepSchema) })).optional(),
  parts: z.record(z.string(), z.string()).optional(),
  steps: z.array(StepSchema),
  assemblySpot: AssemblySpotSchema.optional(),
  loosePiecesFollow: z.boolean().optional(),
});

export function parsePlan(json: unknown): { ok: true; plan: Plan } | { ok: false; errors: string[] } {
  const r = PlanSchema.safeParse(json);
  if (r.success) return { ok: true, plan: r.data as Plan };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
