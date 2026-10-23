import { expect, test } from 'vitest';
import { tidyPlacement } from '../../src/plan/placement';

test('a nearly square placement is snapped to exact values (5590 helicopter axle)', () => {
  const p = tidyPlacement({ pos: [-80, 43.9948, 40], m: [0, 1, 0, -0.000345306, 0, 1, 1, 0, 0.000345306] });
  expect(p.pos).toEqual([-80, 44, 40]);
  expect(p.m).toEqual([0, 1, 0, 0, 0, 1, 1, 0, 0]);
});

test('deliberate angles and their positions are kept', () => {
  const hose = { pos: [50, -22.1284, -366.963], m: [0, 0, 1, 0.9996, -0.0296, 0, -0.0296, -0.9996, 0] } as const;
  expect(tidyPlacement({ pos: [...hose.pos], m: [...hose.m] })).toEqual(hose);
  const slight = { pos: [0, 8.004, 0], m: [1, 0, 0, 0, 0.9999, -0.0129, 0, 0.0129, 0.9999] } as const;
  expect(tidyPlacement({ pos: [...slight.pos], m: [...slight.m] })).toEqual(slight); // a real 0.7° tilt
});

test('only the coordinates within the noise of a half-LDU value move; a mirrored part stays mirrored', () => {
  expect(tidyPlacement({ pos: [14.3349, -41.9921, -52.6567], m: [1, 0, 0, 0, 1, 0, 0, 0, 1] }).pos).toEqual([14.3349, -42, -52.6567]);
  expect(tidyPlacement({ pos: [10.004, 0, 0], m: [-1, 0, 0, 0, 1, 0, 0, 0, 1.0001] })).toEqual({ pos: [10, 0, 0], m: [-1, 0, 0, 0, 1, 0, 0, 0, 1] });
});
