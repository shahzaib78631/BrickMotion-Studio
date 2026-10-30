/** Local additions to the LDCad Shadow Library: connectors its upstream files miss. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ownSnaps, shadowLookupFrom } from '../../src/ldraw/shadow';
import { inspectMechanisms } from '../../src/anim/motion/v4/mechanismLab';
import { loadRealModel, partDataInstalled } from '../diagnostics/loadRealModel';

const M42000 = join(__dirname, '..', '..', 'samples', '42000-1.mpd');
const CONNHOLE = '0 !LDCAD SNAP_CYL [id=connhole] [gender=F] [caps=none] [secs=R 8 2   R 6 16   R 8 2] [center=true] [slide=true]';

describe('shadow patches', () => {
  it('rim 44772 gets its three pin holes, centred on the modelled holes and running along z', () => {
    const snaps = ownSnaps('44772.dat', shadowLookupFrom({ 'connhole.dat': CONNHOLE }));
    expect(snaps).toHaveLength(3);
    const centres = snaps.map(s => s.start.map((v, i) => v + s.axis[i] * s.length / 2).map(v => Math.round(v * 1000) / 1000));
    expect(centres).toEqual(expect.arrayContaining([[0, 20, -2], [17.321, -10, -2], [-17.321, -10, -2]]));
    for (const s of snaps) { expect(Math.abs(s.axis[2])).toBeCloseTo(1); expect(s.length).toBeCloseTo(20); expect(s.gender).toBe('F'); }
  });
  it('a patch already in the upstream file is not added twice', () => {
    const upstream = '0 !LDCAD SNAP_INCL [ref=connhole.dat] [pos=0 20 -2] [ori=1 0 0 0 0 -1 0 1 0]';
    const snaps = ownSnaps('44772.dat', shadowLookupFrom({ 'connhole.dat': CONNHOLE, '44772.dat': upstream }));
    expect(snaps).toHaveLength(3);
  });
});

describe.skipIf(!partDataInstalled() || !existsSync(M42000))('42000 front wheels', () => {
  it('each front rim is fixed to its hub on the three pins, so it turns with it', async () => {
    const { asm, metrics } = await loadRealModel(M42000);
    const rec = inspectMechanisms(asm, metrics).graph.recognition!;
    const near = (part: string, x: number) => asm.instances.find(i => i.part.replace(/\.dat$/, '') === part
      && Math.hypot(i.world.elements[12] - x, i.world.elements[13] + 60, i.world.elements[14] + 280) < 12)!.key;
    for (const side of [1, -1]) expect(rec.bodyOf.get(near('44772', side * 272))).toBe(rec.bodyOf.get(near('92909', side * 250)));
  }, 600_000);
});
