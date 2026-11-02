import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePlan } from '../../src/plan/schema';
import { importLDraw } from '../../src/io/ldrawImport';

const dir = resolve(__dirname, '..', 'fixtures', 'brickheadz');

describe('generated BrickHeadz is importable by the studio', () => {
  it('plan JSON passes the studio plan schema', () => {
    const plan = JSON.parse(readFileSync(resolve(dir, 'bh-sample.plan.json'), 'utf8'));
    const r = parsePlan(plan);
    expect(r.ok, r.ok ? '' : JSON.stringify((r as { errors: string[] }).errors)).toBe(true);
  });

  it('MPD imports into a plan', () => {
    const text = readFileSync(resolve(dir, 'bh-sample.mpd'), 'utf8');
    const plan = importLDraw(text, 'bh-sample.mpd');
    expect(plan.format).toBe('brickmotion-plan');
    const pieces = plan.steps.flatMap((s) => s.pieces);
    expect(pieces.length).toBeGreaterThan(30);
    expect(pieces.every((p) => 'part' in p && 'color' in p)).toBe(true);
  });
});
