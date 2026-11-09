/**
 * Renders a BrickMotion project with BrickLink Studio's own photorealistic engine
 * (EyeSight), using the project's saved camera and Studio's material library.
 *
 *   npm run render:eyesight -- "Hellboy.brickmotion"
 *   npm run render:eyesight -- model.brickmotion --width 1080 --height 1920 --samples 128
 *   npm run render:eyesight -- model.brickmotion --dae-only      # just the COLLADA file
 *   npm run render:eyesight -- model.brickmotion --light BUILD_FR --light-rotz 40 --bg 0.8 0.8 0.8
 *
 * The COLLADA file comes from the app's own exporter (src/export/collada.ts) in Studio's
 * row-major matrix dialect, so geometry, camera and rig share one coordinate space and
 * materials are named the way settings_v1.xml expects (SOLID-RED, …).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import * as THREE from 'three';
import { assemble, type Metrics } from '../src/model/assemble';
import { PartLibrary } from '../src/ldraw/library';
import { buildPartGeometry, type PartGeometry } from '../src/ldraw/geometry';
import { parseLDConfig } from '../src/ldraw/colors';
import { shadowLookupFrom } from '../src/ldraw/shadow';
import { measurePart } from '../src/ldraw/metrics';
import { buildCollada, type ColladaLight, type ColladaPiece } from '../src/export/collada';
import type { Plan } from '../src/plan/types';

const ROOT = process.cwd();
const LDRAW = join(ROOT, 'public', 'ldraw');
const STUDIO = '/Applications/Studio 2.0/PhotoRealisticRenderer/mac';

type Args = {
  project: string; out?: string; width: number; height: number; samples: number; daeOnly: boolean; fit: boolean;
  /** Studio's light preset (BUILD_FL, BUILD_FR, BUILD_RL, BUILD_RR, MECHANIC_*, DEFAULT, NO_LIGHT) or 'dae' to write our own rig into the file */
  light: string; lightRotZ: number; lightIntensity: number; bg: [number, number, number];
};

function parseArgs(argv: string[]): Args {
  const a: Args = { project: '', width: 1080, height: 1920, samples: 128, daeOnly: false, fit: false, light: 'BUILD_FL', lightRotZ: 0, lightIntensity: 0.7, bg: [1, 1, 1] };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--out') a.out = argv[++i];
    else if (v === '--width') a.width = Number(argv[++i]);
    else if (v === '--height') a.height = Number(argv[++i]);
    else if (v === '--samples') a.samples = Number(argv[++i]);
    else if (v === '--dae-only') a.daeOnly = true;
    else if (v === '--fit') a.fit = true;
    else if (v === '--light') a.light = argv[++i];
    else if (v === '--light-rotz') a.lightRotZ = Number(argv[++i]);
    else if (v === '--light-intensity') a.lightIntensity = Number(argv[++i]);
    else if (v === '--bg') a.bg = [Number(argv[++i]), Number(argv[++i]), Number(argv[++i])];
    else if (!v.startsWith('--')) positional.push(v);
  }
  a.project = positional[0] ?? '';
  return a;
}

type ProjectJson = { format?: string; plan: Plan };

/** Studio's DEFAULT preset, written into the file when `--light dae` is used (subject→lamp, app world). Studio itself ships lights by name instead (see below). */
const RIG: ColladaLight[] = [
  { name: 'Key', dir: [-0.569, 0.499, -0.653], size: 0.1, intensity: 2.0 },
  { name: 'Fill', dir: [0.875, 0.338, 0.347], size: 0.5, intensity: 1.5 },
  { name: 'Rim', dir: [-0.608, 0.653, 0.452], size: 0.2, intensity: 1.0 },
  // "Hemi.003": ambient, colour 0.01 × strength 1
  { name: 'Ambient', type: 'ambient', dir: [0, 1, 0], size: 0, intensity: 0.01 },
];

/**
 * The command line Studio itself runs (from ~/.local/share/Stud.io/RenderTemp/log): its default
 * "Building / front-left" lighting is a named preset the renderer applies, not lights in the .dae.
 * Winding is counter-clockwise (three.js) where Studio's own files are clockwise; the wrong one
 * renders every face dark.
 */
function studioArgs(a: Args, dae: string, png: string): string[] {
  const light = a.light === 'dae' ? [] : ['--defaultlight', '--preset', a.light, '--light-rotz', String(a.lightRotZ), '--light-intensity', String(a.lightIntensity)];
  return [
    '--daewindingorder', 'counterclockwise', '--autoexit', '--dae-overlap-tolerant', '--device', 'CPU',
    '--width', String(a.width), '--height', String(a.height), '--samples', String(a.samples),
    '--shadow-ground', '--param', '0', a.bg.join(' '),
    ...light,
    '--daefile', dae, '--output', png,
    join(STUDIO, 'settings_v1.xml'), join(STUDIO, 'LEGO_StudioSet.xml'),
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) {
    console.error('Usage: npm run render:eyesight -- <project.brickmotion> [--width 1080 --height 1920 --samples 128 --dae-only]');
    process.exit(1);
  }
  const projectPath = resolve(args.project);
  const json = JSON.parse(readFileSync(projectPath, 'utf8')) as ProjectJson;
  if (json.format !== 'brickmotion-project') {
    console.error(`${projectPath} is not a BrickMotion project (format "${json.format}")`);
    process.exit(1);
  }
  if (!existsSync(join(LDRAW, 'parts'))) {
    console.error('No parts library at public/ldraw. Run `npm run setup` first.');
    process.exit(1);
  }

  // --- model ---------------------------------------------------------------
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
  collect(json.plan.steps);
  for (const sub of Object.values(json.plan.submodels ?? {})) collect(sub.steps);

  console.log(`… measuring ${parts.size} parts`);
  const geometry = new Map<string, PartGeometry | null>();
  for (const id of parts) {
    const flat = await lib.loadPart(id);
    if (!flat) { console.warn(`  missing part file: ${id}`); continue; }
    metricsCache.set(id, measurePart(flat, id));
    geometry.set(id, buildPartGeometry(flat));
  }
  const asm = assemble(json.plan, metrics as Metrics, colors);
  const pieces: ColladaPiece[] = asm.instances
    .filter((i) => !i.placeholder && geometry.has(i.part))
    .map((i) => ({ key: i.key, part: i.part, color: i.color, world: i.world }));
  console.log(`… ${pieces.length} pieces${asm.instances.length !== pieces.length ? ` (${asm.instances.length - pieces.length} skipped)` : ''}`);

  // --- camera --------------------------------------------------------------
  const setup = (json.plan as unknown as { sceneSetup?: { cameras?: { id: string; position: number[]; target: number[]; fov: number; near: number; far: number }[]; activeCameraId?: string } }).sceneSetup;
  const saved = setup?.cameras?.find((c) => c.id === setup.activeCameraId) ?? setup?.cameras?.[0];
  if (!saved) {
    console.error('The project has no saved camera (Scene tools → Add camera).');
    process.exit(1);
  }

  const w = Math.max(16, Math.round(args.width));
  const h = Math.max(16, Math.round(args.height));
  const out = args.out ? resolve(args.out) : join(dirname(projectPath), `${basename(projectPath).replace(/\.brickmotion$/i, '')}-eyesight`);
  mkdirSync(out, { recursive: true });
  const daePath = join(out, 'scene.dae');

  // --fit keeps the saved camera's direction but frames the model tightly, like the app's
  // "fit to model": a portrait frame fits the bounding sphere of the LDU bounds (studs = LDU/20).
  let eye = new THREE.Vector3(...saved.position);
  let target = new THREE.Vector3(...saved.target);
  if (args.fit && asm.bounds) {
    const b = asm.bounds;
    const center = new THREE.Vector3((b.min[0] + b.max[0]) / 40, -(b.min[1] + b.max[1]) / 40, -(b.min[2] + b.max[2]) / 40);
    const size = new THREE.Vector3((b.max[0] - b.min[0]) / 20, (b.max[1] - b.min[1]) / 20, (b.max[2] - b.min[2]) / 20);
    const dir = eye.clone().sub(target).normalize();
    const radius = Math.max(1, 0.5 * size.length());
    const distance = (radius / Math.tan((saved.fov * Math.PI) / 360)) * 1.15;
    target = center;
    eye = center.clone().addScaledVector(dir, distance);
  }

  const dae = buildCollada({
    name: basename(projectPath),
    pieces,
    geometryOf: (id) => geometry.get(id) ?? null,
    colors,
    camera: {
      position: eye,
      target,
      fov: saved.fov, near: saved.near, far: saved.far, width: w, height: h,
    },
    lights: args.light === 'dae' ? RIG : [],
    matrixOrder: 'row', // EyeSight reads Studio's row-major dialect
  });
  writeFileSync(daePath, dae);
  console.log(`✓ ${daePath} (${(dae.length / 1024 / 1024).toFixed(1)} MB, ${pieces.length} pieces)`);
  if (args.daeOnly) return;

  // --- render --------------------------------------------------------------
  const eyesight = join(STUDIO, 'eyesight.app', 'Contents', 'MacOS', 'eyesight'); // the binary Studio itself launches
  if (!existsSync(eyesight)) {
    console.error(`EyeSight not found at ${eyesight}. Install BrickLink Studio, or copy the renderer there.`);
    process.exit(1);
  }
  const png = join(out, 'render.png');
  console.log(`… rendering ${w}×${h} (EyeSight, ${args.samples} samples)`);
  await new Promise<void>((done, fail) => {
    const child = spawn(eyesight, studioArgs(args, daePath, png), { cwd: STUDIO, stdio: 'inherit' });
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
    }, 1500);
    child.on('exit', () => {
      setTimeout(() => {
        clearInterval(poll);
        if (existsSync(png)) done();
        else fail(new Error(`EyeSight exited (code ${child.exitCode}) without an image`));
      }, 800);
    });
  });
  console.log(`✓ ${png} (${(readFileSync(png).length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
