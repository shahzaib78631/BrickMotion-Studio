/** Saved project templates (in this browser), and applying one to the open project. */
import { del, get, set } from 'idb-keyval';
import { assemble } from '../model/assemble';
import { applyTemplateToPlan, readTemplate, templateFrom, TEMPLATE_EXTENSION, type ProjectTemplate, type TemplateReference } from '../plan/template';
import type { Plan } from '../plan/types';
import { worldBox } from '../render/studio';
import { sanitizeSettings } from '../storage/settings';
import { saveBlob, safeFileName } from '../ui/download';
import { applySettings, toSettings, useAppSettings } from './appSettings';
import { ensureParts, getColors, metricsOf, registerInlineParts } from './partService';
import { useStudio } from './store';
import { allPartIds } from './useModel';
import * as THREE from 'three';

const INDEX = 'templates:index';
const DEFAULT = 'templates:default';
const key = (id: string) => `template:${id}`;

export type TemplateMeta = { id: string; name: string; createdAt: number };

const newTemplateId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export async function listTemplates(): Promise<TemplateMeta[]> {
  return [...((await get<TemplateMeta[]>(INDEX)) ?? [])].sort((a, b) => b.createdAt - a.createdAt);
}

export async function loadTemplate(id: string): Promise<ProjectTemplate | null> {
  return readTemplate(await get(key(id)));
}

async function storeTemplate(t: ProjectTemplate): Promise<void> {
  await set(key(t.id), t);
  const index = ((await get<TemplateMeta[]>(INDEX)) ?? []).filter((m) => m.id !== t.id);
  await set(INDEX, [...index, { id: t.id, name: t.name, createdAt: t.createdAt }]);
}

export async function deleteTemplate(id: string): Promise<void> {
  await del(key(id));
  await set(INDEX, ((await get<TemplateMeta[]>(INDEX)) ?? []).filter((m) => m.id !== id));
  if ((await get(DEFAULT)) === id) await del(DEFAULT);
}

/** The template applied to every imported model, if one is chosen. */
export async function importTemplateId(): Promise<string | null> {
  return (await get<string>(DEFAULT)) ?? null;
}

export async function setImportTemplate(id: string | null): Promise<void> {
  if (id) await set(DEFAULT, id);
  else await del(DEFAULT);
}

/** Centre and size of the whole set in world units, or null for an empty project. */
export async function modelReference(plan: Plan): Promise<TemplateReference | null> {
  const ids = allPartIds(plan);
  if (!ids.length) return null;
  registerInlineParts(plan.parts);
  await ensureParts(ids);
  const bounds = assemble(plan, metricsOf, getColors()).bounds;
  if (!bounds) return null;
  const box = worldBox(bounds);
  const size = box.getSize(new THREE.Vector3()).length();
  if (!(size > 0)) return null;
  return { center: box.getCenter(new THREE.Vector3()).toArray() as [number, number, number], size };
}

/** Saves the open project's look, motion and scene as a new template. */
export async function saveCurrentAsTemplate(name: string): Promise<ProjectTemplate> {
  const plan = useStudio.getState().plan;
  const t = templateFrom(name, toSettings(useAppSettings.getState()), plan, await modelReference(plan), newTemplateId());
  await storeTemplate(t);
  return t;
}

/**
 * Applies a template to the open project: the settings, then the scene cameras, lights
 * and spots fitted to the model that is open now. The model itself is not touched, and
 * the plan change can be undone.
 */
export async function applyTemplate(t: ProjectTemplate, plan = useStudio.getState().plan): Promise<void> {
  const current = toSettings(useAppSettings.getState());
  await applySettings(sanitizeSettings({ ...current, ...t.settings, video: { ...current.video, ...structuredClone(t.settings.video) } }));
  const target = await modelReference(plan);
  useStudio.getState().apply((p) => applyTemplateToPlan(p, t, target));
}

/** Applies the import template, if one is set, to a freshly imported plan. */
export async function applyImportTemplate(plan: Plan): Promise<string | null> {
  const id = await importTemplateId();
  const t = id ? await loadTemplate(id) : null;
  if (!t) return null;
  await applyTemplate(t, plan);
  return t.name;
}

export function downloadTemplate(t: ProjectTemplate): void {
  saveBlob(`${safeFileName(t.name)}.${TEMPLATE_EXTENSION}`, new Blob([JSON.stringify(t, null, 2)], { type: 'application/json' }));
}

/** Adds a downloaded template file to this browser's templates. */
export async function importTemplateFile(file: File): Promise<ProjectTemplate> {
  let json: unknown;
  try { json = JSON.parse(await file.text()); } catch { throw new Error(`${file.name} is not a template file.`); }
  const t = readTemplate(json);
  if (!t) throw new Error(`${file.name} is not a BrickMotion template.`);
  // a copy of its own, so importing the same file twice never overwrites one in use
  const copy = { ...t, id: newTemplateId() };
  await storeTemplate(copy);
  return copy;
}
