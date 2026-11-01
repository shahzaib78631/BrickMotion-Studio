import { expect, test } from 'vitest';
import { parsePartsBin, parseRebrickablePartsCsv, partsBinToRows } from '../../src/io/partsImport';

const DEADPOOL_CSV = `Part,Color,Quantity,Is Spare
23443,0,1,False
3070b,0,2,False
22885,226,5,False
3003,29,1,False
99207,71,1,False
85984,320,5,False
3005,320,2,False
`;

test('reads a Rebrickable parts export into part, colour, quantity and spare rows', () => {
  const rows = parseRebrickablePartsCsv(DEADPOOL_CSV);
  expect(rows).toEqual([
    { part: '23443', color: 0, quantity: 1, spare: false },
    { part: '3070b', color: 0, quantity: 2, spare: false },
    { part: '22885', color: 226, quantity: 5, spare: false },
    { part: '3003', color: 29, quantity: 1, spare: false },
    { part: '99207', color: 71, quantity: 1, spare: false },
    { part: '85984', color: 320, quantity: 5, spare: false },
    { part: '3005', color: 320, quantity: 2, spare: false },
  ]);
});

test('reads the Rebrickable colour column and CRLF line endings', () => {
  const rows = parseRebrickablePartsCsv('Part,Color,Quantity,Is Spare\r\n3005,4,2,True\r\n');
  expect(rows).toEqual([{ part: '3005', color: 4, quantity: 2, spare: true }]);
});

test('reads a parts bin of LDraw part files with colour and count', () => {
  const bin = parsePartsBin(`[options]
kind=basic
caption=MOC-174017-Deadpool Brickheadz
sortOn=description

<items>
23443.dat:[sourceInv=parts] [color=0] [count=1]
3070b.dat:[sourceInv=parts] [color=0] [count=2]
22885.dat:[sourceInv=parts] [color=226] [count=5]
`);
  expect(bin.caption).toBe('MOC-174017-Deadpool Brickheadz');
  expect(bin.kind).toBe('basic');
  expect(bin.items).toEqual([
    { part: '23443', sourceInv: 'parts', color: 0, count: 1 },
    { part: '3070b', sourceInv: 'parts', color: 0, count: 2 },
    { part: '22885', sourceInv: 'parts', color: 226, count: 5 },
  ]);
});

test('turns a parts bin into the rows a Rebrickable export would give', () => {
  const bin = parsePartsBin(`[options]
kind=basic

<items>
15068.dat:[sourceInv=parts] [color=320] [count=12]
`);
  const rows = partsBinToRows(bin);
  expect(rows).toHaveLength(12);
  expect(rows[0]).toEqual({ part: '15068', color: 320, quantity: 1 });
});
