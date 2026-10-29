import { expect, test } from 'vitest';
import { snapCharacter } from '../../src/audio/snapSound';

test('bigger parts make more stud clicks, a longer slide, a lower ring and a deeper thump', () => {
  const small = snapCharacter({ count: 1, studs: 1, height: 8 });
  const plate = snapCharacter({ count: 1, studs: 8, height: 8 });
  const brick = snapCharacter({ count: 1, studs: 8, height: 24 });
  expect(small.clicks).toBe(2);
  expect(plate.clicks).toBe(4);
  expect(plate.slide).toBeGreaterThan(small.slide);
  expect(plate.pitch).toBeLessThan(small.pitch);
  expect(brick.pitch).toBeLessThan(plate.pitch);
  expect(brick.thumpHz).toBeLessThan(plate.thumpHz);
  expect(brick.thump).toBeGreaterThan(plate.thump);
  // no size known: a small plate
  expect(snapCharacter({ count: 1 }).clicks).toBe(2);
});
