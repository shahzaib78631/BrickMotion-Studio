/**
 * Shared pieces of the EyeSight render scripts: loading a model's geometry, Studio's own
 * command line, and running the renderer to a PNG.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { assemble, type Assembly, type Metrics } from '../../src/model/assemble';
import { PartLibrary } from '../../src/ldraw/library';
import { buildPartGeometry, type PartGeometry } from '../../src/ldraw/geometry';
import { parseLDConfig, type ColorDef } from '../../src/ldraw/colors';
import { shadowLookupFrom } from '../../src/ldraw/shadow';
import { measurePart } from '../../src/ldraw/metrics';
import type { Plan } from '../../src/plan/types';

export const ROOT = process.cwd();
export const LDRAW = join(ROOT, 'public', 'ldraw');
export const STUDIO = '/Applications/Studio 2.0/PhotoRealisticRenderer/mac';
/** The binary Studio itself launches. */
export const EYESIGHT = join(STUDIO, 'eyesight.app', 'Contents', 'MacOS', 'eyesight');

export type LoadedScene = {
  colors: ReadonlyMap<number, ColorDef>;
  geometry: Map<string, PartGeometry | null>;
  asm: Assembly;
};

/** Every part the plan uses, measured and meshed, and the assembled model. */
export async function loadScene(plan: Plan): Promise<LoadedScene> {
  if (!existsSync(join(LDRAW, 'parts'))) throw new Error('No parts library at public/ldraw. Run `npm run setup` first.');
  const colors = parseLDConfig(readFileSync(join(LDRAW, 'LDConfig.ldr'), 'utf8'));
  const shadowPath = join(ROOT, 'public', 'data', 'ldcad-shadow.json');
  const shadow = existsSync(shadowPath) ? shadowLookupFrom(JSON.parse(readFileSync(shadowPath, 'utf8')).files) : undefined;
  const lib = new PartLibrary(async (p) => {
    const f = join(LDRAW, p);
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  }, shadow);
  const metricsCache = new Map<string, ReturnType<typeof measurePart>>();
  const metrics = (part: string) => metricsCache.get(part) ?? measurePart(null, part);

  const parts = new Set<string>();
  const collect = (steps: { pieces: unknown[] }[]) => {
    for (const step of steps) for (const raw of step.pieces) {
      const p = raw as { part?: string };
      if (p.part) parts.add(p.part);
    }
  };
  collect(plan.steps);
  for (const sub of Object.values(plan.submodels ?? {})) collect(sub.steps);

  console.log(`… measuring ${parts.size} parts`);
  const geometry = new Map<string, PartGeometry | null>();
  for (const id of parts) {
    const flat = await lib.loadPart(id);
    if (!flat) { console.warn(`  missing part file: ${id}`); continue; }
    metricsCache.set(id, measurePart(flat, id));
    geometry.set(id, buildPartGeometry(flat));
  }
  const asm = assemble(plan, metrics as Metrics, colors);
  return { colors, geometry, asm };
}

export type RenderOpts = {
  width: number; height: number; samples: number;
  /** Studio's light preset (BUILD_FL, BUILD_FR, BUILD_RL, BUILD_RR, MECHANIC_*, DEFAULT, NO_LIGHT) or 'dae' to use the lights in the file */
  light: string; lightRotZ: number; lightIntensity: number;
  /** backdrop colour, 0–1 */
  bg: [number, number, number];
};

export const DEFAULT_RENDER: RenderOpts = { width: 1080, height: 1920, samples: 128, light: 'BUILD_FL', lightRotZ: 0, lightIntensity: 0.7, bg: [1, 1, 1] };

/**
 * The command line Studio itself runs (from ~/.local/share/Stud.io/RenderTemp/log): its default
 * "Building / front-left" lighting is a named preset the renderer applies, not lights in the .dae.
 * Winding is counter-clockwise (three.js) where Studio's own files are clockwise; the wrong one
 * renders every face dark.
 */
export function studioArgs(o: RenderOpts, dae: string, png: string): string[] {
  const light = o.light === 'dae' ? [] : ['--defaultlight', '--preset', o.light, '--light-rotz', String(o.lightRotZ), '--light-intensity', String(o.lightIntensity)];
  return [
    '--daewindingorder', 'counterclockwise', '--autoexit', '--dae-overlap-tolerant', '--device', 'CPU',
    '--width', String(o.width), '--height', String(o.height), '--samples', String(o.samples),
    '--shadow-ground', '--param', '0', o.bg.join(' '),
    ...light,
    '--daefile', dae, '--output', png,
    join(STUDIO, 'settings_v1.xml'), join(STUDIO, 'LEGO_StudioSet.xml'),
  ];
}

/** Runs EyeSight on a .dae until the PNG is written. */
export function runEyesight(o: RenderOpts, dae: string, png: string, quiet = false): Promise<void> {
  if (!existsSync(EYESIGHT)) return Promise.reject(new Error(`EyeSight not found at ${EYESIGHT}. Install BrickLink Studio, or copy the renderer there.`));
  return new Promise<void>((done, fail) => {
    const child = spawn(EYESIGHT, studioArgs(o, dae, png), { cwd: STUDIO, stdio: quiet ? 'ignore' : 'inherit' });
    const started = Date.now();
    const deadline = started + 30 * 60 * 1000;
    const poll = setInterval(() => {
      if (existsSync(png) && statSync(png).mtimeMs >= started - 1000) {
        clearInterval(poll);
        // the binary never exits by itself (a mutex bug after saving); reap it a moment later
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } done(); }, 1500);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        fail(new Error('EyeSight timed out after 30 minutes'));
      }
    }, 500);
    child.on('exit', () => {
      setTimeout(() => {
        clearInterval(poll);
        if (existsSync(png)) done();
        else fail(new Error(`EyeSight exited (code ${child.exitCode}) without an image`));
      }, 800);
    });
  });
}

