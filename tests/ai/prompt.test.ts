import { expect, test } from 'vitest';
import { buildCopyPrompt, buildFixMessage, buildGenerateMessage, buildSystemPrompt } from '../../src/ai/prompt';
import { PALETTE } from '../../src/ai/palette';
import type { ColorDef } from '../../src/ldraw/colors';
import { emptyPlan } from '../../src/plan/types';
import type { Warning } from '../../src/model/validate';

const palette = [
  { id: '3001', name: 'Brick 2 x 4', w: 4, d: 2, heightPlates: 3 },
  { id: '3020', name: 'Plate 2 x 4', w: 4, d: 2, heightPlates: 1 },
];
const colors: ColorDef[] = [
  { code: 1, name: 'Blue', hex: '#0055BF', edge: '#333', alpha: 255, finish: 'solid' },
  { code: 46, name: 'Trans_Yellow', hex: '#F5CD2F', edge: '#333', alpha: 128, finish: 'trans' },
  { code: 80, name: 'Metallic_Silver', hex: '#A5A9B4', edge: '#333', alpha: 255, finish: 'metal' },
];

test('system prompt: grid rules, every palette id with its size, colours', () => {
  const s = buildSystemPrompt(palette, colors);
  expect(s).toContain('x and z are in studs');
  for (const p of palette) expect(s).toContain(p.id);
  expect(s).toContain('4×2×3');
  expect(s).toContain('Blue');
  expect(s).toContain('Trans Yellow');
  expect(s).not.toContain('Metallic Silver');
  expect(s).toMatch(/submodel/i);
});

test('generate message carries the idea and the piece limit', () => {
  const m = buildGenerateMessage('a pink rocket', { maxPieces: 60 });
  expect(m).toContain('a pink rocket');
  expect(m).toContain('60');
});

test('fix message carries the note, warnings and plan', () => {
  const plan = { ...emptyPlan('Jet'), steps: [{ pieces: [{ id: 'a', part: '3001', color: 1, x: 0, y: 0, z: 0, rot: 0 as const }] }] };
  const warnings: Warning[] = [{ kind: 'floating', itemIds: ['a'], instanceKeys: ['a'], model: '', message: 'Brick 2 x 4 is floating' }];
  const m = buildFixMessage(plan, warnings, 'make the wings longer');
  expect(m).toContain('make the wings longer');
  expect(m).toContain('Brick 2 x 4 is floating');
  expect(m).toContain('"part": "3001"');
});

test('copy prompt ends by asking for only the JSON', () => {
  const p = buildCopyPrompt(palette, colors, 'a tiny tugboat');
  expect(p).toContain('a tiny tugboat');
  expect(p).toContain('x and z are in studs');
  expect(p).toMatch(/only the JSON/i);
});

test('the palette is a curated list of 150–250 unique ids', () => {
  expect(new Set(PALETTE).size).toBe(PALETTE.length);
  expect(PALETTE.length).toBeGreaterThanOrEqual(150);
  expect(PALETTE.length).toBeLessThanOrEqual(250);
});
