/** Renderer-independent compiler: the worker and CLI consume the same operation
 * paths. Easing may change time along a path, never the validated geometry. */
import type { EncodedTimeline } from '../timelineData';
import type { AnimOptions } from '../pacing';
import { choosePacing } from '../pacing';
import type { Box } from '../../ldraw/flatten';
import { ConstructionError, type ConstructionPlan } from './types';
import { sub, translated, shiftBox, union, norm, validMatrix, multiply, transformBox } from './math';
import type { V3 } from './math';
export function compileConstruction(plan: ConstructionPlan, opts: AnimOptions): EncodedTimeline {
    if (!Number.isFinite(opts.targetSeconds) || opts.targetSeconds <= 0 || [opts.introSeconds, opts.buildSeconds, opts.outroSeconds].some(v => v != null && !Number.isFinite(v)))
        throw new ConstructionError('invalid-input', 'Animation timing must be finite and targetSeconds must be positive.');
    const pacing = choosePacing(plan.operations.length, plan.operations.length, { ...opts, mode: 'piece' });
    const matrices: number[][] = [], ref = (m: number[]) => { matrices.push(m); return matrices.length - 1; };
    const parts = new Map(plan.parts.map(p => [p.key, p]));
    if (parts.size !== plan.parts.length)
        throw new ConstructionError('invalid-plan', 'Duplicate part keys in construction output.');
    type ETrack = EncodedTimeline['tracks'][number][1];
    const tracks = new Map<string, ETrack>();
    for (const p of plan.parts) {
        if (!validMatrix(p.final) || !validMatrix(p.staged))
            throw new ConstructionError('invalid-plan', `Invalid matrix for ${p.key}.`);
        const offset: V3 = [p.staged[12] - p.final[12], p.staged[13] - p.final[13], p.staged[14] - p.final[14]];
        tracks.set(p.key, { appear: 0, floor: ref(p.staged), final: ref(p.final), floorBox: shiftBox(p.bounds, offset), ctx: 0, moves: [] });
    }
    const units: EncodedTimeline['units'] = [], steps: EncodedTimeline['steps'] = [], camKeys: EncodedTimeline['camKeys'] = [], subBuilds: EncodedTimeline['subBuilds'] = [];
    let time = pacing.intro;
    const current = new Map(plan.parts.map(p => [p.key, p.staged]));
    const operationIndex = new Map<string, number>();
    for (const op of plan.operations) {
        if (operationIndex.has(op.id) || op.keys.length !== new Set(op.keys).size || !op.keys.length || op.path.length < 2 || op.path.some(p => p.length !== 3 || !p.every(Number.isFinite)) || (op.rigidPath && (op.rigidPath.length !== op.path.length || op.rigidPath.some(m => !validMatrix(m)))))
            throw new ConstructionError('invalid-plan', `Malformed operation ${op.id}.`);
        const index = units.length, requires = op.requires.map(id => { const n = operationIndex.get(id); if (n === undefined)
            throw new ConstructionError('invalid-plan', `Unfinished prerequisite ${id}.`); return n; });
        operationIndex.set(op.id, index);
        if (index)
            time = Math.max(time, units[index - 1].start + units[index - 1].dur + .03);
        for (const j of requires)
            time = Math.max(time, units[j].start + units[j].dur + .03);
        const dur = Math.max(.35, pacing.build / Math.max(1, plan.operations.length));
        let travel: Box | null = null;
        let land: Box | null = null;
        const translationPath = op.rigidPath ? undefined : op.path.map(p => sub(p, op.path[0]));
        for (const key of op.keys) {
            const p = parts.get(key), tr = tracks.get(key);
            if (!p || !tr)
                throw new ConstructionError('invalid-plan', `Unknown moving part ${key}.`);
            const posePath = op.rigidPath?.map(delta => multiply(delta, p.final));
            const from = posePath?.[0] ?? translated(p.final, op.path[0]), to = posePath?.[posePath.length - 1] ?? translated(p.final, op.path[op.path.length - 1]);
            if (from.some((v, k) => Math.abs(v - current.get(key)![k]) > 1e-8))
                throw new ConstructionError('invalid-plan', `Discontinuous operation at ${key}.`);
            // Do not decompose/recompose these matrices: preserve exact source shear.
            tr.moves.push({ unit: index, from: ref(from), to: ref(to), rel: -1, hold: 0, skyY: 0, entry: [0, 0, 0], translationPath, posePath: posePath?.map(ref) });
            current.set(key, to);
            const landed = op.rigidPath ? transformBox(p.bounds, op.rigidPath[op.rigidPath.length - 1]) : shiftBox(p.bounds, op.path[op.path.length - 1]);
            land = land ? union(land, landed) : landed;
            if (op.rigidPath) {
                for (const delta of op.rigidPath) {
                    const box = transformBox(p.bounds, delta);
                    travel = travel ? union(travel, box) : box;
                }
            }
            else for (const offset of op.path)
                travel = travel ? union(travel, shiftBox(p.bounds, offset)) : shiftBox(p.bounds, offset);
        }
        units.push({ kind: op.kind === 'attach-subassembly' ? 'attach' : 'piece', keys: [...op.keys], start: time, dur, step: steps.length, dependsOn: requires, box: travel, land, operationId: op.id });
        steps.push({ model: op.model, index: op.step, start: time, end: time + dur });
        let visible = plan.bounds;
        for (const p of plan.parts) {
            const at = current.get(p.key)!;
            visible = union(visible, shiftBox(p.bounds, [at[12] - p.final[12], at[13] - p.final[13], at[14] - p.final[14]]));
        }
        if (travel)
            visible = union(visible, travel);
        camKeys.push({ t: time, box: visible }, { t: time + dur, box: visible });
        if (op.kind === 'attach-subassembly') {
            const earlier = plan.operations.slice(0, index).map((o, i) => ({ o, i })).filter(({ o }) => o.keys.some(k => op.keys.includes(k)));
            const focus = op.keys.map(k => shiftBox(parts.get(k)!.bounds, op.path[0])).reduce(union);
            subBuilds.push({ key: op.id.slice('construct:'.length), name: op.id.includes('$mechanical:') ? 'Mechanical subassembly' : op.scope, closeUp: false, start: earlier.length ? units[earlier[0].i].start : time, attachStart: time, attachEnd: time + dur, focus });
        }
        time += dur;
    }
    for (const p of plan.parts)
        if (p.final.some((v, k) => Math.abs(v - current.get(p.key)![k]) > 1e-8))
            throw new ConstructionError('invalid-plan', `Final pose was not reached for ${p.key}.`);
    const mats = new Float64Array(matrices.length * 16);
    matrices.forEach((m, i) => mats.set(m, i * 16));
    const buildEnd = time, duration = Math.max(Number.isFinite(opts.targetSeconds) ? opts.targetSeconds : 0, buildEnd + pacing.outro);
    camKeys.unshift({ t: 0, box: plan.sceneBounds });
    camKeys.push({ t: buildEnd, box: plan.bounds });
    return { mats, tracks: [...tracks], duration, steps, pacing, heroOrbit: opts.heroOrbit, intro: pacing.intro, buildEnd, units, subBuilds, buildBox: plan.sceneBounds, modelBox: plan.bounds, sceneBox: plan.sceneBounds, camKeys, ground: plan.ground, construction: plan };
}
