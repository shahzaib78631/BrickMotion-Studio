import { describe, expect, it } from 'vitest';
import { parseLDraw } from '../../src/ldraw/parse';
import { attachmentHintsFromLDraw, orthogonalBasisParity, properRigidBasis } from '../../src/ldraw/attachmentHints';
import { attachmentSlotsFor, canonicalAttachmentPart } from '../../src/ldraw/attachments';

// From LDraw's official 19141.dat (CC BY 4.0, Gerald Lasser, 2018-02):
const HELP = `0 Minifig Scabbard for Two Swords with Bar
0 Name: 19141.dat
0 Author: Gerald Lasser [GeraldLasser]
0 !LDRAW_ORG Part UPDATE 2018-02
0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt

0 !HELP Positioning of Swords
0 !HELP 1 1 -.174 -9 35.1 0 -.01745 -.99985 -1 0 0 0 .99985 -.01745 30173.dat
0 !HELP 1 1 -35.1 -5 .174 0 -.99985 .01745 -1 0 0 0 .01745 .99985 30173.dat`;

describe('provenance-aware LDraw attachment hints', () => {
  it('preserves the two exact official sword reference poses and their source lines', () => {
    const file = parseLDraw(HELP, '19141.dat');
    expect(file.help).toHaveLength(3);
    expect(file.cmds.filter((c) => c.t === 'ref')).toHaveLength(0);
    expect(file.attachmentHints).toHaveLength(2);
    expect(file.attachmentHints?.map((x) => x.line)).toEqual([8, 9]);
    expect(file.attachmentHints?.map((x) => x.context)).toEqual(['Positioning of Swords', 'Positioning of Swords']);
    expect(file.attachmentHints?.map((x) => x.mirrored)).toEqual([false, true]);
  });

  it('separates mirror display examples from physically rigid rotations', () => {
    const [a, b] = attachmentHintsFromLDraw(HELP);
    expect(orthogonalBasisParity(a.m)).toBe(1);
    expect(orthogonalBasisParity(b.m)).toBe(-1);
    expect(properRigidBasis(a.m)).toBe(true);
    expect(properRigidBasis(b.m)).toBe(false);
    expect(orthogonalBasisParity([2,0,0,0,1,0,0,0,1])).toBe(0);
    expect(orthogonalBasisParity([1,1,0,0,1,0,0,0,1])).toBe(0);
  });

  it('never executes arbitrary comments or transforms them into trusted snap connections', () => {
    expect(attachmentHintsFromLDraw('0 // !HELP 1 1 0 0 0 1 0 0 0 1 0 0 0 1 a.dat')).toEqual([]);
    expect(attachmentHintsFromLDraw('0 !HELP 1 1 0 0 0 1 0 0 0 1 0 0 0 1 ../another.dat')).toEqual([]);
    expect(attachmentHintsFromLDraw('0 !HELP 1 1 0 0 0 1 0 0 0 1 0 0 0 1 https://x.dat')).toEqual([]);
    expect(attachmentHintsFromLDraw('0 !HELP 1 1 0 0 0 4 0 0 0 1 0 0 0 1 30173.dat')).toEqual([]);
  });

  it('does not confuse different katana variants with a genuine LDraw alias', () => {
    expect(canonicalAttachmentPart('parts/30173.dat')).toBe('30173a');
    expect(attachmentSlotsFor('19141', '30173')).toHaveLength(2);
    expect(attachmentSlotsFor('19141', '30173a')).toHaveLength(2);
    expect(attachmentSlotsFor('19141', '30173b')).toHaveLength(0);
    expect(attachmentSlotsFor('19141', '21459')).toHaveLength(0);
    expect(attachmentSlotsFor('19140', '30173')).toHaveLength(0);
    expect(attachmentSlotsFor('custom/19141.dat', '30173')).toHaveLength(0);
  });

  it('allows free-text HELP only as an explicitly requested unreviewed preview', () => {
    const hints = attachmentHintsFromLDraw('0 !HELP An example\n0 !HELP 1 16 7 8 9 1 0 0 0 1 0 0 0 1 99999.dat');
    expect(attachmentSlotsFor('mystery', '99999', hints)).toEqual([]);
    const [slot] = attachmentSlotsFor('mystery', '99999', hints, true);
    expect(slot.evidence).toBe('unreviewed-ldraw-help');
    expect(slot.type).toBe('reference-placement');
    expect(slot.pos).toEqual([7, 8, 9]);
  });
});
