import type { Box, FlatPart } from './flatten';

export type PartMetrics = {
  id: string;
  body: Box;
  full: Box;
  footprint: { w: number; d: number };
  heightPlates: number;
  placeholder: boolean;
};

const PLACEHOLDER_BOX: Box = { min: [0, 0, 0], max: [20, 24, 20] };

export function measurePart(flat: FlatPart | null, id: string): PartMetrics {
  const body = flat?.bodyBox ?? flat?.fullBox ?? null;
  if (!flat || !body) {
    const b = { min: [...PLACEHOLDER_BOX.min], max: [...PLACEHOLDER_BOX.max] } as Box;
    return { id, body: b, full: { min: [...b.min], max: [...b.max] } as Box, footprint: { w: 1, d: 1 }, heightPlates: 3, placeholder: true };
  }
  return {
    id,
    body,
    full: flat.fullBox ?? body,
    footprint: {
      w: Math.max(1, Math.round((body.max[0] - body.min[0]) / 20)),
      d: Math.max(1, Math.round((body.max[2] - body.min[2]) / 20)),
    },
    heightPlates: Math.max(1, Math.round((body.max[1] - body.min[1]) / 8)),
    placeholder: false,
  };
}
