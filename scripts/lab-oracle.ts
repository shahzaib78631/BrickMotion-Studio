/**
 * Brick Lab's overlap judge: the editor's own collision world (src/plan/collision.ts, the one the
 * drag guard and the suggestions use), served to Python over stdin/stdout, one JSON object per line.
 *
 *   {"op":"reset"}                                   → {"ok":true}
 *   {"op":"add","part":"3001","m":[16 numbers]}      → {"ok":true}
 *   {"op":"hits","part":"3001","m":[16 numbers]}     → {"hit":false}
 *   {"op":"hitsMany","part":"3001","ms":[[16],...]}  → {"hits":[false,true,...]}
 *
 * `m` is a part's world matrix, column-major, in LDU (LDraw axes). Parts load from public/ldraw
 * with the shadow pack, as tests/helpers/appParts.ts does. A part the library doesn't have counts
 * as hitting, so the sampler never places it.
 *
 *   npx tsx scripts/lab-oracle.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { collisionWorld, type CollisionWorld, type Solid } from '../src/plan/collision';
import { ensureParts, initPartService, isLoaded, metricsOf, setShadowPack } from '../src/state/partService';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'public', 'ldraw');
const pack = join(here, '..', 'public', 'data', 'ldcad-shadow.json');

const solids: Solid[] = [];
let world: CollisionWorld | null = null;

async function solid(part: string, m: number[], id: string): Promise<Solid | null> {
  if (!isLoaded(part)) await ensureParts([part]);
  const pm = metricsOf(part);
  if (!pm.mesh) return null;
  return { id, world: m, body: pm.body, studs: pm.studs, snaps: pm.snaps, mesh: pm.mesh };
}

async function hits(part: string, m: number[]): Promise<boolean> {
  const s = await solid(part, m, 'moving');
  if (!s) return true;
  if (!solids.length) return false;
  world ??= collisionWorld(solids);
  return world.hits([s]).size > 0;
}

async function handle(msg: { op: string; part?: string; m?: number[]; ms?: number[][] }): Promise<unknown> {
  switch (msg.op) {
    case 'reset':
      solids.length = 0;
      world = null;
      return { ok: true };
    case 'add': {
      const s = await solid(msg.part!, msg.m!, `p${solids.length}`);
      if (s) solids.push(s);
      world = null;
      return { ok: true, known: !!s };
    }
    case 'hits':
      return { hit: await hits(msg.part!, msg.m!) };
    case 'hitsMany': {
      const out: boolean[] = [];
      for (const m of msg.ms!) out.push(await hits(msg.part!, m));
      return { hits: out };
    }
    default:
      return { error: `unknown op ${msg.op}` };
  }
}

async function main() {
  await initPartService(async (p) => {
    const f = join(root, p);
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  });
  setShadowPack(JSON.parse(readFileSync(pack, 'utf8')).files);
  process.stdout.write(JSON.stringify({ ready: true }) + '\n');
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let out: unknown;
    try {
      out = await handle(JSON.parse(line));
    } catch (e) {
      out = { error: String(e) };
    }
    process.stdout.write(JSON.stringify(out) + '\n');
  }
}

void main();
