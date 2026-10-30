/**
 * Scores the mechanism detector against a hand-checked list of the
 * mechanisms a real model actually has (benchmarks/mechanisms/*.expected.json).
 *
 * Pure: takes an assembly and the detector's LabReport, never re-runs the
 * detector, so the same scorer measures every detector change. Parts are
 * located by part number + world position, so internal ids can change.
 */
import type { Assembly } from '../../../model/assemble';
import * as THREE from 'three';
import { solveLabFrame, type LabReport } from '../v4/mechanismLab';
import { MechanismSolver } from '../v4/mechanismSolver';
import type { SuggestedMechanism } from '../v4/autoMechanics';
import type { MechanismEdge } from '../v4/mechanismGraph';

type V3 = [number, number, number];
export type PartRef = { part: string; at: V3 };
export type BenchmarkCheck =
  | { type: 'rotates' | 'slides'; label: string; part: PartRef; axis: V3 }
  | { type: 'gearMesh'; label: string; a: PartRef; b: PartRef; kind: 'spur' | 'bevel'; ratio?: number }
  | { type: 'rackPinion'; label: string; pinion: PartRef; rack: PartRef }
  | { type: 'suggested'; label: string; parts: PartRef[] }
  /** A link carried between two arms that pivot on a common frame (steering
   * tie rod, parallelogram lift): it moves on an arc, not along a slide. */
  | { type: 'fourBar'; label: string; coupler: PartRef; arms: [PartRef, PartRef]; axis: V3 }
  /** A whole function: a suggestion named as one of `kinds`, driven at `driver`,
   * must move every `moves` part and leave every `stays` part where it is. */
  | { type: 'function'; label: string; kinds: string[]; driver: PartRef; moves: PartRef[]; stays?: PartRef[] };
export type ExpectedMechanism = {
  id: string; title: string; evidence: 'posed' | 'geometry' | 'review'; why?: string;
  /** Spec phase that is expected to find it (default 3); later phases are scored apart. */
  phase?: number;
  checks: BenchmarkCheck[];
};
export type BenchmarkSpec = {
  schema: 'brickmotion-mechanism-benchmark-1';
  model: { name: string; file: string; sha256?: string };
  toleranceLdu?: number;
  mechanisms: ExpectedMechanism[];
};

/**
 * hit           – detected as expected
 * wrong-motion  – a joint with the right axis exists, but with another motion
 *                 (e.g. an axle reported as sliding when it should turn)
 * rejected      – the detector considered it and turned it down
 * missing       – no trace of it
 * unresolved    – the benchmark file points at a part that is not there
 */
export type CheckStatus = 'hit' | 'wrong-motion' | 'rejected' | 'missing' | 'unresolved';
export type CheckResult = { mechanism: string; type: BenchmarkCheck['type']; label: string; status: CheckStatus; detail: string };
export type BenchmarkResult = {
  model: string;
  checks: CheckResult[];
  mechanisms: { id: string; title: string; evidence: string; hit: number; total: number }[];
  score: { hit: number; total: number; recall: number; mechanismsComplete: number; mechanisms: number };
  /** Checks by the phase expected to find them. */
  byPhase: Record<number, { hit: number; total: number }>;
  noise: {
    movableEdges: number;
    byMotion: Record<string, number>;
    byType: Record<string, number>;
    suggestions: number;
    /** Suggestions whose driven parts belong to no expected mechanism. */
    unrelatedSuggestions: number;
  };
};

const centre = (b: { min: readonly number[]; max: readonly number[] }): V3 =>
  [0, 1, 2].map(i => (b.min[i] + b.max[i]) / 2) as V3;
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const unit = (v: readonly number[]): V3 => { const l = Math.hypot(...v) || 1; return v.map(x => x / l) as V3; };
/** Axes are lines: opposite directions count as the same axis. */
const sameAxis = (a: readonly number[], b: readonly number[], minDot = 0.95) => {
  const u = unit(a), w = unit(b);
  return Math.abs(u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) >= minDot;
};
const bare = (part: string) => part.toLowerCase().replace(/\.dat$/, '').replace(/^.*[\\/]/, '');

export function scoreMechanismBenchmark(spec: BenchmarkSpec, asm: Assembly, report: LabReport): BenchmarkResult {
  const tol = spec.toleranceLdu ?? 12;
  const resolve = (ref: PartRef): string | null => {
    let best: { key: string; d: number } | null = null;
    for (const inst of asm.instances) {
      if (bare(inst.part) !== bare(ref.part)) continue;
      const d = dist(centre(inst.worldBox), ref.at);
      if (d <= tol && (!best || d < best.d)) best = { key: inst.key, d };
    }
    return best?.key ?? null;
  };
  const clusterOf = new Map<string, readonly string[]>();
  for (const c of report.graph.rigidClusters) for (const k of c) clusterOf.set(k, c);
  /** Edges that let this part (or what it is welded to) move against something else. */
  const edgesFor = (key: string): MechanismEdge[] => {
    const cluster = new Set(clusterOf.get(key) ?? [key]);
    return report.graph.edges.filter(e => e.motion !== 'fixed' &&
      (cluster.has(e.a) !== cluster.has(e.b)));
  };
  const pairIs = (x: string, y: string, a: string, b: string) => (x === a && y === b) || (x === b && y === a);
  const fmt = (r: PartRef) => `${r.part}@[${r.at.join(',')}]`;

  /**
   * Coupler and both arms are separate bodies; each arm reaches the coupler
   * through joints that all turn (or slide) about the loop axis, and both arms
   * turn about that axis against one shared frame body.
   */
  const fourBar = (coupler: string, arms: [string, string], axis: V3): { ok: boolean; detail: string } => {
    const body = (k: string) => clusterOf.get(k) ?? [k];
    const id = (k: string) => body(k)[0];
    const onAxis = report.graph.edges.filter(e => e.motion !== 'fixed' && sameAxis(e.axis, axis) && id(e.a) !== id(e.b));
    const near = (k: string) => new Set(onAxis.flatMap(e => id(e.a) === id(k) ? [id(e.b)] : id(e.b) === id(k) ? [id(e.a)] : []));
    if (new Set([id(coupler), ...arms.map(id)]).size !== 3) return { ok: false, detail: 'coupler and arms are welded together' };
    // Arm to coupler: directly, or through one connector (an axle pin) that only turns/slides on the axis.
    const reaches = (arm: string) => { const n = near(arm); return n.has(id(coupler)) || [...n].some(m => near(m).has(id(coupler))); };
    const unreached = arms.filter(a => !reaches(a));
    if (unreached.length) return { ok: false, detail: `no joint chain on the loop axis from ${unreached.join(', ')} to the coupler` };
    const pivots = (arm: string) => new Set(onAxis.filter(e => e.motion === 'revolute' && (id(e.a) === id(arm) || id(e.b) === id(arm)))
      .map(e => id(e.a) === id(arm) ? id(e.b) : id(e.a)));
    const [p, q] = arms.map(pivots);
    const frame = [...p].find(f => q.has(f) && f !== id(coupler));
    return frame ? { ok: true, detail: `four-bar loop: frame ${frame} – arms ${arms.join(', ')} – coupler ${coupler}` }
      : { ok: false, detail: 'arms do not pivot on a shared frame body' };
  };

  const cluster = (k: string) => new Set(clusterOf.get(k) ?? [k]);
  const label = (k: string) => { const i = asm.instances.find(x => x.key === k); return i ? bare(i.part) : k; };
  /** Drive the suggestion to both ends of its travel and see what moves. */
  const functionVerdict = (s: SuggestedMechanism, driver: string, moves: string[], stays: string[]): { ok: boolean; detail: string } => {
    const p = s.program, joint = p.joints.find(j => j.id === p.driver.joint);
    if (!joint) return { ok: false, detail: 'driver joint missing' };
    const driven = new Set([joint.body, ...(p.rigidFollowers ?? []).filter(f => f.leader === joint.body).flatMap(f => f.bodies)]);
    if (![...cluster(driver)].some(k => driven.has(k))) return { ok: false, detail: `driven at ${label(joint.body)}, not at ${label(driver)}` };
    const moved = new Map<string, number>();
    try {
      const solver = new MechanismSolver(asm, p);
      for (const end of [1, -1]) {
        solver.assembled();
        let poses = new Map<string, THREE.Matrix4>();
        for (let i = 1; i <= 8; i++) poses = solveLabFrame(solver, end * p.driver.amplitude * i / 8);
        for (const k of [...moves, ...stays]) moved.set(k, Math.max(moved.get(k) ?? 0, motionOf(k, poses, solver.rest)));
      }
    } catch (e) { return { ok: false, detail: `does not solve: ${(e as Error).message}` }; }
    const still = moves.filter(k => moved.get(k)! < 1);
    if (still.length) return { ok: false, detail: `${still.map(label).join(', ')} did not move` };
    const wrong = stays.filter(k => moved.get(k)! >= 1);
    if (wrong.length) return { ok: false, detail: `${wrong.map(label).join(', ')} moved but should stay` };
    return { ok: true, detail: '' };
  };
  /** Motion score of one part: LDU its box centre travels, or degrees it turns, whichever is larger (1 = moved). */
  const motionOf = (k: string, poses: ReadonlyMap<string, THREE.Matrix4>, rest: ReadonlyMap<string, THREE.Matrix4>) => {
    const pose = poses.get(k), r = rest.get(k), inst = asm.instances.find(i => i.key === k);
    if (!pose || !r || !inst) return 0;
    const delta = pose.clone().multiply(r.clone().invert()), c = new THREE.Vector3(...centre(inst.worldBox));
    const travel = c.clone().applyMatrix4(delta).distanceTo(c);
    const q = new THREE.Quaternion().setFromRotationMatrix(delta), turn = 2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180 / Math.PI;
    return Math.max(travel / 0.5, turn);
  };

  const results: CheckResult[] = [];
  const expectedParts = new Set<string>();
  for (const mech of spec.mechanisms) {
    for (const check of mech.checks) {
      const push = (status: CheckStatus, detail: string) =>
        results.push({ mechanism: mech.id, type: check.type, label: check.label, status, detail });
      if (check.type === 'rotates' || check.type === 'slides') {
        const key = resolve(check.part);
        if (!key) { push('unresolved', `no ${fmt(check.part)} within ${tol} LDU`); continue; }
        expectedParts.add(key);
        const want = check.type === 'rotates' ? ['revolute'] : ['sliding'];
        const aligned = edgesFor(key).filter(e => sameAxis(e.axis, check.axis));
        const good = aligned.find(e => want.includes(e.motion));
        if (good) push('hit', `${good.type} ${good.motion} joint ${good.a} ↔ ${good.b}`);
        else if (aligned.length) push('wrong-motion', `found ${[...new Set(aligned.map(e => `${e.type}/${e.motion}`))].join(', ')} on this axis, wanted ${want[0]}`);
        else push('missing', `no movable joint on axis [${check.axis.join(',')}] (${edgesFor(key).length} on other axes)`);
      } else if (check.type === 'gearMesh' || check.type === 'rackPinion') {
        const [ra, rb] = check.type === 'gearMesh' ? [check.a, check.b] : [check.pinion, check.rack];
        const a = resolve(ra), b = resolve(rb);
        if (!a || !b) { push('unresolved', `cannot find ${!a ? fmt(ra) : fmt(rb)}`); continue; }
        expectedParts.add(a); expectedParts.add(b);
        const mesh = check.type === 'gearMesh' && report.detection.gearMeshes.find(m => pairIs(m.a, m.b, a, b));
        const geo = report.geometryCandidates.find(c => pairIs(c.a, c.b, a, b) &&
          (check.type === 'gearMesh' ? c.kind === (check.kind === 'bevel' ? 'bevel' : 'gear') : c.kind === 'rack-pinion'));
        if (mesh) push('hit', `gear mesh ${mesh.teethA}:${mesh.teethB}`);
        else if (geo?.status === 'plausible') push('hit', `geometry screen: plausible ${geo.kind}`);
        else if (geo) push('rejected', `geometry screen rejected: ${geo.reasons.join('; ')}`);
        else push('missing', check.type === 'gearMesh' ? `no ${check.kind} mesh considered` : 'no rack-and-pinion considered');
      } else if (check.type === 'fourBar') {
        const coupler = resolve(check.coupler), arms = check.arms.map(resolve);
        const lost = [check.coupler, ...check.arms][[coupler, ...arms].indexOf(null)];
        if (lost) { push('unresolved', `cannot find ${fmt(lost)}`); continue; }
        [coupler!, ...arms as string[]].forEach(k => expectedParts.add(k));
        const verdict = fourBar(coupler!, arms as [string, string], check.axis);
        push(verdict.ok ? 'hit' : 'missing', verdict.detail);
      } else if (check.type === 'function') {
        const refs = [check.driver, ...check.moves, ...(check.stays ?? [])], keys = refs.map(resolve);
        const lost = keys.indexOf(null);
        if (lost >= 0) { push('unresolved', `cannot find ${fmt(refs[lost])}`); continue; }
        const [driver, ...rest] = keys as string[], moves = rest.slice(0, check.moves.length), stays = rest.slice(check.moves.length);
        [driver, ...moves].forEach(k => expectedParts.add(k));
        const named = report.detection.suggestions.filter(s => s.mechanism && check.kinds.includes(s.mechanism.kind));
        if (!named.length) { push('missing', `no suggestion named ${check.kinds.join(' / ')}`); continue; }
        const why: string[] = [];
        const good = named.find(s => {
          const v = functionVerdict(s, driver, moves, stays);
          if (!v.ok) why.push(`"${s.title}": ${v.detail}`);
          return v.ok;
        });
        if (good) push('hit', `${good.mechanism!.kind} "${good.title}" moves every expected part`);
        else push('missing', why.join('; '));
      } else if (check.type === 'suggested') {
        const keys = check.parts.map(resolve);
        if (keys.some(k => !k)) { push('unresolved', `cannot find ${fmt(check.parts[keys.indexOf(null)])}`); continue; }
        const want = new Set(keys as string[]);
        for (const k of want) expectedParts.add(k);
        const hit = report.detection.suggestions.find(s => s.program.joints.some(j => want.has(j.body)) ||
          (s.program.rigidFollowers ?? []).some(f => want.has(f.leader) || f.bodies.some(b => want.has(b))));
        if (hit) push('hit', `suggested as "${hit.title}"`);
        else push('missing', `${report.detection.suggestions.length} suggestions, none drive these parts`);
      }
    }
  }

  const mechanisms = spec.mechanisms.map(m => {
    const mine = results.filter(r => r.mechanism === m.id);
    return { id: m.id, title: m.title, evidence: m.evidence, hit: mine.filter(r => r.status === 'hit').length, total: mine.length };
  });
  const hit = results.filter(r => r.status === 'hit').length;
  const byPhase: BenchmarkResult['byPhase'] = {};
  for (const m of spec.mechanisms) {
    const phase = m.phase ?? 3, mine = results.filter(r => r.mechanism === m.id), b = byPhase[phase] ??= { hit: 0, total: 0 };
    b.hit += mine.filter(r => r.status === 'hit').length; b.total += mine.length;
  }
  const movable = report.graph.edges.filter(e => e.motion !== 'fixed');
  const tally = (xs: string[]) => xs.reduce<Record<string, number>>((o, x) => (o[x] = (o[x] ?? 0) + 1, o), {});
  const expandedExpected = new Set([...expectedParts].flatMap(k => [...(clusterOf.get(k) ?? [k])]));
  const unrelated = report.detection.suggestions.filter(s =>
    !s.program.joints.some(j => expandedExpected.has(j.body))).length;
  return {
    model: spec.model.name,
    checks: results,
    mechanisms,
    byPhase,
    score: { hit, total: results.length, recall: results.length ? hit / results.length : 0,
      mechanismsComplete: mechanisms.filter(m => m.hit === m.total).length, mechanisms: mechanisms.length },
    noise: {
      movableEdges: movable.length,
      byMotion: tally(movable.map(e => e.motion)),
      byType: tally(movable.map(e => e.type)),
      suggestions: report.detection.suggestions.length,
      unrelatedSuggestions: unrelated,
    },
  };
}

/** Plain-text table for the console and committed baselines. */
export function formatBenchmark(r: BenchmarkResult): string {
  const lines = [`Mechanism benchmark — ${r.model}`,
    `Checks passed: ${r.score.hit}/${r.score.total} (${(r.score.recall * 100).toFixed(0)}%) · mechanisms fully found: ${r.score.mechanismsComplete}/${r.score.mechanisms}`,
    ...Object.entries(r.byPhase ?? {}).map(([p, b]) => `  phase ${p}: ${b.hit}/${b.total} (${(b.total ? b.hit / b.total * 100 : 0).toFixed(0)}%)`), ''];
  for (const m of r.mechanisms) {
    lines.push(`${m.hit === m.total ? '✓' : '·'} ${m.id} [${m.evidence}] ${m.hit}/${m.total}`);
    for (const c of r.checks.filter(c => c.mechanism === m.id))
      lines.push(`    ${c.status.padEnd(12)} ${c.label} — ${c.detail}`);
  }
  lines.push('', `Noise: ${r.noise.movableEdges} movable joints ${JSON.stringify(r.noise.byMotion)} by type ${JSON.stringify(r.noise.byType)}`,
    `Suggestions: ${r.noise.suggestions}, unrelated to any expected mechanism: ${r.noise.unrelatedSuggestions}`);
  return lines.join('\n');
}
