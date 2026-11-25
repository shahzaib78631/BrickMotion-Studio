import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { EngineInfo, NativeCliResult } from './types';

const execFileAsync = promisify(execFile);

export interface RawNativeAddon {
  engineInfo(): { version: string; ldrawDir: string; metalAvailable: boolean };
  sessionNewBlank(): any;
  sessionOpenFile(filePath: string): any;
  sessionOpenBytes(bytes: string, virtualPath: string): any;
  sessionProjectBytes(): string;
  sessionMpdBytes(): string;
  sessionSnapshot(): any;
  sessionOutline(): any[];
  sessionSteps(): any[];
  sessionColors(): any[];
  sessionSearchParts(query: string, limit: number): any[];
  sessionUndo(): any;
  sessionRedo(): any;
  sessionSelect(pieces: number[], mode: string): boolean;
  sessionSelectAll(): boolean;
  sessionSelectNone(): boolean;
  sessionHide(pieces: number[]): boolean;
  sessionShowAll(): boolean;
  sessionRecolor(pieces: number[], colorCode: number): any;
  sessionRemove(pieces: number[]): any;
  sessionMove(pieces: number[], dx: number, dy: number, dz: number, continuing: boolean): any;
  sessionFocus(path: string[]): any;
  viewportResize(width: number, height: number, scale: number): boolean;
  viewportSetBackground(r: number, g: number, b: number): boolean;
  viewportSetPreferences(prefs: any): boolean;
  viewportSetViewStyle(style: string): boolean;
  viewportSetOrthographic(enabled: boolean): boolean;
  viewportRenderFrame(): { width: number; height: number; needsMore: boolean; rgba: Buffer };
  viewportNeedsDraw(): boolean;
  viewportOrbit(dx: number, dy: number): boolean;
  viewportPan(dx: number, dy: number): boolean;
  viewportZoom(factor: number): boolean;
  viewportZoomToward(factor: number, x: number, y: number): boolean;
  viewportFitAll(): boolean;
  viewportFrameSelection(): boolean;
  viewportCenterOnFloor(): boolean;
  viewportViewPreset(preset: string): boolean;
  viewportCamera(): any;
  viewportPick(x: number, y: number): number | null;
  viewportMarquee(x0: number, y0: number, x1: number, y1: number, touching: boolean): number[];
  viewportRequestPlan(): boolean;
  viewportRegeneratePlan(standardPreview: boolean): boolean;
  viewportPlay(on: boolean): boolean;
  viewportSeek(seconds: number): boolean;
  viewportShowRest(): boolean;
  viewportSetPlaybackRate(rate: number): boolean;
  viewportSetPlaybackLoop(loop: boolean): boolean;
  viewportSetDirectorPreview(directed: boolean): boolean;
  viewportPlaybackState(): any;
  viewportBuildTimeline(): any;
  inspectAssembly(selection: number[], showAllJoints: boolean, checkGeometry: boolean): any;
  auditMotion(piece: number): any;
}

const projectRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(projectRoot, '..');
const nativeBuildDir = process.env.BM_NATIVE_BUILD || path.join(repoRoot, 'native', 'build-app');

export const cliPaths = {
  bm: path.join(nativeBuildDir, 'tools', 'bm', 'bm'),
  bmshot: path.join(nativeBuildDir, 'render', 'bmshot'),
  bmexport: path.join(nativeBuildDir, 'render', 'bmexport'),
};

let cachedAddon: RawNativeAddon | null = null;
let addonLoadError: string | undefined;

export function getNativeAddon(): RawNativeAddon | null {
  if (cachedAddon) return cachedAddon;
  if (addonLoadError) return null;

  const addonPath = path.join(projectRoot, 'addon', 'build', 'bm_native.node');
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedAddon = require(addonPath) as RawNativeAddon;
    return cachedAddon;
  } catch (err) {
    addonLoadError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

export function getEngineInfo(): EngineInfo {
  const addon = getNativeAddon();
  const cliAvailable = {
    bm: fs.existsSync(cliPaths.bm),
    bmshot: fs.existsSync(cliPaths.bmshot),
    bmexport: fs.existsSync(cliPaths.bmexport),
  };
  if (!addon) {
    return {
      available: false,
      version: 'unavailable',
      ldrawDir: path.join(repoRoot, 'public', 'ldraw'),
      metalAvailable: false,
      addonError: addonLoadError,
      cliAvailable,
    };
  }
  const info = addon.engineInfo();
  return {
    available: true,
    version: info.version,
    ldrawDir: info.ldrawDir,
    metalAvailable: info.metalAvailable,
    cliAvailable,
  };
}

export async function writeTempProjectFile(projectBytes: string, ext = '.brickmotion'): Promise<string> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bm-electron-'));
  const filePath = path.join(tmpDir, `scene${ext}`);
  await fs.promises.writeFile(filePath, projectBytes, 'utf8');
  return filePath;
}

export async function runNativeCli(
  binaryPath: string,
  args: string[],
  outputPath?: string,
): Promise<NativeCliResult> {
  if (!fs.existsSync(binaryPath)) {
    return {
      ok: false,
      exitCode: -1,
      stdout: '',
      stderr: `Native binary not found at ${binaryPath}`,
    };
  }
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        BM_LDRAW_DIR: process.env.BM_LDRAW_DIR || path.join(repoRoot, 'public', 'ldraw'),
      },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, exitCode: 0, stdout, stderr, outputPath };
  } catch (err: any) {
    return {
      ok: false,
      exitCode: typeof err?.code === 'number' ? err.code : 1,
      stdout: err?.stdout ?? '',
      stderr: err?.stderr ?? (err instanceof Error ? err.message : String(err)),
      outputPath,
    };
  }
}
