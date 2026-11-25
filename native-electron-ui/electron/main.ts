import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  cliPaths,
  getEngineInfo,
  getNativeAddon,
  runNativeCli,
  writeTempProjectFile,
} from './nativeBridge';
import type { NativeMenuAction } from './types';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'bm',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;

function sendMenuAction(action: NativeMenuAction) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bm:menu-action', action);
  }
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('file:new') },
        { label: 'Open Model or Project…', accelerator: 'CmdOrCtrl+O', click: () => sendMenuAction('file:open') },
        { type: 'separator' },
        { label: 'Save Project', accelerator: 'CmdOrCtrl+S', click: () => sendMenuAction('file:save') },
        { label: 'Save Project As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenuAction('file:save-as') },
        { type: 'separator' },
        { label: 'Export LDraw MPD…', click: () => sendMenuAction('file:export-mpd') },
        { label: 'Export Video…', accelerator: 'CmdOrCtrl+E', click: () => sendMenuAction('file:export-video') },
        { type: 'separator' },
        { label: 'Render Native Metal Still (bmshot)…', click: () => sendMenuAction('file:export-native-still') },
        { label: 'Export Native Snap Sound (bmexport)…', click: () => sendMenuAction('file:export-native-sound') },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendMenuAction('edit:undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => sendMenuAction('edit:redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Fit Model in View', accelerator: 'CmdOrCtrl+0', click: () => sendMenuAction('view:fit') },
        { label: 'Toggle Light / Dark Theme', accelerator: 'CmdOrCtrl+Shift+T', click: () => sendMenuAction('view:toggle-theme') },
        { type: 'separator' },
        { label: 'Native Metal Viewport', accelerator: 'CmdOrCtrl+1', click: () => sendMenuAction('view:renderer-metal') },
        { label: 'WebGL Interactive Viewport', accelerator: 'CmdOrCtrl+2', click: () => sendMenuAction('view:renderer-webgl') },
        { type: 'separator' },
        { label: 'Front View', click: () => sendMenuAction('view:preset-front') },
        { label: 'Back View', click: () => sendMenuAction('view:preset-back') },
        { label: 'Left View', click: () => sendMenuAction('view:preset-left') },
        { label: 'Right View', click: () => sendMenuAction('view:preset-right') },
        { label: 'Top View', click: () => sendMenuAction('view:preset-top') },
        { label: 'Bottom View', click: () => sendMenuAction('view:preset-bottom') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Workspace',
      submenu: [
        { label: 'Build Workspace', accelerator: 'CmdOrCtrl+B', click: () => sendMenuAction('workspace:build') },
        { label: 'Animate Workspace', accelerator: 'CmdOrCtrl+Shift+A', click: () => sendMenuAction('workspace:animate') },
      ],
    },
    {
      label: 'Native Engine',
      submenu: [
        { label: 'Plan Build with Native C++ Engine', click: () => sendMenuAction('engine:plan') },
        { label: 'Inspect Assembly Joints & Overlaps', click: () => sendMenuAction('engine:inspect') },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ role: 'front' as const }] : [{ role: 'close' as const }])],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1080,
    minHeight: 700,
    title: 'BrickMotion Studio',
    backgroundColor: '#141518',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 12 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = process.env.BM_ELECTRON_DEV_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadURL('bm://app/index.html');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function requireAddon() {
  const addon = getNativeAddon();
  if (!addon) {
    throw new Error('Native addon bm_native.node is not loaded. Run "npm run build:addon" inside native-electron-ui.');
  }
  return addon;
}

function registerIpcHandlers() {
  ipcMain.handle('bm:engineInfo', () => getEngineInfo());

  // Session
  ipcMain.handle('bm:sessionNewBlank', () => requireAddon().sessionNewBlank());
  ipcMain.handle('bm:sessionOpenFile', (_e, filePath: string) => requireAddon().sessionOpenFile(filePath));
  ipcMain.handle('bm:sessionOpenBytes', (_e, bytes: string, virtualPath: string) =>
    requireAddon().sessionOpenBytes(bytes, virtualPath),
  );
  ipcMain.handle('bm:sessionProjectBytes', () => requireAddon().sessionProjectBytes());
  ipcMain.handle('bm:sessionMpdBytes', () => requireAddon().sessionMpdBytes());
  ipcMain.handle('bm:sessionSnapshot', () => requireAddon().sessionSnapshot());
  ipcMain.handle('bm:sessionOutline', () => requireAddon().sessionOutline());
  ipcMain.handle('bm:sessionSteps', () => requireAddon().sessionSteps());
  ipcMain.handle('bm:sessionColors', () => requireAddon().sessionColors());
  ipcMain.handle('bm:sessionSearchParts', (_e, query: string, limit: number) =>
    requireAddon().sessionSearchParts(query, limit),
  );
  ipcMain.handle('bm:sessionUndo', () => requireAddon().sessionUndo());
  ipcMain.handle('bm:sessionRedo', () => requireAddon().sessionRedo());
  ipcMain.handle('bm:sessionSelect', (_e, pieces: number[], mode: string) =>
    requireAddon().sessionSelect(pieces, mode),
  );
  ipcMain.handle('bm:sessionSelectAll', () => requireAddon().sessionSelectAll());
  ipcMain.handle('bm:sessionSelectNone', () => requireAddon().sessionSelectNone());
  ipcMain.handle('bm:sessionHide', (_e, pieces: number[]) => requireAddon().sessionHide(pieces));
  ipcMain.handle('bm:sessionShowAll', () => requireAddon().sessionShowAll());
  ipcMain.handle('bm:sessionRecolor', (_e, pieces: number[], colorCode: number) =>
    requireAddon().sessionRecolor(pieces, colorCode),
  );
  ipcMain.handle('bm:sessionRemove', (_e, pieces: number[]) => requireAddon().sessionRemove(pieces));
  ipcMain.handle('bm:sessionMove', (_e, pieces: number[], dx: number, dy: number, dz: number, continuing: boolean) =>
    requireAddon().sessionMove(pieces, dx, dy, dz, continuing),
  );
  ipcMain.handle('bm:sessionFocus', (_e, focusPath: string[]) => requireAddon().sessionFocus(focusPath));

  // Metal Viewport
  ipcMain.handle('bm:viewportResize', (_e, w: number, h: number, scale: number) =>
    requireAddon().viewportResize(w, h, scale),
  );
  ipcMain.handle('bm:viewportSetBackground', (_e, r: number, g: number, b: number) =>
    requireAddon().viewportSetBackground(r, g, b),
  );
  ipcMain.handle('bm:viewportSetPreferences', (_e, prefs: any) => requireAddon().viewportSetPreferences(prefs));
  ipcMain.handle('bm:viewportSetViewStyle', (_e, style: string) => requireAddon().viewportSetViewStyle(style));
  ipcMain.handle('bm:viewportSetOrthographic', (_e, enabled: boolean) =>
    requireAddon().viewportSetOrthographic(enabled),
  );
  ipcMain.handle('bm:viewportRenderFrame', () => {
    const frame = requireAddon().viewportRenderFrame();
    return {
      width: frame.width,
      height: frame.height,
      needsMore: frame.needsMore,
      rgba: new Uint8Array(frame.rgba.buffer, frame.rgba.byteOffset, frame.rgba.byteLength),
    };
  });
  ipcMain.handle('bm:viewportNeedsDraw', () => requireAddon().viewportNeedsDraw());
  ipcMain.handle('bm:viewportOrbit', (_e, dx: number, dy: number) => requireAddon().viewportOrbit(dx, dy));
  ipcMain.handle('bm:viewportPan', (_e, dx: number, dy: number) => requireAddon().viewportPan(dx, dy));
  ipcMain.handle('bm:viewportZoom', (_e, factor: number) => requireAddon().viewportZoom(factor));
  ipcMain.handle('bm:viewportZoomToward', (_e, factor: number, x: number, y: number) =>
    requireAddon().viewportZoomToward(factor, x, y),
  );
  ipcMain.handle('bm:viewportFitAll', () => requireAddon().viewportFitAll());
  ipcMain.handle('bm:viewportFrameSelection', () => requireAddon().viewportFrameSelection());
  ipcMain.handle('bm:viewportCenterOnFloor', () => requireAddon().viewportCenterOnFloor());
  ipcMain.handle('bm:viewportViewPreset', (_e, preset: string) => requireAddon().viewportViewPreset(preset));
  ipcMain.handle('bm:viewportCamera', () => requireAddon().viewportCamera());
  ipcMain.handle('bm:viewportPick', (_e, x: number, y: number) => requireAddon().viewportPick(x, y));
  ipcMain.handle('bm:viewportMarquee', (_e, x0: number, y0: number, x1: number, y1: number, touching: boolean) =>
    requireAddon().viewportMarquee(x0, y0, x1, y1, touching),
  );

  // Planner & Playback
  ipcMain.handle('bm:viewportRequestPlan', () => requireAddon().viewportRequestPlan());
  ipcMain.handle('bm:viewportRegeneratePlan', (_e, standardPreview: boolean) =>
    requireAddon().viewportRegeneratePlan(standardPreview),
  );
  ipcMain.handle('bm:viewportPlay', (_e, on: boolean) => requireAddon().viewportPlay(on));
  ipcMain.handle('bm:viewportSeek', (_e, seconds: number) => requireAddon().viewportSeek(seconds));
  ipcMain.handle('bm:viewportShowRest', () => requireAddon().viewportShowRest());
  ipcMain.handle('bm:viewportSetPlaybackRate', (_e, rate: number) => requireAddon().viewportSetPlaybackRate(rate));
  ipcMain.handle('bm:viewportSetPlaybackLoop', (_e, loop: boolean) => requireAddon().viewportSetPlaybackLoop(loop));
  ipcMain.handle('bm:viewportSetDirectorPreview', (_e, directed: boolean) =>
    requireAddon().viewportSetDirectorPreview(directed),
  );
  ipcMain.handle('bm:viewportPlaybackState', () => requireAddon().viewportPlaybackState());
  ipcMain.handle('bm:viewportBuildTimeline', () => requireAddon().viewportBuildTimeline());

  // Inspection & Audit
  ipcMain.handle('bm:inspectAssembly', (_e, selection: number[], showAllJoints: boolean, checkGeometry: boolean) =>
    requireAddon().inspectAssembly(selection, showAllJoints, checkGeometry),
  );
  ipcMain.handle('bm:auditMotion', (_e, piece: number) => requireAddon().auditMotion(piece));

  // Native CLI exports (bmshot / bmexport)
  ipcMain.handle('bm:renderNativeStill', async (_e, opts: { width?: number; height?: number; samples?: number; pathTrace?: boolean }) => {
    const save = await dialog.showSaveDialog({
      title: 'Render Native Metal Still',
      defaultPath: 'brickmotion-render.png',
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (save.canceled || !save.filePath) {
      return { ok: false, exitCode: 0, stdout: '', stderr: 'Canceled' };
    }
    const projectBytes = requireAddon().sessionProjectBytes();
    const tmpProject = await writeTempProjectFile(projectBytes);
    const args = [tmpProject, '--out', save.filePath];
    if (opts?.width) args.push('--width', String(opts.width));
    if (opts?.height) args.push('--height', String(opts.height));
    if (opts?.pathTrace) args.push('--path-trace');
    if (opts?.samples) args.push('--samples', String(opts.samples));
    return runNativeCli(cliPaths.bmshot, args, save.filePath);
  });

  ipcMain.handle('bm:exportNativeSound', async (_e, opts: { style?: 'physics' | 'web'; webPreset?: string }) => {
    const save = await dialog.showSaveDialog({
      title: 'Export Native Snap Sound',
      defaultPath: 'brickmotion-sound.wav',
      filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
    });
    if (save.canceled || !save.filePath) {
      return { ok: false, exitCode: 0, stdout: '', stderr: 'Canceled' };
    }
    const projectBytes = requireAddon().sessionProjectBytes();
    const tmpProject = await writeTempProjectFile(projectBytes);
    const args = ['sound', tmpProject, '--out', save.filePath];
    if (opts?.style) args.push('--style', opts.style);
    if (opts?.style === 'web' && opts?.webPreset) args.push('--web-preset', opts.webPreset);
    return runNativeCli(cliPaths.bmexport, args, save.filePath);
  });

  ipcMain.handle('bm:exportNativeVideo', async (_e, opts: { width?: number; height?: number; fps?: number }) => {
    const save = await dialog.showSaveDialog({
      title: 'Export Native Metal Video',
      defaultPath: 'brickmotion-video.mp4',
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
    });
    if (save.canceled || !save.filePath) {
      return { ok: false, exitCode: 0, stdout: '', stderr: 'Canceled' };
    }
    const projectBytes = requireAddon().sessionProjectBytes();
    const tmpProject = await writeTempProjectFile(projectBytes);
    const args = ['video', tmpProject, '--out', save.filePath];
    if (opts?.width) args.push('--width', String(opts.width));
    if (opts?.height) args.push('--height', String(opts.height));
    if (opts?.fps) args.push('--fps', String(opts.fps));
    return runNativeCli(cliPaths.bmexport, args, save.filePath);
  });

  // Native File Dialogs
  ipcMain.handle('bm:openFileDialog', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Open BrickMotion Project or LDraw Model',
      properties: ['openFile'],
      filters: [
        { name: 'All Supported Models', extensions: ['brickmotion', 'mpd', 'ldr', 'dat', 'io', 'json'] },
        { name: 'BrickMotion Project', extensions: ['brickmotion'] },
        { name: 'LDraw Model', extensions: ['mpd', 'ldr', 'dat'] },
        { name: 'BrickLink Studio', extensions: ['io'] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return { canceled: true };
    const filePath = res.filePaths[0];
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const isBinary = ext === '.io';
    if (isBinary) {
      const buf = await fs.promises.readFile(filePath);
      return { canceled: false, filePath, fileName, isBinary: true, base64: buf.toString('base64') };
    }
    const content = await fs.promises.readFile(filePath, 'utf8');
    return { canceled: false, filePath, fileName, isBinary: false, content };
  });

  ipcMain.handle(
    'bm:saveFileDialog',
    async (
      _e,
      options: {
        defaultPath?: string;
        filters?: Array<{ name: string; extensions: string[] }>;
        content: string;
        encoding?: 'utf8' | 'base64';
      },
    ) => {
      const res = await dialog.showSaveDialog({
        title: 'Save File',
        defaultPath: options.defaultPath,
        filters: options.filters,
      });
      if (res.canceled || !res.filePath) return { canceled: true };
      if (options.encoding === 'base64') {
        await fs.promises.writeFile(res.filePath, Buffer.from(options.content, 'base64'));
      } else {
        await fs.promises.writeFile(res.filePath, options.content, 'utf8');
      }
      return { canceled: false, filePath: res.filePath };
    },
  );

  ipcMain.handle('bm:revealInFinder', (_e, filePath: string) => {
    shell.showItemInFolder(filePath);
  });
}

function registerAppProtocol() {
  const distDir = path.resolve(__dirname, '..', 'dist-renderer');
  const publicDir = path.resolve(__dirname, '..', '..', 'public');
  protocol.handle('bm', (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const inDist = path.join(distDir, rel);
    if (inDist.startsWith(distDir) && fs.existsSync(inDist) && fs.statSync(inDist).isFile()) {
      return net.fetch(pathToFileURL(inDist).toString());
    }
    const inPublic = path.join(publicDir, rel);
    if (inPublic.startsWith(publicDir) && fs.existsSync(inPublic) && fs.statSync(inPublic).isFile()) {
      return net.fetch(pathToFileURL(inPublic).toString());
    }
    return new Response('Not found', { status: 404 });
  });
}

app.whenReady().then(() => {
  registerAppProtocol();
  buildAppMenu();
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
