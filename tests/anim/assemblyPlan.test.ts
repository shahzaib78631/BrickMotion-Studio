import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { AnimOptions } from '../../src/anim/pacing';
import { parseAssemblyArtifact, type AssemblyArtifact } from '../../src/anim/assemblyPlan/artifact';
import { assemblyArtifactPlan } from '../../src/anim/assemblyPlan/construction';
import { compileConstruction } from '../../src/anim/construction/compile';
import { buildTimeline } from '../../src/anim/timeline';
import { decodeTimeline } from '../../src/anim/timelineCodec';
import { importLDraw } from '../../src/io/ldrawImport';
import { assemble, placementMatrix, unionBox, type Instance, type Metrics } from '../../src/model/assemble';
import { measurePart, type PartMetrics } from '../../src/ldraw/metrics';
import { PartLibrary } from '../../src/ldraw/library';
import { ensureIds } from '../../src/plan/ids';
import type { Box } from '../../src/ldraw/flatten';
import type { ColorDef } from '../../src/ldraw/colors';

const repository = join(__dirname, '..', '..');
const artifactPath = join(repository, 'tests', 'fixtures', 'assembly', '10156-1.assembly.json');
const modelPath = join(repository, 'tests', 'fixtures', 'models', '10156-1.mpd');
const hasFixture = existsSync(artifactPath) && existsSync(modelPath);

const artifactText = hasFixture ? readFileSync(artifactPath, 'utf8') : '';
const artifact = hasFixture ? (JSON.parse(artifactText) as AssemblyArtifact) : ({} as AssemblyArtifact);

/** A unit box piece placed by a column-major world matrix (like assemble produces). */
const metrics: Metrics = (part: string): PartMetrics =>
({
  id: part,
  body: { min: [-10, -24, -10], max: [10, 0, 10] },
  full: { min: [-10, -24, -10], max: [10, 0, 10] },
  mesh: new Float32Array(0),
  footprint: { w: 1, d: 1 },
  heightPlates: 1,
  placeholder: false,
  studs: [],
});

const colors = new Map<number, ColorDef>();

const instance = (key: string, part: string, world: number[]): Instance =>
({
  key,
  itemId: key,
  model: '',
  part,
  color: 16,
  world: new THREE.Matrix4().fromArray(world),
  worldBox: { min: [0, 0, 0], max: [0, 0, 0] },
  placeholder: false,
  grid: false,
});

describe('assembly artifact matching', () => {
  it('parses the real 10156 fixture', () => {
    if (!hasFixture) return;
    const parsed = parseAssemblyArtifact(JSON.parse(artifactText));
    expect(parsed.ok, parsed.ok ? '' : (parsed as { ok: false; errors: string[] }).errors.slice(0, 6).join('; ')).toBe(true);
    if (parsed.ok) {
      expect(parsed.artifact.pieces.length).toBe(111);
      expect(parsed.artifact.steps.length).toBe(111);
      expect(parsed.artifact.steps.every((s) => s.insertion && s.certificate?.clear)).toBe(true);
      expect(parsed.artifact.animation?.kind).toBe('flight-v1');
      expect(parsed.artifact.animation?.pieces.length).toBe(111);
    }
  });

  it('rejects a damaged artifact shape', () => {
    const wrongShape = parseAssemblyArtifact({ format: 'brickmotion-assembly-plan', version: 1, steps: 'no' });
    expect(wrongShape.ok).toBe(false);
    expect((wrongShape as { errors: string[] }).errors.length).toBeGreaterThan(0);
  });

  it('matches every 10156 piece to its studio instance by part and world positions', () => {
    if (!hasFixture) return;
    const plan = ensureIds(importLDraw(readFileSync(modelPath, 'utf8'), '10156-1.mpd'));
    const asm = assemble(plan, metrics, colors);
    const construction = assemblyArtifactPlan(artifact, asm);
    expect(construction.operations.length).toBe(111);
    expect(construction.parts.length).toBe(111);
    // every step of the artifact, in artifact order, becomes one operation
    construction.operations.forEach((op, i) => {
      const step = artifact.steps[i];
      expect(op.id).toBe(step.id);
      // authored flights carry the python waypoint path; plain artifacts keep
      // the single corridor start -> final pose ray
      expect(op.path.length).toBeGreaterThanOrEqual(2);
      expect(op.path[op.path.length - 1]).toEqual([0, 0, 0]);
    });
    // artifact tier vocabulary maps to the studio's construction contract
    expect(construction.schema).toBe('brickmotion-construction/v2');
  });

  it('compiles the 10156 artifact to a timeline and fails when the model moved', () => {
    if (!hasFixture) return;
    const plan = ensureIds(importLDraw(readFileSync(modelPath, 'utf8'), '10156-1.mpd'));
    const asm = assemble(plan, metrics, colors);
    const opts: AnimOptions = { targetSeconds: 10, heroOrbit: false, planner: 'assembly-artifact', assemblyPlan: artifact };
    const tl = buildTimeline(asm, metrics, opts);
    expect(tl.units.length).toBe(111);
    expect(tl.construction?.operations.length).toBe(111);
    expect(tl.fallback).toBeUndefined();
    // moving a piece invalidates every artifact claim; the loader fails loudly
    const shift = new THREE.Matrix4().makeTranslation(7, 0, 0);
    const moved = { ...asm, instances: asm.instances.map((inst, i) => (i === 0 ? { ...inst, world: new THREE.Matrix4().multiplyMatrices(shift, inst.world) } : inst)) };
    expect(() => buildTimeline(moved, metrics, opts)).toThrow(/does not match this model/);
  });

  it('rejects uncertified (stall-breaker) placements explicitly', () => {
    if (!hasFixture) return;
    const plan = ensureIds(importLDraw(readFileSync(modelPath, 'utf8'), '10156-1.mpd'));
    const asm = assemble(plan, metrics, colors);
    const uncertified: AssemblyArtifact = {
      ...artifact,
      pieces: artifact.pieces.map((p) => ({ ...p })),
      steps: artifact.steps.map((s, i) => (i === 5 ? { ...s, certificate: { ...(s.certificate ?? { kind: 'swept-aabb', frames: 32, margin: 1.5, clear: true }), clear: false }, blockers: ['other-piece'] } : s)),
    };
    expect(() => assemblyArtifactPlan(uncertified, asm)).toThrow(/not fully certified/);
  });

  it('detects a rotated placement from a moved model', () => {
    if (!hasFixture) return;
    const plan = ensureIds(importLDraw(readFileSync(modelPath, 'utf8'), '10156-1.mpd'));
    const asm = assemble(plan, metrics, colors);
    const rot = artifact.pieces.map((p, i) => (i === 3 ? { ...p, matrix: p.matrix.map((v, k) => (k === 0 ? -v : v)) } : p));
    expect(() => assemblyArtifactPlan({ ...artifact, pieces: rot }, asm)).toThrow(/rotated placement/);
  });
});

describe('compile of artifact construction plans', () => {
  it('compiles a small synthetic artifact to a timeline with staged rises', () => {
    if (!hasFixture) return;
    // two unit studs (a 1×1 brick at the top of each other) in the artifact space
    const worldA = new THREE.Matrix4().fromArray([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const worldB = new THREE.Matrix4().fromArray([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -24, 0, 1]);
    const instA = instance('a', '3005', worldA.elements);
    const instB = instance('b', '3005', worldB.elements);
    const boxOf = (world: THREE.Matrix4): Box => ({
      min: [-10, world.elements[13] - 24, -10],
      max: [10, world.elements[13], 10],
    });
    const asm = { nodes: [], instances: [instA, instB], bounds: null, problems: [] };
    const artifact: AssemblyArtifact = {
      format: 'brickmotion-assembly-plan',
      version: 1,
      model: 'synthetic',
      units: 'ldu',
      jointsCertain: 1,
      pieces: [
        { key: 'p/a', part: '3005.dat', color: 16, matrix: Array.from(worldA.elements) },
        { key: 'p/b', part: '3005.dat', color: 16, matrix: Array.from(worldB.elements) },
      ],
      joints: [{ id: 'j0', kind: 'snap', parent: 'p/a', child: 'p/b', axis: [0, 1, 0], confidence: 'snap', snap: null }],
      steps: [
        { id: 's1', pieces: ['p/a'], order: 0, dependsOn: [], insertion: { axis: [0, -1, 0], distance: 48, origin: [0, -24, 0], priority: '0', tier: 'snap' }, certificate: { kind: 'swept-aabb', frames: 32, margin: 1.5, clear: true, blockers: [] }, uncertified: false, reason: null },
        { id: 's2', pieces: ['p/b'], order: 1, dependsOn: [], insertion: { axis: [0, -1, 0], distance: 48, origin: [0, -48, 0], priority: '0', tier: 'snap' }, certificate: { kind: 'swept-aabb', frames: 32, margin: 1.5, clear: true, blockers: [] }, uncertified: false, reason: null },
      ],
      stats: { pieces: 2, certified: 2, ms: 1.2 },
    };
    const plan = assemblyArtifactPlan(artifact, asm);
    expect(plan.operations.map((op) => op.id)).toEqual(['s1', 's2']);
    // staged poses hold each piece one travel step away from its final pose
    const stagedA = plan.parts.find((p) => p.key === 'a')!;
    const stagedB = plan.parts.find((p) => p.key === 'b')!;
    expect(stagedA.staged[13]).toBeCloseTo(worldA.elements[13] + 48);
    expect(stagedB.staged[13]).toBeCloseTo(worldB.elements[13] + 48);
    expect(stagedA.final).toEqual(Array.from(worldA.elements));
    const withBoxes = {
      ...asm,
      instances: [instA, instB].map((inst) => ({ ...inst, worldBox: boxOf(inst.world) })),
    };
    const complete = assemblyArtifactPlan(artifact, withBoxes);
    const encoded = compileConstruction(complete, { targetSeconds: 8, heroOrbit: false });
    const timeline = decodeTimeline(encoded);
    expect(timeline.units.length).toBe(2);
    expect(timeline.steps.length).toBe(2);
    expect(timeline.ground).toBeCloseTo(0);
  });
});

describe('python-authored flight animation (flight-v1)', () => {
  const studio = () => {
    const plan = ensureIds(importLDraw(readFileSync(modelPath, 'utf8'), '10156-1.mpd'));
    return assemble(plan, metrics, colors);
  };

  it('drives units, staging and appears from the authored fractions', () => {
    if (!hasFixture || !artifact.animation) return;
    const anim = artifact.animation;
    const construction = assemblyArtifactPlan(artifact, studio());
    expect(construction.operations.every((op) => op.schedule !== undefined)).toBe(true);
    expect(construction.warnings.join(' ')).toContain('flight-v1');
    // staged pose = final + first flight waypoint
    const op0 = construction.operations[0];
    const part0 = construction.parts.find((p) => p.key === op0.keys[0])!;
    const stagedDelta = part0.staged.slice(12, 15).map((v, i) => v - part0.final.slice(12, 15)[i]);
    anim.pieces[0].path[0].forEach((v, i) => expect(stagedDelta[i]).toBeCloseTo(v, 3));
    // compile: build window = targetSeconds - intro - outro (1.0 / 0.5 by default)
    const target = 15, build = (target - 1.0 - 0.5);
    const encoded = compileConstruction(construction, { targetSeconds: target, heroOrbit: false });
    encoded.units.forEach((u, i) => {
      const piece = anim.pieces[i];
      expect(u.start).toBeCloseTo(1.0 + piece.startF * build, 2);
      expect(u.dur).toBeCloseTo(piece.durF * build, 2);
      expect(u.start).toBeGreaterThanOrEqual(1.0);
    });
    // last flight lands exactly at the end of the build window
    const last = encoded.units[encoded.units.length - 1];
    expect(last.start + last.dur).toBeCloseTo(1.0 + build, 2);
    // the first part materialises on its staging floor at its own appear time
    const key0 = encoded.units[0].keys[0];
    const track0 = encoded.tracks.find(([k]) => k === key0)![1];
    expect(track0.appear).toBeCloseTo(1.0 + anim.pieces[0].appearF * build, 2);
    expect(track0.moves.length).toBe(1);
  });

  it('renders the authored choreography with the buildTimeline integration', () => {
    if (!hasFixture || !artifact.animation) return;
    const tl = buildTimeline(studio(), metrics, { targetSeconds: 15, heroOrbit: false, planner: 'assembly-artifact', assemblyPlan: artifact });
    expect(tl.fallback).toBeUndefined();
    expect(tl.units.length).toBe(111);
    // no extra gaps: python already pressed them into the fractions
    let prev = -Infinity;
    for (const u of tl.units) {
      expect(u.start).toBeGreaterThanOrEqual(prev);
      prev = u.start + u.dur;
    }
  });

  it('falls back to corridor pacing when the animation block is damaged', () => {
    if (!hasFixture || !artifact.animation) return;
    const damaged: AssemblyArtifact = {
      ...artifact,
      animation: { ...artifact.animation, pieces: artifact.animation.pieces.map((p, i) => (i === 7 ? { ...p, route: false } : p)) },
    };
    const construction = assemblyArtifactPlan(damaged, studio());
    expect(construction.operations.every((op) => op.schedule === undefined)).toBe(true);
    expect(construction.operations.every((op) => op.path.length === 2)).toBe(true);
    expect(construction.warnings).toEqual([]);
    // and it still compiles end to end
    const encoded = compileConstruction(construction, { targetSeconds: 12, heroOrbit: false });
    expect(encoded.units.length).toBe(111);
  });
});
