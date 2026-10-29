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

const PositionSchema = z.tuple([num, num, num]);
const SceneCameraSchema = z.object({
  kind: z.literal('camera'), id: z.string().min(1), name: z.string().min(1).max(100),
  position: PositionSchema, target: PositionSchema,
  fov: num.min(8).max(130), near: num.min(0.001).max(100), far: num.min(1).max(100000),
}).refine((c) => c.far > c.near, 'Camera far clip must exceed near clip')
  .refine((c) => Math.hypot(...c.position.map((n, i) => n - c.target[i])) > 1e-4, 'Camera must not sit at its look-at target');
const SceneLightSchema = z.object({
  kind: z.literal('light'), id: z.string().min(1), name: z.string().min(1).max(100),
  type: z.enum(['sun', 'point', 'spot', 'ambient']),
  position: PositionSchema, target: PositionSchema,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/), intensity: num.min(0).max(2000),
  angle: num.min(1).max(179), distance: num.min(0).max(10000),
  castShadow: z.boolean(), enabled: z.boolean(),
});
const RegionSchema = z.object({ x: num.min(0).max(1), y: num.min(0).max(1), width: num.min(0.025).max(1), height: num.min(0.025).max(1) })
  .refine((r) => r.x + r.width <= 1 + 1e-9 && r.y + r.height <= 1 + 1e-9, 'Render region exceeds frame');
const FrameStagingSchema = z.object({
  version: z.literal(1),
  cameraId: z.string().min(1).max(200), cameraName: z.string().min(1).max(100),
  format: z.enum(['9:16', '4:5', '1:1', '16:9']),
  floorSort: z.enum(['step', 'colour', 'part', 'size', 'all']),
  floorSides: z.enum(['front-back', 'front', 'behind', 'sides', 'around']),
  floorMatch: z.enum(['fill', 'nearest']),
  camera: z.object({
    position: PositionSchema, target: PositionSchema,
    fov: num.min(8).max(130), aspect: num.min(0.1).max(5),
    near: num.min(0.001).max(100).optional(), far: num.min(1).max(100000).optional(),
    crop: RegionSchema.optional(),
  }).refine((c) => Math.hypot(...c.position.map((n, i) => n - c.target[i])) > 1e-4, 'Camera must not sit at its target'),
});
const SceneSetupSchema = z.object({
  cameras: z.array(SceneCameraSchema).max(24), lights: z.array(SceneLightSchema).max(64),
  activeCameraId: z.string().nullable(), useCameraForVideo: z.boolean(), useLightsForVideo: z.boolean(),
  includeStudioLights: z.boolean(), region: RegionSchema.nullable(), cropToRegion: z.boolean(),
  frameStaging: FrameStagingSchema.optional(),
  exposure: num.min(0.1).max(5),
}).superRefine((s, ctx) => {
  const ids = [...s.cameras, ...s.lights].map((o) => o.id);
  if (ids.length !== new Set(ids).size) ctx.addIssue({ code: 'custom', message: 'Scene object IDs must be unique' });
  if (s.activeCameraId && !s.cameras.some((c) => c.id === s.activeCameraId))
    ctx.addIssue({ code: 'custom', path: ['activeCameraId'], message: 'Active camera does not exist' });
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
  sceneSetup: SceneSetupSchema.optional(),
  assemblySpot: AssemblySpotSchema.optional(),
  workBaySpots: z.record(z.string().min(1), AssemblySpotSchema).optional(),
  loosePiecesFollow: z.boolean().optional(),
  showModelAtSpot: z.boolean().optional(),
  // assembly plan artifact (opaque cold JSON; validated by the assembly-artifact planner)
  assemblyPlan: z.unknown().optional(),
  // which models were planned by the Assembly Corrector, and the order to put back
  assemblyCorrector: z.record(z.string(), z.object({
    at: z.number(),
    steps: z.number(),
    units: z.number().optional(),
    issues: z.number().optional(),
    previous: z.object({
      ids: z.array(z.array(z.string().optional())),
      meta: z.array(z.object({ title: z.string().optional(), notes: z.string().optional(), pauseAfter: z.number().optional() })),
    }).optional(),
  })).optional(),
});

export function parsePlan(json: unknown): { ok: true; plan: Plan } | { ok: false; errors: string[] } {
  const r = PlanSchema.safeParse(json);
  if (r.success) return { ok: true, plan: r.data as Plan };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
