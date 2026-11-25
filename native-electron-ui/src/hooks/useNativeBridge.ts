import { useCallback, useEffect, useRef, useState } from 'react';
import { exportLDraw } from '@web/io/ldrawExport';
import { getColors, metricsOf } from '@web/state/partService';
import { isProjectFile, projectToJson, readProjectFile } from '@web/io/projectFile';
import { readPlanFile } from '@web/io/planFile';
import { readStudioIo } from '@web/io/studioIo';
import { ensureIds } from '@web/plan/ids';
import { newProject } from '@web/state/persistence';
import { useStudio } from '@web/state/store';
import { useTheme } from '@web/state/theme';
import { viewportApi } from '@web/ui/viewportApi';
import type {
  EngineInfo,
  NativeAssemblyReport,
  NativeMenuAction,
  NativePlaybackState,
  NativeSnapshot,
  NativeViewPreset,
} from '../../electron/types';

export type ViewportBackend = 'metal' | 'webgl';

export interface NativeBridgeState {
  isElectron: boolean;
  engineInfo: EngineInfo | null;
  snapshot: NativeSnapshot | null;
  playback: NativePlaybackState | null;
  assemblyReport: NativeAssemblyReport | null;
  syncing: boolean;
  lastError: string;
  lastFilePath: string | null;
  backend: ViewportBackend;
  setBackend: (b: ViewportBackend) => void;
  syncNow: () => Promise<void>;
  refreshSnapshot: () => Promise<void>;
  openNativeFile: () => Promise<void>;
  saveNativeProject: (saveAs?: boolean) => Promise<void>;
  exportNativeMpd: () => Promise<void>;
  runAssemblyInspect: () => Promise<NativeAssemblyReport | null>;
  requestNativePlan: (standardPreview?: boolean) => Promise<void>;
}

export function useNativeBridge(callbacks: {
  onOpenPanel: (tab: string) => void;
  onExportVideo: () => void;
}): NativeBridgeState {
  const api = window.brickMotionNative;
  const plan = useStudio((s) => s.plan);
  const [engineInfo, setEngineInfo] = useState<EngineInfo | null>(null);
  const [snapshot, setSnapshot] = useState<NativeSnapshot | null>(null);
  const [playback, setPlayback] = useState<NativePlaybackState | null>(null);
  const [assemblyReport, setAssemblyReport] = useState<NativeAssemblyReport | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastError, setLastError] = useState('');
  const [lastFilePath, setLastFilePath] = useState<string | null>(null);
  const [backend, setBackend] = useState<ViewportBackend>('webgl');

  const lastSyncedJsonRef = useRef<string>('');
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  // Query native engine info on startup
  useEffect(() => {
    if (!api) return;
    api
      .engineInfo()
      .then((info) => {
        setEngineInfo(info);
        if (info.available && info.metalAvailable) {
          setBackend('metal');
        }
      })
      .catch((err) => setLastError(err instanceof Error ? err.message : String(err)));
  }, [api]);

  const refreshSnapshot = useCallback(async () => {
    if (!api || !engineInfo?.available) return;
    try {
      const [snap, pb] = await Promise.all([api.sessionSnapshot(), api.viewportPlaybackState()]);
      setSnapshot(snap);
      setPlayback(pb);
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    }
  }, [api, engineInfo?.available]);

  // Keep native bmapp::Session synced with web Zustand plan
  const syncNow = useCallback(async () => {
    if (!api || !engineInfo?.available) return;
    const currentPlan = useStudio.getState().plan;
    const json = projectToJson(currentPlan, []);
    if (json === lastSyncedJsonRef.current) return;
    setSyncing(true);
    try {
      const virtualPath = `${currentPlan.name || 'untitled'}.brickmotion`;
      const res = await api.sessionOpenBytes(json, virtualPath);
      if (res.ok) {
        lastSyncedJsonRef.current = json;
        setLastError('');
        await refreshSnapshot();
      } else {
        setLastError(res.error || 'Failed to sync project to native engine');
      }
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }, [api, engineInfo?.available, refreshSnapshot]);

  useEffect(() => {
    if (!api || !engineInfo?.available) return;
    const timer = window.setTimeout(() => {
      void syncNow();
    }, 180);
    return () => window.clearTimeout(timer);
  }, [api, engineInfo?.available, plan, syncNow]);

  const openNativeFile = useCallback(async () => {
    if (!api) return;
    try {
      const picked = await api.openFileDialog();
      if (picked.canceled || !picked.filePath || !picked.fileName) return;

      const lower = picked.fileName.toLowerCase();
      if (isProjectFile(picked.fileName) && picked.content) {
        const res = readProjectFile(picked.content);
        if (!res.ok) {
          setLastError(res.errors.join('\n'));
          return;
        }
        useStudio.getState().setPlan(ensureIds(res.plan));
        useStudio.getState().setEditingModel('');
        setLastFilePath(picked.filePath);
        setLastError('');
        return;
      }

      if (lower.endsWith('.io') && picked.base64) {
        const bin = Uint8Array.from(atob(picked.base64), (c) => c.charCodeAt(0));
        const text = await readStudioIo(bin.buffer);
        const res = readPlanFile(text, picked.fileName.replace(/\.io$/i, '.ldr'));
        if (!res.ok) {
          setLastError(res.errors.join('\n'));
          return;
        }
        useStudio.getState().setPlan(ensureIds(res.plan));
        useStudio.getState().setEditingModel('');
        setLastFilePath(picked.filePath);
        setLastError('');
        return;
      }

      if (picked.content && (lower.endsWith('.json') || lower.endsWith('.mpd') || lower.endsWith('.ldr') || lower.endsWith('.dat'))) {
        const res = readPlanFile(picked.content, picked.fileName);
        if (!res.ok) {
          setLastError(res.errors.join('\n'));
          return;
        }
        useStudio.getState().setPlan(ensureIds(res.plan));
        useStudio.getState().setEditingModel('');
        setLastFilePath(picked.filePath);
        setLastError('');
        return;
      }

      // Fallback: let native bmapp open it and pull projectBytes back into the UI
      if (engineInfo?.available) {
        const nativeRes = await api.sessionOpenFile(picked.filePath);
        if (!nativeRes.ok) {
          setLastError(nativeRes.error || 'Could not open file');
          return;
        }
        const bytes = await api.sessionProjectBytes();
        const proj = readProjectFile(bytes);
        if (proj.ok) {
          lastSyncedJsonRef.current = bytes;
          useStudio.getState().setPlan(ensureIds(proj.plan));
          useStudio.getState().setEditingModel('');
          setLastFilePath(picked.filePath);
          await refreshSnapshot();
        }
      }
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    }
  }, [api, engineInfo?.available, refreshSnapshot]);

  const saveNativeProject = useCallback(
    async (saveAs = false) => {
      if (!api) return;
      const currentPlan = useStudio.getState().plan;
      const content = projectToJson(currentPlan, []);
      const defaultPath = (!saveAs && lastFilePath) || `${currentPlan.name || 'untitled'}.brickmotion`;
      const res = await api.saveFileDialog({
        defaultPath,
        filters: [{ name: 'BrickMotion Project', extensions: ['brickmotion'] }],
        content,
      });
      if (!res.canceled && res.filePath) {
        setLastFilePath(res.filePath);
      }
    },
    [api, lastFilePath],
  );

  const exportNativeMpd = useCallback(async () => {
    if (!api) return;
    const currentPlan = useStudio.getState().plan;
    const mpd = exportLDraw(currentPlan, metricsOf, getColors());
    await api.saveFileDialog({
      defaultPath: `${currentPlan.name || 'model'}.mpd`,
      filters: [{ name: 'LDraw MPD Model', extensions: ['mpd', 'ldr'] }],
      content: mpd,
    });
  }, [api]);

  const runAssemblyInspect = useCallback(async () => {
    if (!api || !engineInfo?.available) return null;
    await syncNow();
    const report = await api.inspectAssembly([], true, true);
    setAssemblyReport(report);
    return report;
  }, [api, engineInfo?.available, syncNow]);

  const requestNativePlan = useCallback(
    async (standardPreview = false) => {
      if (!api || !engineInfo?.available) return;
      await syncNow();
      await api.viewportRegeneratePlan(standardPreview);
      await refreshSnapshot();
    },
    [api, engineInfo?.available, syncNow, refreshSnapshot],
  );

  // Wire macOS native menu bar actions
  useEffect(() => {
    if (!api) return;
    const handleMenu = (action: NativeMenuAction) => {
      const studio = useStudio.getState();
      switch (action) {
        case 'file:new':
          void newProject();
          setLastFilePath(null);
          break;
        case 'file:open':
          void openNativeFile();
          break;
        case 'file:save':
          void saveNativeProject(false);
          break;
        case 'file:save-as':
          void saveNativeProject(true);
          break;
        case 'file:export-mpd':
          void exportNativeMpd();
          break;
        case 'file:export-video':
          callbacksRef.current.onExportVideo();
          break;
        case 'file:export-native-still':
          callbacksRef.current.onOpenPanel('native');
          break;
        case 'file:export-native-sound':
          callbacksRef.current.onOpenPanel('native');
          break;
        case 'edit:undo':
          studio.undo();
          break;
        case 'edit:redo':
          studio.redo();
          break;
        case 'view:fit':
          if (backend === 'metal' && engineInfo?.available) void api.viewportFitAll();
          else viewportApi.fit();
          break;
        case 'view:toggle-theme': {
          const cur = useTheme.getState().mode;
          useTheme.getState().set({ mode: cur === 'dark' ? 'light' : 'dark' });
          break;
        }
        case 'view:renderer-metal':
          if (engineInfo?.metalAvailable) setBackend('metal');
          break;
        case 'view:renderer-webgl':
          setBackend('webgl');
          break;
        case 'view:preset-front':
        case 'view:preset-back':
        case 'view:preset-left':
        case 'view:preset-right':
        case 'view:preset-top':
        case 'view:preset-bottom': {
          const preset = action.replace('view:preset-', '') as NativeViewPreset;
          if (backend === 'metal' && engineInfo?.available) void api.viewportViewPreset(preset);
          break;
        }
        case 'workspace:build':
          studio.setWorkspace('build');
          break;
        case 'workspace:animate':
          studio.setWorkspace('animate');
          break;
        case 'engine:plan':
          callbacksRef.current.onOpenPanel('native');
          void requestNativePlan(false);
          break;
        case 'engine:inspect':
          callbacksRef.current.onOpenPanel('native');
          void runAssemblyInspect();
          break;
      }
    };
    return api.onMenuAction(handleMenu);
  }, [
    api,
    backend,
    engineInfo?.available,
    engineInfo?.metalAvailable,
    exportNativeMpd,
    openNativeFile,
    requestNativePlan,
    runAssemblyInspect,
    saveNativeProject,
  ]);

  return {
    isElectron: Boolean(api),
    engineInfo,
    snapshot,
    playback,
    assemblyReport,
    syncing,
    lastError,
    lastFilePath,
    backend,
    setBackend,
    syncNow,
    refreshSnapshot,
    openNativeFile,
    saveNativeProject,
    exportNativeMpd,
    runAssemblyInspect,
    requestNativePlan,
  };
}
