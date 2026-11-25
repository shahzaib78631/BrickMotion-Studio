import { contextBridge, ipcRenderer } from 'electron';
import type { BrickMotionNativeAPI, NativeMenuAction } from './types';

const api: BrickMotionNativeAPI = {
  isElectron: true,
  platform: process.platform,

  engineInfo: () => ipcRenderer.invoke('bm:engineInfo'),

  sessionNewBlank: () => ipcRenderer.invoke('bm:sessionNewBlank'),
  sessionOpenFile: (filePath) => ipcRenderer.invoke('bm:sessionOpenFile', filePath),
  sessionOpenBytes: (bytes, virtualPath) => ipcRenderer.invoke('bm:sessionOpenBytes', bytes, virtualPath),
  sessionProjectBytes: () => ipcRenderer.invoke('bm:sessionProjectBytes'),
  sessionMpdBytes: () => ipcRenderer.invoke('bm:sessionMpdBytes'),
  sessionSnapshot: () => ipcRenderer.invoke('bm:sessionSnapshot'),
  sessionOutline: () => ipcRenderer.invoke('bm:sessionOutline'),
  sessionSteps: () => ipcRenderer.invoke('bm:sessionSteps'),
  sessionColors: () => ipcRenderer.invoke('bm:sessionColors'),
  sessionSearchParts: (query, limit = 50) => ipcRenderer.invoke('bm:sessionSearchParts', query, limit),
  sessionUndo: () => ipcRenderer.invoke('bm:sessionUndo'),
  sessionRedo: () => ipcRenderer.invoke('bm:sessionRedo'),
  sessionSelect: (pieces, mode = 'replace') => ipcRenderer.invoke('bm:sessionSelect', pieces, mode),
  sessionSelectAll: () => ipcRenderer.invoke('bm:sessionSelectAll'),
  sessionSelectNone: () => ipcRenderer.invoke('bm:sessionSelectNone'),
  sessionHide: (pieces) => ipcRenderer.invoke('bm:sessionHide', pieces),
  sessionShowAll: () => ipcRenderer.invoke('bm:sessionShowAll'),
  sessionRecolor: (pieces, colorCode) => ipcRenderer.invoke('bm:sessionRecolor', pieces, colorCode),
  sessionRemove: (pieces) => ipcRenderer.invoke('bm:sessionRemove', pieces),
  sessionMove: (pieces, dx, dy, dz, continuing = false) =>
    ipcRenderer.invoke('bm:sessionMove', pieces, dx, dy, dz, continuing),
  sessionFocus: (path) => ipcRenderer.invoke('bm:sessionFocus', path),

  viewportResize: (width, height, scale) => ipcRenderer.invoke('bm:viewportResize', width, height, scale),
  viewportSetBackground: (r, g, b) => ipcRenderer.invoke('bm:viewportSetBackground', r, g, b),
  viewportSetPreferences: (prefs) => ipcRenderer.invoke('bm:viewportSetPreferences', prefs),
  viewportSetViewStyle: (style) => ipcRenderer.invoke('bm:viewportSetViewStyle', style),
  viewportSetOrthographic: (enabled) => ipcRenderer.invoke('bm:viewportSetOrthographic', enabled),
  viewportRenderFrame: () => ipcRenderer.invoke('bm:viewportRenderFrame'),
  viewportNeedsDraw: () => ipcRenderer.invoke('bm:viewportNeedsDraw'),
  viewportOrbit: (dx, dy) => ipcRenderer.invoke('bm:viewportOrbit', dx, dy),
  viewportPan: (dx, dy) => ipcRenderer.invoke('bm:viewportPan', dx, dy),
  viewportZoom: (factor) => ipcRenderer.invoke('bm:viewportZoom', factor),
  viewportZoomToward: (factor, x, y) => ipcRenderer.invoke('bm:viewportZoomToward', factor, x, y),
  viewportFitAll: () => ipcRenderer.invoke('bm:viewportFitAll'),
  viewportFrameSelection: () => ipcRenderer.invoke('bm:viewportFrameSelection'),
  viewportCenterOnFloor: () => ipcRenderer.invoke('bm:viewportCenterOnFloor'),
  viewportViewPreset: (preset) => ipcRenderer.invoke('bm:viewportViewPreset', preset),
  viewportCamera: () => ipcRenderer.invoke('bm:viewportCamera'),
  viewportPick: (x, y) => ipcRenderer.invoke('bm:viewportPick', x, y),
  viewportMarquee: (x0, y0, x1, y1, touching = true) =>
    ipcRenderer.invoke('bm:viewportMarquee', x0, y0, x1, y1, touching),

  viewportRequestPlan: () => ipcRenderer.invoke('bm:viewportRequestPlan'),
  viewportRegeneratePlan: (standardPreview = false) =>
    ipcRenderer.invoke('bm:viewportRegeneratePlan', standardPreview),
  viewportPlay: (on) => ipcRenderer.invoke('bm:viewportPlay', on),
  viewportSeek: (seconds) => ipcRenderer.invoke('bm:viewportSeek', seconds),
  viewportShowRest: () => ipcRenderer.invoke('bm:viewportShowRest'),
  viewportSetPlaybackRate: (rate) => ipcRenderer.invoke('bm:viewportSetPlaybackRate', rate),
  viewportSetPlaybackLoop: (loop) => ipcRenderer.invoke('bm:viewportSetPlaybackLoop', loop),
  viewportSetDirectorPreview: (directed) => ipcRenderer.invoke('bm:viewportSetDirectorPreview', directed),
  viewportPlaybackState: () => ipcRenderer.invoke('bm:viewportPlaybackState'),
  viewportBuildTimeline: () => ipcRenderer.invoke('bm:viewportBuildTimeline'),

  inspectAssembly: (selection = [], showAllJoints = true, checkGeometry = true) =>
    ipcRenderer.invoke('bm:inspectAssembly', selection, showAllJoints, checkGeometry),
  auditMotion: (piece = -1) => ipcRenderer.invoke('bm:auditMotion', piece),

  renderNativeStill: (options) => ipcRenderer.invoke('bm:renderNativeStill', options),
  exportNativeSound: (options) => ipcRenderer.invoke('bm:exportNativeSound', options),
  exportNativeVideo: (options) => ipcRenderer.invoke('bm:exportNativeVideo', options),

  openFileDialog: () => ipcRenderer.invoke('bm:openFileDialog'),
  saveFileDialog: (options) => ipcRenderer.invoke('bm:saveFileDialog', options),
  revealInFinder: (filePath) => ipcRenderer.invoke('bm:revealInFinder', filePath),

  onMenuAction: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, action: NativeMenuAction) => handler(action);
    ipcRenderer.on('bm:menu-action', listener);
    return () => ipcRenderer.removeListener('bm:menu-action', listener);
  },
};

contextBridge.exposeInMainWorld('brickMotionNative', api);
