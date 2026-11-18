import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import manifest from '../../public/threert/manifest.json';

it('ships the pinned engine assets and host additions recorded by the build', () => {
  const hash = (url: URL) => createHash('sha256').update(readFileSync(url)).digest('hex');
  expect(manifest.revision).toBe('10fdc7738835d5b4c19438141fe28009a1d66d6b');
  expect(hash(new URL('../../src/render/threert/host.rs', import.meta.url))).toBe(manifest.hostSha256);
  for (const [name, sha] of Object.entries(manifest.sha256)) expect(hash(new URL(`../../public/threert/${name}`, import.meta.url))).toBe(sha);
  expect(readFileSync(new URL('../../public/threert/LICENSE', import.meta.url), 'utf8')).toContain('MIT License');
});
