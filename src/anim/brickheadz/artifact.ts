/**
 * Reader for the BrickHeadz dataset artifacts (v1), produced by the Python
 * `brickheadz` package. Units are LDraw LDU (stud pitch 20, plate 8), matrices
 * are column-major 16-number rows, and semantic fields are an added layer on
 * top of the original per-piece part/colour/matrix — see `python/brickheadz`.
 */
import { z } from 'zod';

const V3 = z.array(z.number().finite()).length(3);
const Matrix = z.array(z.number().finite()).length(16);
const Dims = z.object({ wStuds: z.number(), dStuds: z.number(), hPlates: z.number() });
const BBox = z.object({ ldu: z.tuple([V3, V3]), dims: Dims });
const Pair = z.array(z.union([z.string(), z.number()]));

export const BrickHeadzPieceSchema = z.object({
  key: z.string().min(1),
  part: z.string(),
  basePart: z.string(),
  color: z.number().int(),
  decorated: z.boolean(),
  submodel: z.string(),
  figure: z.number().int(),
  component: z.string(),
  snot: z.boolean(),
  matrix: Matrix,
  aabb: z.tuple([V3, V3]),
});

export const BrickHeadzFigureSchema = z.object({
  index: z.number().int(),
  pieces: z.number().int(),
  bbox: BBox.omit({ dims: true }),
  roles: z.record(z.string(), z.number()),
  face: z.record(z.string(), z.unknown()),
  headCube: Dims.optional(),
});

export const BrickHeadzComponentSchema = z.object({
  figure: z.number().int(),
  label: z.string(),
  pieces: z.number().int(),
  bbox: BBox.omit({ dims: true }),
  dims: Dims,
});

export const BrickHeadzConnectionSchema = z.object({
  a: z.string(),
  b: z.string(),
  kind: z.string(),
  confidence: z.string(),
  axis: V3,
});

export const BrickHeadzRecordSchema = z.object({
  schema: z.literal('brickheadz.record.v1'),
  version: z.literal(1),
  units: z.literal('ldu'),
  id: z.string(),
  name: z.string(),
  source: z.record(z.string(), z.unknown()),
  frame: z.object({ up: V3, front: V3, ground: z.number() }),
  bbox: BBox,
  figures: z.array(BrickHeadzFigureSchema),
  pieces: z.array(BrickHeadzPieceSchema),
  components: z.array(BrickHeadzComponentSchema),
  connections: z.array(BrickHeadzConnectionSchema),
  face: z.record(z.string(), z.unknown()),
  dna: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
});

export const BrickHeadzGrammarSchema = z.object({
  schema: z.literal('brickheadz.grammar.v1'),
  version: z.literal(1),
  source: z.string(),
  models: z.number().int(),
  coverage: z.object({
    headDetected: z.number().int(),
    headRate: z.number(),
    faceDetected: z.number().int(),
    faceRate: z.number(),
    warningCount: z.number().int(),
  }),
  template: z.record(z.string(), z.record(z.string(), z.unknown())),
  roles: z.record(z.string(), z.array(Pair)),
  connections: z.object({ kinds: z.array(Pair), pairs: z.array(Pair) }),
  colors: z.array(Pair),
  face: z.object({ meanTiles: z.number(), frontSides: z.array(Pair) }),
  warnings: z.array(z.string()),
});

export type BrickHeadzRecord = z.infer<typeof BrickHeadzRecordSchema>;
export type BrickHeadzGrammar = z.infer<typeof BrickHeadzGrammarSchema>;
export type BrickHeadzPiece = z.infer<typeof BrickHeadzPieceSchema>;

export function parseBrickHeadzRecord(json: unknown): { ok: true; record: BrickHeadzRecord } | { ok: false; errors: string[] } {
  const r = BrickHeadzRecordSchema.safeParse(json);
  if (r.success) return { ok: true, record: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}

export function parseBrickHeadzGrammar(json: unknown): { ok: true; grammar: BrickHeadzGrammar } | { ok: false; errors: string[] } {
  const r = BrickHeadzGrammarSchema.safeParse(json);
  if (r.success) return { ok: true, grammar: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}

export function isBrickHeadzRecord(json: unknown): boolean {
  return typeof json === 'object' && json !== null && (json as { schema?: unknown }).schema === 'brickheadz.record.v1';
}
