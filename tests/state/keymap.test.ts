import { expect, test } from 'vitest';
import { commandForKey } from '../../src/state/keymap';

const k = (key: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) => ({
  key,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  ...mods,
});

test('arrow keys follow the camera', () => {
  expect(commandForKey(k('ArrowRight'), 0)).toEqual({ kind: 'move', d: { x: 1, y: 0, z: 0 } });
  // the view shows plan z flipped (world z = −LDU z), so "away from the camera" at azimuth 0 is plan +z
  expect(commandForKey(k('ArrowUp'), 0)).toEqual({ kind: 'move', d: { x: 0, y: 0, z: 1 } });
  expect(commandForKey(k('ArrowRight'), 90)).toEqual({ kind: 'move', d: { x: 0, y: 0, z: 1 } });
  expect(commandForKey(k('ArrowUp'), 90)).toEqual({ kind: 'move', d: { x: -1, y: 0, z: 0 } });
  expect(commandForKey(k('ArrowRight'), 30)).toEqual({ kind: 'move', d: { x: 1, y: 0, z: 0 } });
});

test('height, rotate, delete, undo, redo', () => {
  expect(commandForKey(k('PageUp'), 0)).toEqual({ kind: 'move', d: { x: 0, y: 1, z: 0 } });
  expect(commandForKey(k('PageDown'), 0)).toEqual({ kind: 'move', d: { x: 0, y: -1, z: 0 } });
  expect(commandForKey(k('r'), 0)).toEqual({ kind: 'rotate' });
  expect(commandForKey(k('Delete'), 0)).toEqual({ kind: 'delete' });
  expect(commandForKey(k('Backspace'), 0)).toEqual({ kind: 'delete' });
  expect(commandForKey(k('z', { metaKey: true }), 0)).toEqual({ kind: 'undo' });
  expect(commandForKey(k('z', { ctrlKey: true }), 0)).toEqual({ kind: 'undo' });
  expect(commandForKey(k('z', { metaKey: true, shiftKey: true }), 0)).toEqual({ kind: 'redo' });
  expect(commandForKey(k('z'), 0)).toBeNull();
});

test('duplicate and tool keys', () => {
  expect(commandForKey(k('d', { metaKey: true }), 0)).toEqual({ kind: 'duplicate' });
  expect(commandForKey(k('d', { ctrlKey: true }), 0)).toEqual({ kind: 'duplicate' });
  expect(commandForKey(k('v'), 0)).toEqual({ kind: 'tool', tool: 'select' });
  expect(commandForKey(k('m'), 0)).toEqual({ kind: 'tool', tool: 'move' });
});
