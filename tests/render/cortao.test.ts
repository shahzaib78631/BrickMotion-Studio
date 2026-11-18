import { expect, test } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { cortaoParameters } from '../../src/render/cortao/parameters';
import { aoFor, sanitizeMaterials } from '../../src/render/looks';
import occluders from '../../src/render/cortao/occluders.json';

for (const projection of ['perspective', 'ortho'] as const) {
  test(`CORTAO reconstructs ${projection} positions, including off-center projections`, () => {
    const camera = projection === 'perspective' ? new PerspectiveCamera(45, 1.5, 0.1, 1000)
      : new OrthographicCamera(-6, 9, 5, -5, -20, 100);
    camera.setViewOffset(1200, 800, 100, 75, 900, 600);
    camera.updateProjectionMatrix();
    const p = cortaoParameters(camera, 900, 600, 0.8);
    expect(p.normalBias).toBeGreaterThan(0);
    expect(p.maxApparentCircleRadiusCoefficient).toBeLessThan(1);
    for (const uv of [[0.1, 0.2], [0.5, 0.5], [0.9, 0.8]]) {
      const expected = new Vector3(uv[0] * 2 - 1, uv[1] * 2 - 1, 0.5).unproject(camera);
      const u = p.unprojectParams;
      const scale = projection === 'perspective' ? -expected.z : 1;
      expect((uv[0] * u.x + u.z) * scale).toBeCloseTo(expected.x, 7);
      expect((uv[1] * u.y + u.w) * scale).toBeCloseTo(expected.y, 7);
    }
  });
}

test('CORTAO is opt-in and survives material settings storage', () => {
  const ao = { enabled: true, strength: 1, radius: 0.8 };
  expect(sanitizeMaterials({ ao }).ao.algorithm).toBeUndefined();
  expect(sanitizeMaterials({ ao: { ...ao, algorithm: 'unknown' } }).ao.algorithm).toBeUndefined();
  const clean = sanitizeMaterials({ ao: { ...ao, algorithm: 'cortao' } });
  expect(clean.ao.algorithm).toBe('cortao');
  expect(aoFor('lavender', clean.ao)).toMatchObject({ algorithm: 'cortao', intensity: 1, radius: 0.8 });
  expect(aoFor('lavender', { ...clean.ao, enabled: false }).intensity).toBe(0);
});

test('reference lookup table contains exactly 24×24×16 sixteen-ray masks', () => {
  expect(occluders.length).toBe(24 * 24 * 16);
  expect(occluders.every(value => Number.isInteger(value) && value >= 0 && value <= 0xffff)).toBe(true);
  expect(new Set(occluders).size).toBeGreaterThan(100);
});

test('all upstream shader bodies are byte-identical to the pinned reference', async () => {
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { default: upstream } = await import('../../src/render/cortao/upstream.json');
  const bytes = Buffer.alloc(occluders.length * 2);
  occluders.forEach((value, index) => bytes.writeUInt16LE(value, index * 2));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(upstream.lookupSha256);
  for (const [file, expected] of Object.entries(upstream.sha256)) {
    const source = readFileSync(new URL('../../src/render/cortao/' + file, import.meta.url));
    expect(createHash('sha256').update(source).digest('hex')).toBe(expected);
  }
});

test('screen AO modifies indirect lighting before tone mapping and leaves direct terms intact', async () => {
  const { cortaoLightingShader } = await import('../../src/render/cortao/lighting');
  const shader = { uniforms: {}, fragmentShader: '#include <aomap_fragment>\nvec3 total = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;' };
  cortaoLightingShader(shader as Parameters<typeof cortaoLightingShader>[0]);
  expect(shader.fragmentShader).toContain('reflectedLight.indirectDiffuse *= bmAO');
  expect(shader.fragmentShader).toContain('reflectedLight.indirectSpecular *= computeSpecularOcclusion');
  expect(shader.fragmentShader).not.toMatch(/\.directDiffuse\s*\*=/);
  expect(shader.fragmentShader).not.toMatch(/\.directSpecular\s*\*=/);
  expect(shader.fragmentShader).toContain('vec3 total = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;');
});

test('reference depth parameters handle finite, reverse and infinite perspective clips', async () => {
  const { cortaoPrepassParameters } = await import('../../src/render/cortao/parameters');
  const camera = new PerspectiveCamera(45, 1, .1, 100);
  for (const [near, far, expected] of [
    [.1, 100, [-9.99, 10]], [100, .1, [9.99, .01]],
    [.1, Infinity, [-10, 10]], [Infinity, .1, [10, 0]],
  ] as const) {
    camera.near = near; camera.far = far;
    const p = cortaoPrepassParameters(camera, 49, 35, 6);
    expect(p.depthScale).toBeCloseTo(expected[0], 8);
    expect(p.depthOffset).toBeCloseTo(expected[1], 8);
  }
});
