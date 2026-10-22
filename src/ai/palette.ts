import type { PartMetrics } from '../ldraw/metrics';

/**
 * Parts the AI may use: common, hinge-free, and each verified against the LDraw
 * library and the Rebrickable catalog. Grouped for readability only.
 */
export const PALETTE: string[] = [
  // bricks
  '3005', '3004', '3622', '3010', '3009', '3008', '3003', '3002', '3001', '2456', '3007', '3006', '2357', '3245c', '14716', '22886',
  '3062b', '3941', '6143', '1871', '5852', '30136', '6091', '3659', '3455', '6005',
  // modified bricks / SNOT
  '4070', '87087', '30414', '2877', '4733', '11211', '99780', '99781', '3956',
  // plates
  '3024', '3023b', '3623', '3710', '3666', '3460', '4477', '60479', '3022', '3021', '3020', '3795', '3034', '3832', '2445', '2420',
  '3031', '3032', '3035', '3030', '3029', '3958', '3036', '3033', '41539', '2450', '2419', '7904',
  // modified / round plates
  '6141', '85861', '4032b', '3794b', '15573', '4081b', '2540', '48336', '49668', '32028', '35480', '61252', '4600',
  // tiles
  '3070b', '3069b', '63864', '2431', '6636', '4162', '3068b', '26603', '87079', '98138', '14769', '14719', '2412b', '15712',
  // slopes 45 / 33 / 31 / 18
  '3040a', '3039', '3038', '3037', '3044b', '3043', '3045', '3048b', '3298', '4286', '3297', '54200', '85984', '30363',
  // slopes 65 / 75
  '60481a', '3678a', '4460a',
  // inverted slopes
  '3665b', '3660b', '2310', '3747b', '4287b', '2449',
  // curved slopes
  '11477', '15068', '61678', '50950', '93606', '29119', '29120', '42022', '42023', '47457',
  // wedge plates (LDraw calls them wings)
  '41769b', '41770b', '43722b', '43723b', '3935', '3936', '24299', '24307', '78443', '78444', '65426', '65429', '51739', '54383', '54384', '43719',
  // wedges
  '47753', '4858', '6069',
  // cones, dishes
  '4589', '3942c', '4740', '3960', '2654b',
  // canopies, windscreens, panels
  '3823', '2437', '4866', '4176', '30841', '4865b', '4864b', '2362b', '30413',
  // wheels
  '4624', '3641', '3464c01',
];

export type PaletteEntry = { id: string; name: string; w: number; d: number; heightPlates: number };

/** Measured palette entries; ids that load as placeholders are dropped. */
export function paletteEntries(ids: string[], metrics: (id: string) => PartMetrics, name: (id: string) => string): PaletteEntry[] {
  return ids.flatMap((id) => {
    const m = metrics(id);
    if (m.placeholder) return [];
    return [{ id, name: name(id), w: m.footprint.w, d: m.footprint.d, heightPlates: m.heightPlates }];
  });
}
