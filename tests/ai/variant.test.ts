import type Anthropic from '@anthropic-ai/sdk';
import { describe as group, expect, it } from 'vitest';
import { applyEdits, colourCode, describe, flatten, makeVariant } from '../../src/ai/variant';
import { brickify } from '../../src/generate/brickify';
import { Voxels } from '../../src/generate/voxels';
import type { ColorDef } from '../../src/ldraw/colors';
import { assemble } from '../../src/model/assemble';
import type { Plan, PlanItem } from '../../src/plan/types';
import { getColors, metricsOf } from '../../src/state/partService';
import { appPartsReady as ready, useAppParts } from '../helpers/appParts';

const planOf = (items: PlanItem[]): Plan => ({ format: 'brickmotion-plan', version: 1, name: 'wall', steps: [{ pieces: items }] }) as Plan;
const ids = (items: PlanItem[]) => [...new Set(items.flatMap((p) => ('part' in p ? [p.part] : [])))];
/** a 4×2 wall two bricks tall, in red */
const wall = () => brickify(Voxels.from(4, 2, 6, () => 4)).items.map((p, n) => ({ ...p, id: `w${n}` }));

const COLOURS = [{ code: 4, name: 'Red' }, { code: 72, name: 'Dark_Bluish_Gray' }, { code: 1, name: 'Blue' }] as ColorDef[];

group('colour names', () => {
  it('reads names however they are written, and numbers', () => {
    expect(colourCode('dark bluish grey', COLOURS)).toBe(72);
    expect(colourCode('Dark_Bluish_Gray', COLOURS)).toBe(72);
    expect(colourCode('15', COLOURS)).toBe(15);
    expect(colourCode('Mauve', COLOURS)).toBeNull();
  });
});

group('edits', () => {
  const base = (): Plan => planOf([
    { id: 'p1', part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 },
    { id: 'p2', part: '3001', color: 4, ldu: [40, -24, 20], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
  ]);
  it('recolours, moves (grid and exact), swaps, removes and adds', () => {
    const { plan, notes } = applyEdits(base(), [
      { op: 'recolour', id: 'p1', color: 'Blue' },
      { op: 'move', id: 'p1', dx: 1, dy: 3, dz: 0 },
      { op: 'move', id: 'p2', dx: 0, dy: 1, dz: 2 },
      { op: 'swap', id: 'p2', part: '3003' },
      { op: 'add', part: '3020', color: 'Dark Bluish Gray', x: 0, y: 6, z: 0, rot: 90 },
      { op: 'remove', id: 'p1' },
      { op: 'remove', id: 'nope' },
    ], COLOURS);
    const items = plan.steps.flatMap((s) => s.pieces);
    expect(items.map((i) => i.id)).toEqual(['p2', 'n1']);
    expect(items[0]).toMatchObject({ part: '3003', ldu: [40, -32, 60] });
    expect(items[1]).toMatchObject({ part: '3020', color: 72, x: 0, y: 6, z: 0, rot: 90 });
    expect(plan.steps.at(-1)!.title).toBe('Variant');
    expect(notes).toEqual(['remove nope: no piece has that id']);
  });
  it('leaves the original plan alone', () => {
    const b = base();
    applyEdits(b, [{ op: 'remove', id: 'p1' }], COLOURS);
    expect(b.steps[0].pieces).toHaveLength(2);
  });
});

group.skipIf(!ready)('a build as loose pieces', () => {
  it('keeps every piece where it was, and describes it in studs and plates', async () => {
    const items = wall();
    await useAppParts(ids(items));
    const plan = planOf(items);
    const before = assemble(plan, metricsOf, getColors()).instances.map((i) => i.worldBox);
    const flat = flatten(plan, assemble(plan, metricsOf, getColors()));
    const asm = assemble(flat, metricsOf, getColors());
    expect(asm.instances.map((i) => i.worldBox)).toEqual(before);
    const lines = describe(asm).split('\n');
    expect(lines).toHaveLength(items.length);
    expect(lines[0]).toMatch(/^p1 {2}\S+ ".+" {2}Red {2}x [\d.]+\.\.[\d.]+ {2}z [\d.]+\.\.[\d.]+ {2}y 0\.\.3$/);
  });
});

group.skipIf(!ready)('the variant loop', () => {
  /** A fake Claude that answers each round from a list, and records what it was sent. */
  const fake = (answers: object[], sent: Record<string, unknown>[]) => () => ({
    beta: {
      messages: {
        stream: (body: Record<string, unknown>) => {
          sent.push({ ...body, messages: [...(body.messages as unknown[])] });
          const a = answers[sent.length - 1];
          return { finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(a) }] }) };
        },
      },
    },
  }) as unknown as Anthropic;

  it('sends the check’s problems back and returns the clean round', async () => {
    const items = wall();
    await useAppParts([...ids(items), '3003']);
    const base = planOf(items);
    const sent: Record<string, unknown>[] = [];
    const floating = { op: 'add', part: '3003', color: 'Blue', x: 0, y: 12, z: 0, rot: 0 };
    const fixed = [{ op: 'remove', id: 'n1' }, { op: 'add', part: '3003', color: 'Blue', x: 0, y: 6, z: 0, rot: 0 }];
    const r = await makeVariant(
      { apiKey: 'k', request: 'add a blue chimney', base },
      { createClient: fake([{ name: 'Chimney wall', summary: 'a chimney', edits: [floating] }, { name: 'Chimney wall', summary: 'a chimney on top', edits: fixed }], sent) },
    );
    expect(sent).toHaveLength(2);
    expect(sent[0].model).toBe('claude-sonnet-5-5');
    const second = sent[1].messages as { role: string; content: unknown }[];
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(String(second[2].content)).toMatch(/floating \[n1\]/);
    expect(r.rounds).toBe(2);
    expect(r.problems).toEqual([]);
    expect(r.cert.floating).toBe(0);
    const added = r.plan.steps.flatMap((s) => s.pieces).filter((p) => p.id?.startsWith('n'));
    expect(added).toEqual([expect.objectContaining({ id: 'n2', part: '3003', y: 6 })]);
  }, 120000); // the whole parts palette loads
  it('works without a key through the local CLI, the conversation folded into one prompt', async () => {
    const items = wall();
    await useAppParts([...ids(items), '3003']);
    const sent: { prompt: string; model?: string; schema: object }[] = [];
    const answers = [
      { name: 'Chimney wall', summary: 'a chimney', edits: [{ op: 'add', part: '3003', color: 'Blue', x: 0, y: 12, z: 0, rot: 0 }] },
      { name: 'Chimney wall', summary: 'a chimney on top', edits: [{ op: 'move', id: 'n1', dx: 0, dy: -6, dz: 0 }] },
    ];
    const bridge = async (a: { prompt: string; model?: string; schema: object }) => { sent.push(a); return { output: answers[sent.length - 1] }; };
    const r = await makeVariant({ request: 'add a blue chimney', base: planOf(items) }, { bridge: bridge as never });
    expect(sent).toHaveLength(2);
    expect(sent[0].model).toBe('claude-sonnet-5-5');
    expect(sent[0].schema).toMatchObject({ type: 'object' });
    expect(sent[1].prompt).toContain('add a blue chimney');
    expect(sent[1].prompt).toContain('"op":"add"');
    expect(sent[1].prompt).toMatch(/floating \[n1\]/);
    expect(r.problems).toEqual([]);
    expect(r.rounds).toBe(2);
  }, 120000);
});
