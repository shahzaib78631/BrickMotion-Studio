import { expect, test } from 'vitest';
import { DEFAULT_SOUND, SOUND_PRESETS, SOUND_RANGES, sanitizeSound } from '../../src/audio/soundSettings';

test('stored sound settings are sanitised: defaults for missing or bad values, ranges clamped', () => {
  expect(sanitizeSound(undefined)).toEqual(DEFAULT_SOUND);
  expect(sanitizeSound('nope')).toEqual(DEFAULT_SOUND);
  const s = sanitizeSound({ volume: 9, thump: -1, brightness: 'x', together: 2.6, source: 'synth', library: 'bogus', sizePitch: false, room: null });
  expect(s.volume).toBe(SOUND_RANGES.volume[1]);
  expect(s.thump).toBe(0);
  expect(s.brightness).toBe(DEFAULT_SOUND.brightness);
  expect(s.together).toBe(3);
  expect(s.source).toBe('synth');
  expect(s.library).toBe('all');
  expect(s.sizePitch).toBe(false);
  expect(s.room).toBe(DEFAULT_SOUND.room);
});

test('defaults and presets sit inside the slider ranges', () => {
  for (const p of SOUND_PRESETS) expect(sanitizeSound(p.sound)).toEqual(p.sound);
  expect(new Set(SOUND_PRESETS.map((p) => p.id)).size).toBe(SOUND_PRESETS.length);
  // the "click only" preset has no body under the click
  expect(SOUND_PRESETS.find((p) => p.id === 'click')?.sound.thump).toBe(0);
});
