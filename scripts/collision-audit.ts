/**
 * False-collision audit for the editor's collision world (src/plan/collision.ts).
 *
 * Every part of a real, buildable model must pass the collision test against the rest of that model.
 * Input: JSON [{set, file, parts: [[part, colour, m16 column-major LDU], ...]}, ...] (e.g. answer-key
 * submodels). Each part is asked `hits([part])` against a world of all the model's parts; any hit is a
 * false collision. Writes a per-hit list and prints the most common part pairs.
 *
 *   npx tsx scripts/collision-audit.ts models.json out.json [--limit N] [--shift dx,dy,dz] [--impl module]
 *
 * --shift moves every tested part by an LDU offset first: then a hit is the right answer, and the share
 * of hits measures how many real overlaps the world catches. --impl loads another collision module
 * (e.g. an older copy) to compare.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Solid } from '../src/plan/collision';
import { jointConnectors } from '../src/plan/connectors';
import { ensureParts, initPartService, isLoaded, metricsOf, setShadowPack } from '../src/state/partService';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'public', 'ldraw');
const pack = join(here, '..', 'public', 'data', 'ldcad-shadow.json');

type Model = { set: string; file: string; parts: [string, number, number[]][] };
type Hit = { set: string; file: string; index: number; part: string; world: number[]; against: { index: number; part: string; world: number[]; rule: string; point: readonly number[] }[] };

async function solid(part: string, m: number[], id: string): Promise<Solid | null> {
  if (!isLoaded(part)) await ensureParts([part]);
  const pm = metricsOf(part);
  if (!pm.mesh) return null;
  const joints = jointConnectors(pm);
  return { id, world: m, body: pm.body, studs: pm.studs, snaps: pm.snaps, mesh: pm.mesh, ...(joints.length ? { joints } : {}) };
}

async function main() {
  const [input, output] = process.argv.slice(2);
  const limitAt = process.argv.indexOf('--limit');
  const limit = limitAt > 0 ? Number(process.argv[limitAt + 1]) : Infinity;
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const shift = arg('--shift')?.split(',').map(Number);
  const { collisionWorld } = await import(arg('--impl') ?? '../src/plan/collision');
  await initPartService(async (p) => {
    const f = join(root, p);
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  });
  setShadowPack(JSON.parse(readFileSync(pack, 'utf8')).files);
  const models: Model[] = JSON.parse(readFileSync(input, 'utf8')).slice(0, limit);
  const hits: Hit[] = [];
  let tested = 0, missing = 0;
  for (const model of models) {
    const solids: (Solid | null)[] = [];
    for (let i = 0; i < model.parts.length; i++) solids.push(await solid(model.parts[i][0], model.parts[i][2], `p${i}`));
    const present = solids.filter((s): s is Solid => !!s);
    missing += solids.length - present.length;
    const world = collisionWorld(present);
    solids.forEach((s, i) => {
      if (!s) return;
      tested++;
      const why = new Map<string, { rule: string; point: readonly number[] }>();
      const out: Set<string> = world.hits([s], shift, true, (id: string, rule: string, point: readonly number[]) => why.set(id, { rule, point }));
      if (!out.size) return;
      const against = [...out].map((id) => ({ j: Number(id.slice(1)), rule: 'body', point: [] as readonly number[], ...why.get(id) }))
        .map(({ j, rule, point }) => ({ index: j, part: model.parts[j][0], world: model.parts[j][2], rule, point }));
      hits.push({ set: model.set, file: model.file, index: i, part: model.parts[i][0], world: model.parts[i][2], against });
    });
  }
  writeFileSync(output, JSON.stringify(hits));
  const pairs = new Map<string, number>(), rules = new Map<string, number>();
  for (const h of hits) for (const a of h.against) rules.set(a.rule, (rules.get(a.rule) ?? 0) + 1);
  for (const h of hits) for (const a of h.against) {
    const k = `${a.rule.padEnd(6)} ${h.part} -> ${a.part}`;
    pairs.set(k, (pairs.get(k) ?? 0) + 1);
  }
  const flagged = new Set(hits.map((h) => `${h.set}/${h.file}/${h.index}`)).size;
  console.log(`models ${models.length}, parts tested ${tested}, missing meshes ${missing}, ${shift ? 'hit after shift' : 'falsely hit'} ${flagged} (${(100 * flagged / Math.max(1, tested)).toFixed(1)}%)`);
  console.log('by rule', Object.fromEntries(rules));
  for (const [k, n] of [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`${String(n).padStart(5)}  ${k}`);
}

void main();
