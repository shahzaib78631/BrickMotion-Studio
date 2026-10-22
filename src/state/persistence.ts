import { ensureIds } from '../plan/ids';
import { emptyPlan } from '../plan/types';
import { lastProjectId, loadProject, newProjectId, saveProject } from '../storage/projects';
import { loadSettings, saveSettings } from '../storage/settings';
import { applySettings, toSettings, useAppSettings } from './appSettings';
import { useStudio } from './store';

const AUTOSAVE_MS = 1000;
let projectId = newProjectId();
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;

export const currentProjectId = () => projectId;

/** Saves the open project right away (used before switching projects). */
export async function flushSave(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = undefined;
  await saveProject(projectId, useStudio.getState().plan);
}

function show(id: string, plan = emptyPlan()) {
  projectId = id;
  const st = useStudio.getState();
  st.setPlan(ensureIds(plan), { resetHistory: true });
  st.setMode('edit');
}

export async function openProject(id: string): Promise<void> {
  await flushSave();
  const plan = await loadProject(id);
  if (plan) show(id, plan);
}

export async function newProject(): Promise<void> {
  await flushSave();
  show(newProjectId());
}

/** Restores settings and the last project, then autosaves both. */
export async function initPersistence(): Promise<void> {
  if (started) return;
  started = true;
  await applySettings(await loadSettings());
  const last = await lastProjectId();
  const plan = last ? await loadProject(last) : null;
  if (last && plan) show(last, plan);

  let lastPlan = useStudio.getState().plan;
  useStudio.subscribe((s) => {
    if (s.plan === lastPlan) return;
    lastPlan = s.plan;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void saveProject(projectId, lastPlan);
    }, AUTOSAVE_MS);
  });
  let settingsTimer: ReturnType<typeof setTimeout> | undefined;
  useAppSettings.subscribe((s) => {
    if (settingsTimer) clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => void saveSettings(toSettings(s)), 300);
  });
  window.addEventListener('beforeunload', () => {
    if (timer) void saveProject(projectId, useStudio.getState().plan);
  });
}
