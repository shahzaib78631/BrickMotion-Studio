import { expect, test } from 'vitest';
import { sanitizeSettings } from '../../src/storage/settings';
import { applySettings, toSettings, useAppSettings } from '../../src/state/appSettings';

test('older settings retain the current viewport and live export', () => {
  expect(sanitizeSettings({}).video).toMatchObject({ viewportRenderer: 'live', videoEngine: 'live' });
});

test('Studio path viewport and export preferences survive the settings round trip', async () => {
  const stored = sanitizeSettings({ video: { viewportRenderer: 'studio-path', videoEngine: 'studio-path', pathSamples: 128 } as never });
  await applySettings(stored);
  expect(toSettings(useAppSettings.getState()).video).toMatchObject({ viewportRenderer: 'studio-path', videoEngine: 'studio-path', pathSamples: 128 });
});

test('invalid render modes fall back while existing path exports stay supported', () => {
  expect(sanitizeSettings({ video: { viewportRenderer: 'invalid', videoEngine: 'invalid' } as never }).video).toMatchObject({ viewportRenderer: 'live', videoEngine: 'live' });
  expect(sanitizeSettings({ video: { videoEngine: 'path' } as never }).video.videoEngine).toBe('path');
});

test('hybrid preview persists independently of full-quality video export', async () => {
  const stored = sanitizeSettings({ video: { viewportRenderer: 'studio-hybrid', videoEngine: 'studio-path', pathSamples: 64 } as never });
  await applySettings(stored);
  expect(toSettings(useAppSettings.getState()).video).toMatchObject({ viewportRenderer: 'studio-hybrid', videoEngine: 'studio-path' });
  expect(sanitizeSettings({ video: { videoEngine: 'studio-hybrid' } as never }).video.videoEngine).toBe('live');
});
