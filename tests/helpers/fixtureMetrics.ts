import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLDConfig } from '../../src/ldraw/colors';
import { PartLibrary } from '../../src/ldraw/library';
import { measurePart, type PartMetrics } from '../../src/ldraw/metrics';
import { FIXTURE_ROOT, fixtureFetchText } from './fixtureLibrary';

export const fixtureColors = parseLDConfig(readFileSync(join(FIXTURE_ROOT, 'LDConfig.ldr'), 'utf8'));

export async function fixtureMetrics(ids = ['3001', '3020']): Promise<(part: string) => PartMetrics> {
  const lib = new PartLibrary(fixtureFetchText);
  const map = new Map<string, PartMetrics>();
  for (const id of ids) map.set(id, measurePart(await lib.loadPart(id), id));
  return (part) => map.get(part) ?? measurePart(null, part);
}
