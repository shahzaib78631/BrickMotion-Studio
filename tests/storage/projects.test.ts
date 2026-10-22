import 'fake-indexeddb/auto';
import { clear } from 'idb-keyval';
import { beforeEach, expect, test, vi } from 'vitest';
import { deleteProject, listProjects, loadProject, saveProject } from '../../src/storage/projects';
import { loadSettings, saveSettings } from '../../src/storage/settings';
import { emptyPlan, type Plan } from '../../src/plan/types';

beforeEach(async () => {
  await clear();
  vi.useRealTimers();
});

const withPieces = (name: string, n: number): Plan => ({
  ...emptyPlan(name),
  steps: [{ pieces: Array.from({ length: n }, (_, i) => ({ part: '3001', color: 4, x: i * 4, y: 0, z: 0, rot: 0 as const })) }],
  submodels: { e: { steps: [{ pieces: [{ part: '3020', color: 1, x: 0, y: 0, z: 0, rot: 0 as const }] }] } },
});

test('save two projects, list newest first with piece counts', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1000);
  await saveProject('a', withPieces('Alpha', 2));
  vi.setSystemTime(2000);
  await saveProject('b', withPieces('Beta', 5));
  const list = await listProjects();
  expect(list.map((p) => p.id)).toEqual(['b', 'a']);
  expect(list[0]).toMatchObject({ name: 'Beta', pieceCount: 6, updatedAt: 2000 });
  expect(list[1].pieceCount).toBe(3);
  expect((await loadProject('a'))?.name).toBe('Alpha');
});

test('re-saving updates instead of duplicating', async () => {
  await saveProject('a', withPieces('Alpha', 1));
  await saveProject('a', withPieces('Alpha 2', 1));
  const list = await listProjects();
  expect(list).toHaveLength(1);
  expect(list[0].name).toBe('Alpha 2');
});

test('delete removes the project and its index entry', async () => {
  await saveProject('a', withPieces('Alpha', 1));
  await deleteProject('a');
  expect(await listProjects()).toEqual([]);
  expect(await loadProject('a')).toBeNull();
});

test('settings default when nothing is stored, and round-trip', async () => {
  const s = await loadSettings();
  expect(s).toMatchObject({ apiKey: '', model: 'claude-opus-5-5', logoEnabled: false, logo: null, video: { targetSeconds: 15, heroOrbit: true, mode: 'auto' } });
  await saveSettings({ ...s, apiKey: 'k', video: { ...s.video, targetSeconds: 30 } });
  const t = await loadSettings();
  expect(t.apiKey).toBe('k');
  expect(t.video.targetSeconds).toBe(30);
  expect(t.model).toBe('claude-opus-5-5');
});
