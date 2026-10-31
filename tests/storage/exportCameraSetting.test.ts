import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../../src/storage/settings';

describe('MP4 camera setting', () => {
  it('new installs use the camera track (automatic until a track exists)', () => {
    expect(DEFAULT_SETTINGS.exportCamera).toBe('track');
  });
  it('keeps each saved choice and repairs unknown ones', () => {
    for (const v of ['track', 'automatic', 'buildView'] as const) expect(sanitizeSettings({ exportCamera: v }).exportCamera).toBe(v);
    expect(sanitizeSettings({ exportCamera: 'nope' as never }).exportCamera).toBe('track');
  });
});
