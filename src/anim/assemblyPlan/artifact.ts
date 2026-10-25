/**
 * Reader for the BrickMotion assembly plan artifact (v1), produced by the Python
 * planning engine (`python/assembly_model`). Units are LDraw LDU (stud pitch 20,
 * brick height 24), y axis down, matrices column-major 16-number rows, matching
 * both THREE.Matrix4.elements and the artifact writer in `python/assembly_model/schema.py`.
 */
import { z } from 'zod';

const V3 = z.array(z.number().finite()).length(3);
/** Column-major 4x4 homogeneous matrix, as serialized by numpy. */
const Matrix = z.array(z.number().finite()).length(16);

export const ArtifactPieceSchema = z.object({
  key: z.string().min(1),
  part: z.string().min(1),
  color: z.number().int(),
  matrix: Matrix,
  submodel: z.string().nullable().optional(),
  group: z.string().nullable().optional(),
});

export const ArtifactJointSchema = z.object({
  id: z.string(),
  kind: z.string(),
  parent: z.string(),
  child: z.string(),
  axis: V3,
  confidence: z.string(),
  snap: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const ArtifactInsertionSchema = z.object({
  /** Unit direction the piece travels FROM its staged pose TO its final pose. */
  axis: V3,
  /** Travel distance along `axis` (the swept-corridor length). */
  distance: z.number().finite().nonnegative(),
  origin: V3,
  priority: z.string(),
  tier: z.enum(['snap', 'face', 'drop']),
});

export const ArtifactCertificateSchema = z.object({
  kind: z.string(),
  frames: z.number().int().nonnegative(),
  margin: z.number().finite().nonnegative(),
  clear: z.boolean(),
  blockers: z.array(z.string()).optional(),
});

export const ArtifactStepSchema = z.object({
  id: z.string(),
  pieces: z.array(z.string()).min(1),
  order: z.number().int(),
  dependsOn: z.array(z.number().int()).optional(),
  insertion: ArtifactInsertionSchema.nullable().optional(),
  certificate: ArtifactCertificateSchema.nullable().optional(),
  uncertified: z.boolean().optional(),
  reason: z.string().nullable().optional(),
  prior: z.record(z.string(), z.unknown()).nullable().optional(),
});

/**
 * Optional python-authored build animation (flight-v1): one flight per step,
 * in artifact step order. `floor` is the staged pose (column-major, pure
 * translation of the matched final pose); `path` holds the flight waypoints
 * as offsets relative to the final pose, last one exactly the origin.
 * The `F` fields are fractions of the authored build window, so the studio's
 * targetSeconds scales the choreography: a piece materialises at `appearF`,
 * takes off at `startF` and stays airborne for `durF` (arc-length proportional
 * along `path`, with the final insert travel rendered visibly slower).
 * `route: false` marks a flight the engine could not certify — such a block
 * is refused as a whole by the studio (certified-only).
 */
export const ArtifactFlightPieceSchema = z.object({
  key: z.string().min(1),
  floor: Matrix,
  path: z.array(V3).min(2),
  appearF: z.number().finite().min(0).max(1),
  startF: z.number().finite().min(0).max(1),
  durF: z.number().finite().min(0).max(1),
  route: z.boolean(),
});

export const ArtifactAnimationSchema = z.object({
  kind: z.literal('flight-v1'),
  pieces: z.array(ArtifactFlightPieceSchema),
});

export type ArtifactFlightPiece = z.infer<typeof ArtifactFlightPieceSchema>;
export type ArtifactAnimation = z.infer<typeof ArtifactAnimationSchema>;

export type ArtifactPiece = z.infer<typeof ArtifactPieceSchema>;
export type ArtifactJoint = z.infer<typeof ArtifactJointSchema>;
export type ArtifactInsertion = z.infer<typeof ArtifactInsertionSchema>;
export type ArtifactStep = z.infer<typeof ArtifactStepSchema>;

export type AssemblyArtifact = z.infer<typeof AssemblyArtifactSchema>;

export const AssemblyArtifactSchema = z.object({
  format: z.literal('brickmotion-assembly-plan'),
  version: z.literal(1),
  model: z.string(),
  units: z.literal('ldu'),
  jointsCertain: z.number().int(),
  pieces: z.array(ArtifactPieceSchema),
  joints: z.array(ArtifactJointSchema),
  steps: z.array(ArtifactStepSchema),
  stats: z.record(z.string(), z.unknown()),
  animation: ArtifactAnimationSchema.nullable().optional(),
});

export function parseAssemblyArtifact(json: unknown): { ok: true; artifact: AssemblyArtifact } | { ok: false; errors: string[] } {
  const r = AssemblyArtifactSchema.safeParse(json);
  if (r.success) return { ok: true, artifact: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}

export function isAssemblyArtifact(json: unknown): boolean {
  return typeof json === 'object' && json !== null && (json as { format?: unknown }).format === 'brickmotion-assembly-plan';
}
