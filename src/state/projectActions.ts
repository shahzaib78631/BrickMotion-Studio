import { encodeTimeline } from '../anim/timelineCodec';
import { exportLDraw } from '../io/ldrawExport';
import { PROJECT_EXTENSION, projectToJson, type SavedTimeline } from '../io/projectFile';
import { reachableSubmodels, standalonePlan } from '../plan/modelFiles';
import type { Plan } from '../plan/types';
import { saveBlob, safeFileName } from '../ui/download';
import { animOptions, useAppSettings } from './appSettings';
import { getColors, metricsOf } from './partService';
import { optsKey, planTimeline, savedTimeline } from './timelineService';

export type SaveProgress = { done: number; total: number };

/**
 * Downloads one model (or the whole set, '') as a .brickmotion project with the
 * build animation of it and of every submodel it uses, at the current video
 * settings. Animations not planned yet are planned first, so the file always opens
 * straight into them. Returns false if the user cancelled.
 */
export async function saveProjectFile(plan: Plan, model: string, onProgress: (p: SaveProgress | null) => void): Promise<boolean> {
  const opts = animOptions(useAppSettings.getState());
  const standalone = standalonePlan(plan, model);
  // models as named in the saved file, with the model of the current set each one is
  const models: [saved: string, source: string][] = [['', model], ...reachableSubmodels(plan, model).map((s) => [s, s] as [string, string])];
  const timelines: SavedTimeline[] = [];
  const failed: string[] = [];
  try {
    for (const [i, [saved, source]] of models.entries()) {
      let timeline = await savedTimeline(plan, source, opts).catch(() => null);
      if (!timeline) {
        onProgress({ done: i, total: models.length });
        try { timeline = encodeTimeline(await planTimeline(plan, source, opts, 'export')); }
        catch { failed.push(source || 'the whole set'); }
      }
      if (timeline) timelines.push({ model: saved, opts: optsKey(opts), timeline });
    }
  } finally {
    onProgress(null);
  }
  if (failed.length && !confirm(`These animations could not be planned: ${failed.join(', ')}.\n\nSave the project without them? They will be planned when the file is opened.`)) return false;
  saveBlob(`${safeFileName(standalone.name)}.${PROJECT_EXTENSION}`, new Blob([projectToJson(standalone, timelines)], { type: 'application/json' }));
  return true;
}

/** Downloads one model (or the whole set, '') as an LDraw .mpd. */
export function saveLDrawFile(plan: Plan, model: string): void {
  const standalone = standalonePlan(plan, model);
  saveBlob(`${safeFileName(standalone.name)}.mpd`, new Blob([exportLDraw(standalone, metricsOf, getColors())], { type: 'text/plain' }));
}
