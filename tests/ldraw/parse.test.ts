import { expect, test } from 'vitest';
import { parseLDraw, parseMpd } from '../../src/ldraw/parse';

test('parses a sub-file reference with normalized path', () => {
  const f = parseLDraw('1 16 10 0 0 1 0 0 0 1 0 0 0 1 S\\3001s01.dat');
  expect(f.cmds[0]).toEqual({ t: 'ref', color: 16, pos: [10, 0, 0], m: [1, 0, 0, 0, 1, 0, 0, 0, 1], file: 's/3001s01.dat', invert: false });
});

test('parses triangles, quads and edge lines; drops conditional lines', () => {
  const f = parseLDraw('3 4 0 0 0 1 0 0 0 1 0\n4 16 0 0 0 1 0 0 1 1 0 0 1 0\n2 24 0 0 0 1 1 1\n5 24 0 0 0 1 1 1 0 0 0 1 1 1');
  expect(f.cmds.map((c) => c.t)).toEqual(['tri', 'quad', 'line']);
  expect((f.cmds[1] as { pts: number[] }).pts).toHaveLength(12);
  expect((f.cmds[2] as { pts: number[] }).pts).toEqual([0, 0, 0, 1, 1, 1]);
});

test('reads description, category, step and bfc', () => {
  const f = parseLDraw('0 Brick  2 x  4\n0 !CATEGORY Brick\n0 BFC CERTIFY CCW\n0 STEP\n0 BFC CW');
  expect(f.description).toBe('Brick 2 x 4');
  expect(f.category).toBe('Brick');
  expect(f.cmds).toEqual([{ t: 'bfc', cert: 'CCW' }, { t: 'step' }, { t: 'bfc', winding: 'CW' }]);
});

test('INVERTNEXT applies to the next reference only', () => {
  const f = parseLDraw('0 BFC INVERTNEXT\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 a.dat\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 b.dat');
  const refs = f.cmds.filter((c) => c.t === 'ref') as { invert: boolean }[];
  expect(refs.map((r) => r.invert)).toEqual([true, false]);
});

test('parseMpd splits FILE blocks, main is the first', () => {
  const r = parseMpd('0 FILE Main.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 wing.ldr\n0 NOFILE\n0 FILE Wing.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3020.dat\n');
  expect(r.main).toBe('main.ldr');
  expect([...r.files.keys()]).toEqual(['main.ldr', 'wing.ldr']);
  expect(r.files.get('wing.ldr')!.cmds).toHaveLength(1);
});

test('parseMpd treats a plain ldr as main.ldr', () => {
  const r = parseMpd('1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n');
  expect(r.main).toBe('main.ldr');
  expect(r.files.get('main.ldr')!.cmds).toHaveLength(1);
});
