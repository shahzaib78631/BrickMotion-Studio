import { del, get, set } from 'idb-keyval';
import type { Plan } from '../plan/types';

export type ProjectMeta = { id: string; name: string; updatedAt: number; pieceCount: number };

const INDEX = 'projects:index';
const LAST = 'projects:last';
const key = (id: string) => `project:${id}`;

export const countPieces = (p: Plan) => [...p.steps, ...Object.values(p.submodels ?? {}).flatMap((m) => m.steps)].reduce((n, s) => n + s.pieces.length, 0);

async function readIndex(): Promise<ProjectMeta[]> {
  return (await get<ProjectMeta[]>(INDEX)) ?? [];
}

export async function listProjects(): Promise<ProjectMeta[]> {
  return [...(await readIndex())].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadProject(id: string): Promise<Plan | null> {
  return (await get<Plan>(key(id))) ?? null;
}

export async function saveProject(id: string, plan: Plan): Promise<void> {
  await set(key(id), plan);
  const meta: ProjectMeta = { id, name: plan.name, updatedAt: Date.now(), pieceCount: countPieces(plan) };
  await set(INDEX, [...(await readIndex()).filter((p) => p.id !== id), meta]);
  await set(LAST, id);
}

export async function deleteProject(id: string): Promise<void> {
  await del(key(id));
  await set(INDEX, (await readIndex()).filter((p) => p.id !== id));
  if ((await get(LAST)) === id) await del(LAST);
}

export async function lastProjectId(): Promise<string | null> {
  return (await get<string>(LAST)) ?? null;
}

export const newProjectId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
