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
  group: z.string().min(1).max(80).optional(),
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

const KeyInterpolationSchema = z.enum(['bezier', 'linear', 'constant']);
const AnimationKeySchema = z.object({
  frame: num.int().min(0).max(20000),
  value: num,
  interpolation: KeyInterpolationSchema,
});
const AnimationChannels = ['location.x', 'location.y', 'location.z', 'rotation.x', 'rotation.y', 'rotation.z', 'scale.x', 'scale.y', 'scale.z', 'visibility'] as const;
const AnimationTrackSchema = z.object({
  kind: z.literal('object'),
  source: z.literal('baked-flight').optional(),
  model: z.string(),
  target: z.string().min(1),
  channels: z.object(Object.fromEntries(AnimationChannels.map((channel) => [channel, z.array(AnimationKeySchema).max(5000).optional()]))).superRefine((channels, ctx) => {
    for (const [name, unknownKeys] of Object.entries(channels)) {
      const keys = unknownKeys as { frame: number }[] | undefined;
      if (keys && keys.some((key, i) => i > 0 && key.frame <= keys[i - 1].frame))
        ctx.addIssue({ code: 'custom', path: [name], message: 'Keyframes must be sorted and unique by frame' });
    }
  }),
});
const AnimationSchema = z.object({
  fps: num.int().min(1).max(120),
  startFrame: num.int().min(0).max(20000),
  endFrame: num.int().min(1).max(20000),
  tracks: z.array(AnimationTrackSchema).max(2000),
  buildLayers: z.record(z.string(), z.object({
    startFrame: num.int().min(0).max(20000),
    speed: num.min(0.1).max(4),
  })).optional(),
}).superRefine((animation, ctx) => {
  if (animation.startFrame >= animation.endFrame)
    ctx.addIssue({ code: 'custom', path: ['endFrame'], message: 'End frame must be after start frame' });
  for (const [model, layer] of Object.entries(animation.buildLayers ?? {})) {
    if (layer.startFrame < animation.startFrame || layer.startFrame > animation.endFrame)
      ctx.addIssue({ code: 'custom', path: ['buildLayers', model, 'startFrame'], message: 'Build layer starts outside the scene frame range' });
  }
  const seen = new Set<string>();
  for (let i = 0; i < animation.tracks.length; i++) {
    const track = animation.tracks[i];
    if (track.source === 'baked-flight' && track.channels.visibility?.some((key) => key.value !== 0 && key.value !== 1))
      ctx.addIssue({ code: 'custom', path: ['tracks', i, 'channels', 'visibility'], message: 'Baked visibility keys must be 0 or 1' });
    const id = JSON.stringify([track.model, track.target]);
    if (seen.has(id)) ctx.addIssue({ code: 'custom', path: ['tracks', i], message: 'Duplicate animation target' });
    seen.add(id);
    for (const [channel, unknownKeys] of Object.entries(track.channels)) {
      const keys = unknownKeys as { frame: number }[] | undefined;
      for (const key of keys ?? []) {
        if (key.frame < animation.startFrame || key.frame > animation.endFrame)
          ctx.addIssue({ code: 'custom', path: ['tracks', i, 'channels', channel], message: 'Keyframe outside the scene frame range' });
      }
    }
  }
});

export const PlanSchema = z.object({
  format: z.literal('brickmotion-plan'),
  version: z.literal(1),
  name: z.string(),
  description: z.string().optional(),
  submodels: z.record(z.string(), z.object({ steps: z.array(StepSchema) })).optional(),
  parts: z.record(z.string(), z.string()).optional(),
  steps: z.array(StepSchema),
  animation: AnimationSchema.optional(),
  assemblySpot: AssemblySpotSchema.optional(),
  loosePiecesFollow: z.boolean().optional(),
  showModelAtSpot: z.boolean().optional(),
});

export function parsePlan(json: unknown): { ok: true; plan: Plan } | { ok: false; errors: string[] } {
  const r = PlanSchema.safeParse(json);
  if (r.success) return { ok: true, plan: r.data as Plan };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
