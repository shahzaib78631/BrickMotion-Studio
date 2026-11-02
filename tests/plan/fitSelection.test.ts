import { expect, it } from 'vitest';
import * as THREE from 'three';
import { measureReal, realPartsReady as ready } from '../helpers/realParts';
import { fitSelection, type FitPiece } from '../../src/plan/fitSelection';
import { attachmentSlotsFor } from '../../src/ldraw/attachments';
import { attachmentLocalMatrix, multiplyAttachmentMatrices } from '../../src/model/attachmentPlacements';
import { partConnectors } from '../../src/plan/connectors';
import { collisionWorld, type Solid } from '../../src/plan/collision';
import type { PartMetrics } from '../../src/ldraw/metrics';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const at = (x: number, y: number, z: number) => Array.from(new THREE.Matrix4().makeTranslation(x, y, z).elements);
const round = (v: readonly number[]) => Array.from(v, (n) => Math.round(n * 1000) / 1000);

/** measure the parts once, then answer synchronously the way the app's metricsOf does */
const measure = async (ids: readonly string[]) => {
  const parts = new Map<string, PartMetrics>();
  for (const id of ids) parts.set(id, await measureReal(id));
  return (part: string): PartMetrics => {
    const m = parts.get(part);
    if (!m) throw new Error(`no metrics for ${part}`);
    return m;
  };
};

const pose = (host: readonly number[], slot: { pos: readonly number[]; m: readonly number[] }) =>
  multiplyAttachmentMatrices(host, attachmentLocalMatrix(slot as never));

it.skipIf(!ready)('seats a katana in the scabbard at the documented slot pose', async () => {
  const metricsOf = await measure(['19141', '21459', '30173a', '4274']);
  const host: FitPiece = { id: 'scabbard', part: '19141', world: I };
  // where the documented pose puts the sword, and a little way off it
  const slots = attachmentSlotsFor('19141', '30173');
  expect(slots.map((s) => s.id)).toEqual(['19141:sword:1', '19141:sword:2']);
  const near = pose(I, slots[0]);
  const sword: FitPiece = { id: 'sword', part: '21459', world: at(near[12] + 40, near[13], near[14] + 40) };

  const fit = fitSelection([host, sword], { metricsOf });
  expect(fit.ok).toBe(true);
  if (!fit.ok) return;
  expect(fit.kind).toBe('documented-slot');
  expect(fit.insert).toBe('sword');
  expect(fit.detail).toContain('19141:sword:1');
  expect(fit.detail).not.toContain('reflected');
  expect(round(fit.world)).toEqual(round(near));
});

it.skipIf(!ready)('leaves the reflected slot to the setting that allows it', async () => {
  const metricsOf = await measure(['19141', '21459', '30173a']);
  const host: FitPiece = { id: 'scabbard', part: '19141', world: I };
  const second = pose(I, attachmentSlotsFor('19141', '30173')[1]);
  const sword: FitPiece = { id: 'sword', part: '21459', world: at(second[12] + 5, second[13], second[14] - 15) };

  // the mirrored pose is nearer, but a reflected reference is not a physical rotation
  const plain = fitSelection([host, sword], { metricsOf });
  expect(plain.ok && plain.detail).toContain('19141:sword:1');
  const allowed = fitSelection([host, sword], { metricsOf, mirrored: true });
  expect(allowed.ok && allowed.detail).toContain('19141:sword:2');
  expect(allowed.ok && allowed.detail).toContain('reflected');
  expect(allowed.ok && round(allowed.world)).toEqual(round(second));
});

it.skipIf(!ready)('still takes the documented part itself, and refuses a part with no interface', async () => {
  const metricsOf = await measure(['19141', '30173a', '18031']);
  const host: FitPiece = { id: 'scabbard', part: '19141', world: I };
  const documented = fitSelection([host, { id: 'sword', part: '30173a', world: at(60, 0, 0) }], { metricsOf });
  expect(documented.ok && documented.kind).toBe('documented-slot');

  // a longsword has no bar and no place in the scabbard's interface: no pose is invented for it
  const longsword = fitSelection([host, { id: 'sword', part: '18031', world: at(60, 0, 0) }], { metricsOf });
  expect(longsword.ok).toBe(false);
  expect(longsword.ok === false && longsword.why).toContain('no joint');
});

it.skipIf(!ready)('seats a sword grip in a Technic pin through the engine’s own joint', async () => {
  const metricsOf = await measure(['19141', '21459', '4274']);
  const pin: FitPiece = { id: 'pin', part: '4274', world: I };
  const sword: FitPiece = { id: 'sword', part: '21459', world: at(80, -60, 80) };
  // the pin is already pushed into a brick: the joint has to move the sword, not the pin
  const fit = fitSelection([pin, sword], { metricsOf, planted: (id) => (id === 'pin' ? 1 : 0) });
  expect(fit.ok).toBe(true);
  if (!fit.ok) return;
  expect(fit.kind).toBe('connector');
  expect(fit.host).toBe('pin');
  // the grip's base lands on the pin's bar hole, whichever end of it was chosen
  const grip = partConnectors(metricsOf('21459')).find((c) => c.type === 'bar' && c.gender === 'M')!;
  const world = new THREE.Matrix4().fromArray(fit.world);
  const landed = new THREE.Vector3(...grip.pos).applyMatrix4(world);
  const bore = partConnectors(metricsOf('4274')).filter((c) => c.type === 'bar').map((c) => new THREE.Vector3(...c.pos));
  expect(Math.min(...bore.map((b) => b.distanceTo(landed)))).toBeLessThan(0.01);
});

it.skipIf(!ready)('puts a hand-held tool in the clip of a minifig hand', async () => {
  const metricsOf = await measure(['3820', '4349', '30374', '2570']);
  const hand: FitPiece = { id: 'hand', part: '3820', world: I };
  const solid = (id: string, m: PartMetrics, e: number[]): Solid => ({ id, world: e, body: m.body, studs: m.studs, snaps: m.snaps, mesh: m.mesh });
  const world = collisionWorld([solid('hand', metricsOf('3820'), I)]);
  for (const tool of ['4349', '30374', '2570']) {
    const piece: FitPiece = { id: 'tool', part: tool, world: at(50, -50, 60) };
    const fit = fitSelection([hand, piece], { metricsOf, placed: [hand, piece] });
    expect([tool, fit.ok]).toEqual([tool, true]);
    if (!fit.ok) continue;
    // the grip the hand closes round, not the wrist stud the arm mounts on
    expect([tool, fit.kind, fit.detail]).toEqual([tool, 'connector', 'held in the clip']);
    expect([tool, [...world.hits([solid(tool, metricsOf(tool), fit.world)])]]).toEqual([tool, []]);
  }
});

it.skipIf(!ready)('reports a pose the collision verdict refuses instead of taking it', async () => {
  const metricsOf = await measure(['19141', '21459', '30173a']);
  const host: FitPiece = { id: 'scabbard', part: '19141', world: I };
  const sword: FitPiece = { id: 'sword', part: '21459', world: at(0, -40, 0) };
  const fit = fitSelection([host, sword], { metricsOf, blocked: () => ['torso'] });
  expect(fit.ok).toBe(false);
  expect(fit.ok === false && fit.why).toContain('would put sword inside torso');
});
