import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { auditBookletAssembly } from '../../src/dev/bookletAssembly';
import { measurePart, type PartMetrics } from '../../src/ldraw/metrics';
import { measureReal, realPartsReady } from '../helpers/realParts';

type Part = { part: string; matrix: number[]; new: boolean };
const reference = (): Part[] => JSON.parse(readFileSync(new URL('../../public/_booklet/21065/step-0006.json', import.meta.url), 'utf8')).parts;
async function metrics(parts: Part[]) {
  const entries = await Promise.all([...new Set(parts.map((p) => p.part))].map(async (p) => [p, await measureReal(p)] as const));
  const byPart = new Map(entries);
  return (p: string): PartMetrics => byPart.get(p)!;
}
describe('booklet assembled-pose checks', () => {
  it.skipIf(!realPartsReady)('checks all step-6 meshes and confirms both new end plates have connector mates', async () => {
    const parts = reference(), get = await metrics(parts);
    const audit = auditBookletAssembly(parts, get);
    expect(audit.missingGeometry).toEqual([]);
    expect(audit.collisions).toEqual([]);
    expect(audit.newPartContacts).toHaveLength(2);
    expect(audit.newPartContacts.every((p) => p.hasConnectors && p.mates.length > 0)).toBe(true);
  });
  it.skipIf(!realPartsReady)('detects loss of contact when image fitting drifts an end plate off its stud grid', async () => {
    const parts = reference(), get = await metrics(parts);
    parts[15].matrix[12] -= 3;
    const audit = auditBookletAssembly(parts, get);
    expect(audit.newPartContacts.find((p) => p.index === 15)?.mates).toEqual([]);
  });
  it('reports unavailable geometry without inventing connector contact', () => {
    const part = { part: 'missing.dat', matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], new: true };
    const audit = auditBookletAssembly([part], (id) => measurePart(null, id));
    expect(audit.missingGeometry).toEqual([0]);
    expect(audit.newPartContacts[0]).toMatchObject({ hasConnectors: false, mates: [] });
  });
});
