/**
 * Project templates: everything about how a project looks and moves, without the model.
 * A template keeps the video, staging, camera, materials and sound settings, plus the
 * project's scene cameras, lights and render border. Those scene objects are stored
 * relative to the model the template was made from (its centre and size), so applying
 * the template to a bigger or smaller model frames that model the same way.
 */
import type { Settings } from '../storage/settings';
import type { AssemblySpot, Plan } from './types';
import type { SceneSetup } from '../render/sceneSetup';

type XYZ = [number, number, number];

/** The settings a template carries: the global look and motion, not API keys or UI prefs. */
export type TemplateSettings = Pick<Settings, 'video' | 'exportCamera' | 'cameraFollowsPlayback' | 'logoEnabled' | 'logoCorner'>;

/** Where the model sat when the template was made, in world units (studs). */
export type TemplateReference = { center: XYZ; size: number };

export type ProjectTemplate = {
  format: 'brickmotion-template';
  version: 1;
  id: string;
  name: string;
  createdAt: number;
  settings: TemplateSettings;
  /** the project's scene cameras, lights and render border, as saved */
  scene?: SceneSetup;
  /** the model the scene was set up around; null when the project was empty */
  reference: TemplateReference | null;
  assemblySpot?: AssemblySpot;
  loosePiecesFollow?: boolean;
  showModelAtSpot?: boolean;
};

export const TEMPLATE_EXTENSION = 'bmtemplate';

export function templateFrom(name: string, settings: Settings, plan: Plan, reference: TemplateReference | null, id: string, now = Date.now()): ProjectTemplate {
  const t: ProjectTemplate = {
    format: 'brickmotion-template', version: 1, id, name: name.trim() || 'Untitled template', createdAt: now,
    settings: {
      video: structuredClone(settings.video),
      exportCamera: settings.exportCamera,
      cameraFollowsPlayback: settings.cameraFollowsPlayback,
      logoEnabled: settings.logoEnabled,
      logoCorner: settings.logoCorner,
    },
    reference,
  };
  if (plan.sceneSetup) t.scene = structuredClone(plan.sceneSetup);
  if (plan.assemblySpot) t.assemblySpot = { ...plan.assemblySpot };
  if (plan.loosePiecesFollow !== undefined) t.loosePiecesFollow = plan.loosePiecesFollow;
  if (plan.showModelAtSpot !== undefined) t.showModelAtSpot = plan.showModelAtSpot;
  return t;
}

/** The template's scene moved and scaled from its reference model onto `target`. */
export function fitScene(scene: SceneSetup, from: TemplateReference | null, to: TemplateReference | null): SceneSetup {
  const out = structuredClone(scene);
  if (!from || !to || !(from.size > 0) || !(to.size > 0)) return out;
  const k = to.size / from.size;
  const move = (p: XYZ): XYZ => [0, 1, 2].map((i) => to.center[i] + (p[i] - from.center[i]) * k) as XYZ;
  for (const c of out.cameras) {
    c.position = move(c.position);
    c.target = move(c.target);
    c.near *= k;
    c.far *= k;
  }
  for (const l of out.lights) {
    l.position = move(l.position);
    l.target = move(l.target);
    if (l.type === 'point' || l.type === 'spot') {
      // the same light on the model from k times further away
      l.intensity *= k * k;
      if (l.distance > 0) l.distance *= k;
    }
  }
  if (out.frameStaging) {
    const cam = out.frameStaging.camera;
    cam.position = move(cam.position);
    cam.target = move(cam.target);
    if (cam.near !== undefined) cam.near *= k;
    if (cam.far !== undefined) cam.far *= k;
  }
  return out;
}

/** The plan with the template's scene and spots, keeping its own model untouched. */
export function applyTemplateToPlan(plan: Plan, t: ProjectTemplate, target: TemplateReference | null): Plan {
  const next: Plan = { ...plan };
  if (t.scene) next.sceneSetup = fitScene(t.scene, t.reference, target);
  else delete next.sceneSetup;
  if (t.assemblySpot) next.assemblySpot = { ...t.assemblySpot };
  else delete next.assemblySpot;
  if (t.loosePiecesFollow !== undefined) next.loosePiecesFollow = t.loosePiecesFollow;
  if (t.showModelAtSpot !== undefined) next.showModelAtSpot = t.showModelAtSpot;
  return next;
}

/** Reads a template file; null when it is not a usable template. */
export function readTemplate(json: unknown): ProjectTemplate | null {
  if (!json || typeof json !== 'object') return null;
  const t = json as Partial<ProjectTemplate>;
  if (t.format !== 'brickmotion-template' || t.version !== 1) return null;
  if (!t.settings || typeof t.settings !== 'object' || !t.settings.video || typeof t.settings.video !== 'object') return null;
  const ref = t.reference;
  const okRef = ref === null || ref === undefined
    || (Array.isArray(ref.center) && ref.center.length === 3 && ref.center.every(Number.isFinite) && Number.isFinite(ref.size));
  if (!okRef) return null;
  const scene = t.scene;
  if (scene !== undefined && (!scene || !Array.isArray(scene.cameras) || !Array.isArray(scene.lights))) return null;
  return {
    format: 'brickmotion-template', version: 1,
    id: typeof t.id === 'string' && t.id ? t.id : `t${Date.now().toString(36)}`,
    name: typeof t.name === 'string' && t.name.trim() ? t.name.trim() : 'Imported template',
    createdAt: Number.isFinite(t.createdAt) ? t.createdAt! : Date.now(),
    settings: t.settings as TemplateSettings,
    scene, reference: ref ?? null,
    ...(t.assemblySpot ? { assemblySpot: t.assemblySpot } : {}),
    ...(typeof t.loosePiecesFollow === 'boolean' ? { loosePiecesFollow: t.loosePiecesFollow } : {}),
    ...(typeof t.showModelAtSpot === 'boolean' ? { showModelAtSpot: t.showModelAtSpot } : {}),
  };
}
