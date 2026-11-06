import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Assembly, Instance } from '../../src/model/assemble';
import { connectionChecks, modelConnections } from '../../src/plan/connectionGraph';
import { partConnectors } from '../../src/plan/connectors';
import { realMetrics, realPartsReady as ready } from '../helpers/realParts';

const inst = (key: string, part: string, world: Matrix4): Instance => ({
  key, itemId: key, model: '', part, color: 4, world,
  worldBox: { min: [0, 0, 0], max: [1, 1, 1] }, placeholder: false, grid: false,
});
const asm = (instances: Instance[]): Assembly => ({ nodes: [], instances, bounds: null, problems: [] });

describe('model connection graph', () => {
  it.skipIf(!ready)('finds every stud mating between two stacked 2x4 bricks', async () => {
    const metrics = await realMetrics(['3001']);
    // LDraw +Y is down: stacking a brick on top moves it −24 LDU
    const a = inst('a', '3001', new Matrix4());
    const b = inst('b', '3001', new Matrix4().makeTranslation(0, -24, 0));
    const conns = modelConnections(asm([a, b]), metrics);
    expect(conns).toHaveLength(8);
    expect(conns.every((c) => c.type === 'stud')).toBe(true);
    expect(new Set([conns[0].a.key, conns[0].b.key])).toEqual(new Set(['a', 'b']));
    // the lower brick's stud points up (−Y) into the upper brick's socket
    expect(conns.every((c) => Math.abs(c.axis[1] + 1) < 1e-6)).toBe(true);
    expect(connectionChecks(asm([a, b]), metrics)).toHaveLength(0);
  });

  it.skipIf(!ready)('flags a piece held by a single stud as weak', async () => {
    const metrics = await realMetrics(['3001', '3023']);
    const a = inst('a', '3001', new Matrix4());
    // a 1x2 plate hanging off the brick's corner: one of its two sockets is on a stud
    const p = inst('p', '3023', new Matrix4().makeTranslation(40, -8, 10));
    const model = asm([a, p]);
    const conns = modelConnections(model, metrics);
    expect(conns).toHaveLength(1);
    expect(conns[0].type).toBe('stud');
    const warns = connectionChecks(model, metrics, (x) => x);
    expect(warns).toHaveLength(1);
    expect(warns[0].kind).toBe('weak');
    expect(warns[0].itemIds).toEqual(['p']);
  });

  it.skipIf(!ready)('does not flag a 1x1 piece on its one stud: that is all it can take', async () => {
    // a 1x1 plate, and the 1x1 tiles from the Hellboy model: rounded end, and round (whose
    // socket is modelled twice along the same axis)
    const metrics = await realMetrics(['3001', '3024', '24246', '98138']);
    for (const part of ['3024', '24246', '98138']) {
      const model = asm([inst('a', '3001', new Matrix4()), inst('p', part, new Matrix4().makeTranslation(10, -8, 10))]);
      expect(modelConnections(model, metrics)).toHaveLength(1);
      expect(connectionChecks(model, metrics)).toHaveLength(0);
    }
  });

  it.skipIf(!ready)('mates a Technic pin shaft with the brick hole it enters, which holds firmly', async () => {
    const metrics = await realMetrics(['3700', '4274']);
    const hole = partConnectors(metrics('3700')).find((c) => c.type === 'pin' && c.gender === 'F')!;
    const shaft = partConnectors(metrics('4274')).find((c) => c.type === 'pin' && c.gender === 'M')!;
    // rotate the pin so its shaft points into the hole, then slide the shaft start onto the hole mouth
    const q = new Quaternion().setFromUnitVectors(new Vector3(...shaft.axis), new Vector3(...hole.axis.map((v) => -v)));
    const rotated = new Vector3(...shaft.pos).applyQuaternion(q);
    const t = hole.pos.map((v, i) => v - rotated.getComponent(i));
    const m = new Matrix4().makeRotationFromQuaternion(q);
    m.setPosition(new Vector3(t[0], t[1], t[2]));
    const model = asm([inst('b', '3700', new Matrix4()), inst('p', '4274', m)]);
    const conns = modelConnections(model, metrics);
    expect(conns).toHaveLength(1);
    expect(conns[0].type).toBe('pin');
    // a pin holds firmly: no weak warning, and hole's bar bore does not mate a pin family
    expect(connectionChecks(model, metrics)).toHaveLength(0);
  });
});
