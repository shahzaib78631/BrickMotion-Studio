import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { z } from 'zod';
import { certify, type Certificate } from '../generate/certify';
import type { ColorDef } from '../ldraw/colors';
import { assemble, type Assembly } from '../model/assemble';
import type { Warning } from '../model/validate';
import type { Plan, PlanItem, Step } from '../plan/types';
import { ensureParts, getColors, metricsOf, partName, registerInlineParts } from '../state/partService';
import { allPartIds } from '../state/useModel';
import { aiErrorFrom, AiError, checkStop, defaultClient, jsonText } from './claude';
import { askBridge } from './claudeBridge';
import { PALETTE, paletteEntries, type PaletteEntry } from './palette';
import { promptColors } from './prompt';

/**
 * A variant of a real build, made by Claude: the build is described piece by piece (its box
 * in studs and plates), Claude answers with edits (recolour, remove, move, swap, add), the
 * edits are applied and the certificate checks the result. New problems go back to Claude
 * to fix, for a few rounds, the way a compiler answers each attempt. Editing a designer's
 * build keeps its techniques and special parts, which building from nothing does not.
 */

export const VARIANT_MODEL = 'claude-sonnet-5-5';
/** attempts in all: the first answer and up to two rounds of fixes */
const ROUNDS = 3;

const Rot = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
const Edit = z.union([
  z.object({ op: z.literal('recolour'), id: z.string(), color: z.string() }).strict(),
  z.object({ op: z.literal('remove'), id: z.string() }).strict(),
  z.object({ op: z.literal('move'), id: z.string(), dx: z.number(), dy: z.number().int(), dz: z.number() }).strict(),
  z.object({ op: z.literal('swap'), id: z.string(), part: z.string() }).strict(),
  z.object({ op: z.literal('add'), part: z.string(), color: z.string(), x: z.number(), y: z.number().int(), z: z.number(), rot: Rot }).strict(),
]);
export type VariantEdit = z.infer<typeof Edit>;
export const VariantSchema = z.object({ name: z.string(), summary: z.string(), edits: z.array(Edit) });
export type VariantAnswer = z.infer<typeof VariantSchema>;

const round = (n: number) => Math.round(n * 10) / 10 || 0;
const colourName = (c: ColorDef) => c.name.replace(/_/g, ' ');

/**
 * The plan as loose pieces at their world poses, in one model: no submodels, so every edit
 * is in one frame. Moved so it stands at y = 0 near the origin (whole studs, so it stays on
 * the grid), one step per brick layer.
 */
export function flatten(plan: Plan, asm: Assembly): Plan {
  const live = asm.instances.filter((i) => !i.placeholder);
  if (!live.length) return { ...plan, steps: [], submodels: undefined };
  let minX = Infinity, minZ = Infinity, bottom = -Infinity;
  for (const i of live) {
    minX = Math.min(minX, i.worldBox.min[0]);
    minZ = Math.min(minZ, i.worldBox.min[2]);
    bottom = Math.max(bottom, i.worldBox.max[1]);
  }
  const shift = [-Math.round(minX / 20) * 20, -Math.round(bottom / 8) * 8, -Math.round(minZ / 20) * 20];
  const layers = new Map<number, PlanItem[]>();
  live.forEach((i, n) => {
    const e = i.world.elements;
    const item: PlanItem = {
      id: `p${n + 1}`, part: i.part, color: i.color,
      ldu: [round(e[12] + shift[0]), round(e[13] + shift[1]), round(e[14] + shift[2])],
      matrix: [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]].map(round) as [number, number, number, number, number, number, number, number, number],
    };
    const layer = Math.floor(Math.max(0, -(i.worldBox.max[1] + shift[1]) / 8) / 3);
    layers.set(layer, [...(layers.get(layer) ?? []), item]);
  });
  const steps: Step[] = [...layers].sort((a, b) => a[0] - b[0]).map(([l, pieces]) => ({ title: `Layer ${l + 1}`, pieces }));
  const { submodels: _s, ...rest } = plan;
  return { ...rest, steps };
}

/** One line per piece: id, part, colour and its box (x, z in studs, y in plates, bottom to top). */
export function describe(asm: Assembly): string {
  const colours = getColors();
  return asm.instances.filter((i) => !i.placeholder).map((i) => {
    const b = i.worldBox;
    const c = colours.get(i.color);
    return `${i.itemId}  ${i.part} "${partName(i.part)}"  ${c ? colourName(c) : i.color}  ` +
      `x ${round(b.min[0] / 20)}..${round(b.max[0] / 20)}  z ${round(b.min[2] / 20)}..${round(b.max[2] / 20)}  y ${round(-b.max[1] / 8)}..${round(-b.min[1] / 8)}`;
  }).join('\n');
}

/** An LDraw colour code from a name ("Dark Bluish Gray", "dark bluish grey") or a number. */
export function colourCode(name: string, colours: Iterable<ColorDef> = getColors().values()): number | null {
  const t = name.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const norm = (s: string) => s.toLowerCase().replace(/[_\s-]+/g, ' ').replace(/grey/g, 'gray').trim();
  const want = norm(t);
  for (const c of colours) if (norm(c.name) === want) return c.code;
  return null;
}

/** The plan with the edits applied, and what could not be applied. */
export function applyEdits(plan: Plan, edits: VariantEdit[], colours?: Iterable<ColorDef>): { plan: Plan; notes: string[] } {
  const out: Plan = structuredClone(plan);
  const notes: string[] = [];
  const all = out.steps.flatMap((s) => s.pieces);
  const byId = new Map(all.map((p) => [p.id, p]));
  let next = all.filter((p) => p.id?.startsWith('n')).length + 1;
  const added: PlanItem[] = [];
  const remove = new Set<string>();
  for (const e of edits) {
    if (e.op === 'add') {
      const code = colourCode(e.color, colours);
      if (code === null) { notes.push(`add ${e.part}: unknown colour "${e.color}"`); continue; }
      const id = `n${next++}`;
      const item: PlanItem = { id, part: e.part, color: code, x: e.x, y: e.y, z: e.z, rot: e.rot };
      added.push(item);
      byId.set(id, item);
      continue;
    }
    const item = byId.get(e.id);
    if (!item || 'submodel' in item) { notes.push(`${e.op} ${e.id}: no piece has that id`); continue; }
    if (e.op === 'remove') remove.add(e.id);
    else if (e.op === 'recolour') {
      const code = colourCode(e.color, colours);
      if (code === null) notes.push(`recolour ${e.id}: unknown colour "${e.color}"`);
      else item.color = code;
    } else if (e.op === 'swap') item.part = e.part;
    else if ('rot' in item) { item.x += e.dx; item.y += e.dy; item.z += e.dz; }
    else item.ldu = [item.ldu[0] + e.dx * 20, item.ldu[1] - e.dy * 8, item.ldu[2] + e.dz * 20];
  }
  out.steps = out.steps.map((s) => ({ ...s, pieces: s.pieces.filter((p) => !p.id || !remove.has(p.id)) })).filter((s) => s.pieces.length);
  const fresh = added.filter((p) => !remove.has(p.id!));
  if (fresh.length) out.steps.push({ title: 'Variant', pieces: fresh });
  return { plan: out, notes };
}

const key = (w: Warning) => `${w.kind}:${[...w.itemIds].sort().join(',')}`;
const IGNORED = new Set(['weak']);

/** What the variant broke: warnings and tipping the original build did not have. */
export function newProblems(base: Certificate, now: Certificate): string[] {
  const had = new Set(base.warnings.map(key));
  const out = now.warnings.filter((w) => !IGNORED.has(w.kind) && !had.has(key(w))).map((w) => `${w.kind} [${w.itemIds.join(', ')}]: ${w.message}`);
  if (now.tipping > base.tipping) {
    for (const g of now.tippingItems) out.push(`tipping [${g.slice(0, 12).join(', ')}${g.length > 12 ? ', …' : ''}]: this part of the model falls over, its weight is not above what it stands on`);
  }
  return out;
}

export function variantSystemPrompt(palette: PaletteEntry[], colors: Iterable<ColorDef>): string {
  const { solid, trans } = promptColors(colors);
  const parts = palette.map((p) => `${p.id}  ${p.name}  ${p.w}×${p.d}×${p.heightPlates}`).join('\n');
  return `You remix real brick-built models (in the style of LEGO® sets) for BrickMotion Studio. You get a real build, piece by piece, and a request for a variant of it. You answer with edits to that build. Keep what makes the original good: its shape, its techniques and its special parts. Change what the request asks for, and whatever that needs.

# The build
Each line is one piece: id, part id, "name", colour, then its box: x and z in studs, y in plates (up is positive, the ground is y = 0). 1 brick = 3 plates. Studs are on top of a piece and are not part of its box.

# Edits
- {"op":"recolour","id","color"}: give a piece a new colour.
- {"op":"remove","id"}: take a piece out.
- {"op":"move","id","dx","dy","dz"}: shift a piece by whole plates in y, and by studs in x and z.
- {"op":"swap","id","part"}: replace a piece's part and keep its position (best for a part with the same footprint and height).
- {"op":"add","part","color","x","y","z","rot"}: add a piece. x, z is the minimum corner of its rotated footprint in studs and y is its bottom in plates, the same units as the boxes. rot is its turn around the vertical axis: 0, 90, 180 or 270. A part listed as w×d covers w studs along x and d along z at rot 0; at 90 or 270 they swap.

# Rules
- A new piece must sit on the studs of a piece below it (its y is that piece's top) or carry a piece above it, with its footprint on the same stud grid as its neighbours. Nothing may float.
- Pieces must not overlap.
- The model must still stand: keep its weight over what it stands on.
- Use only part ids from the list below for added or swapped pieces, and colour names from the lists.
- Prefer a few well-chosen edits to many. Removing a piece can leave others floating: move or remove those too.

# Parts (id  name  w×d×height in plates)
${parts}

# Colours
Solid: ${solid.join(', ')}
Transparent: ${trans.join(', ')}

# Answer
One JSON object: {"name": a short name for the variant, "summary": one sentence on what changed, "edits": [...]}.
After your edits are applied, an automatic check may report new problems with piece ids. Then answer with further edits that fix them, applied on top of the build as it is after your earlier edits.`;
}

export function variantMessage(request: string, plan: Plan, description: string): string {
  return `The build: "${plan.name}"${plan.description ? ` (${plan.description})` : ''}

${description}

Make this variant of it: ${request.trim()}`;
}

export type VariantResult = {
  plan: Plan;
  cert: Certificate;
  name: string;
  summary: string;
  /** problems the variant still has that the original did not (empty when it is clean) */
  problems: string[];
  /** edits that could not be applied */
  notes: string[];
  rounds: number;
};

/** One turn of the conversation: the app's text, or Claude's reply as it came. */
type Turn = { role: 'user' | 'assistant'; content: unknown };
/** One round: Claude's answer (JSON), and its reply to keep in the conversation. */
type Ask = (turns: Turn[]) => Promise<{ answer: unknown; reply: unknown }>;

/** Through the API with a key: the conversation as messages, Claude's turns kept whole. */
function apiAsk(client: Anthropic, system: string, model: string, signal?: AbortSignal): Ask {
  return async (turns) => {
    let msg;
    try {
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: 64000,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'high', format: zodOutputFormat(VariantSchema) },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system,
          messages: turns as BetaMessageParam[],
        },
        { signal },
      );
      msg = await stream.finalMessage();
    } catch (e) {
      throw aiErrorFrom(e, signal);
    }
    checkStop(msg, 'The answer was too long and got cut off. Ask for a smaller change.');
    return { answer: jsonText(msg), reply: msg.content };
  };
}

/**
 * Through the local Claude CLI (no key): each call stands alone, so the conversation so far
 * goes in as one prompt, earlier answers quoted.
 */
function bridgeAsk(system: string, model: string, signal?: AbortSignal, ask = askBridge): Ask {
  // the CLI's validator does not know the draft tag zod writes, and does not need it
  const { $schema: _draft, ...schema } = z.toJSONSchema(VariantSchema);
  return async (turns) => {
    const prompt = turns.length === 1 ? String(turns[0].content) : turns.map((t) => t.role === 'user'
      ? String(t.content)
      : `Your answer so far (already applied to the build):\n\`\`\`json\n${String(t.content)}\n\`\`\``).join('\n\n---\n\n');
    const { output } = await ask({ system, prompt, schema, model, effort: 'high', signal });
    return { answer: output, reply: JSON.stringify(output) };
  };
}

/**
 * A variant of `base` for the request. Each round's edits apply on top of the last, and the
 * least broken version is returned (the first clean one ends the loop). With an API key it
 * calls the API; without one it uses the local Claude CLI through the dev server.
 */
export async function makeVariant(
  args: { apiKey?: string; request: string; base: Plan; signal?: AbortSignal; progress?: (stage: string) => void; model?: string },
  deps: { createClient?: (apiKey: string) => Anthropic; bridge?: typeof askBridge } = {},
): Promise<VariantResult> {
  const { progress } = args;
  progress?.('Reading the build');
  registerInlineParts(args.base.parts);
  await ensureParts([...allPartIds(args.base), ...PALETTE]);
  const flat = flatten(args.base, assemble(args.base, metricsOf, getColors()));
  const flatAsm = assemble(flat, metricsOf, getColors());
  const baseCert = await certify(flat, { realModel: true });
  const system = variantSystemPrompt(paletteEntries(PALETTE, metricsOf, partName), getColors().values());
  const turns: Turn[] = [{ role: 'user', content: variantMessage(args.request, flat, describe(flatAsm)) }];
  const model = args.model ?? VARIANT_MODEL;
  const ask = args.apiKey
    ? apiAsk((deps.createClient ?? defaultClient)(args.apiKey), system, model, args.signal)
    : bridgeAsk(system, model, args.signal, deps.bridge);

  let current = flat;
  let best: VariantResult | null = null;
  const notes: string[] = [];
  for (let r = 1; r <= ROUNDS; r++) {
    progress?.(r === 1 ? 'Asking Claude for the variant' : `Fixing what the check found (round ${r})`);
    const { answer: raw, reply } = await ask(turns);
    const parsed = VariantSchema.safeParse(raw);
    if (!parsed.success) throw new AiError('invalid', `The edits did not match the expected format: ${parsed.error.issues[0]?.message ?? ''}`);
    const answer = parsed.data;

    progress?.('Checking the variant');
    const applied = applyEdits(current, answer.edits);
    notes.push(...applied.notes);
    current = { ...applied.plan, name: answer.name || current.name, description: answer.summary };
    registerInlineParts(current.parts);
    await ensureParts(allPartIds(current));
    const cert = await certify(current, { realModel: true });
    const problems = [...newProblems(baseCert, cert), ...applied.notes.map((n) => `could not apply: ${n}`)];
    const result: VariantResult = { plan: current, cert, name: current.name, summary: answer.summary, problems, notes, rounds: r };
    if (!best || problems.length <= best.problems.length) best = result;
    if (!problems.length) break;
    if (r < ROUNDS) {
      // append-only: Claude's answer as it was, then the check's report
      turns.push({ role: 'assistant', content: reply });
      const touched = new Set(problems.flatMap((p) => /\[([^\]]*)\]/.exec(p)?.[1].split(', ') ?? []));
      const asm = assemble(current, metricsOf, getColors());
      const lines = describe(asm).split('\n').filter((l) => touched.has(l.split(' ')[0]));
      turns.push({
        role: 'user',
        content: `The check found these new problems:\n${problems.map((p) => `- ${p}`).join('\n')}\n\n` +
          (lines.length ? `Those pieces now:\n${lines.join('\n')}\n\n` : '') +
          'Answer with edits that fix them, on top of the build as it is now. Keep the rest of the variant.',
      });
    }
  }
  return best!;
}
