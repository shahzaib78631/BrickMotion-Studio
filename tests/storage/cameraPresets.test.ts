import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../../src/storage/settings';
import { BUILT_IN_PRESETS } from '../../src/anim/cameraTrack/presets';

const good = { id: 'user-1', label: 'My swoop', hint: '', settings: structuredClone(BUILT_IN_PRESETS[11].settings) };

describe('saved transition presets', () => {
  it('start empty', () => {
    expect(DEFAULT_SETTINGS.cameraPresets).toEqual([]);
  });
  it('keep good presets and drop ones with broken settings', () => {
    const bad = { id: 'user-2', label: 'Broken', hint: '', settings: { curve: { kind: 'wobble', strength: 1 } } };
    const out = sanitizeSettings({ cameraPresets: [good, bad, null, { id: 3 }] as never });
    expect(out.cameraPresets).toEqual([good]);
  });
  it('repair a value that is not a list', () => {
    expect(sanitizeSettings({ cameraPresets: 'x' as never }).cameraPresets).toEqual([]);
  });
});
