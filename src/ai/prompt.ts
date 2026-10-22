import type { ColorDef } from '../ldraw/colors';
import type { Warning } from '../model/validate';
import type { Plan, PlanItem, Step } from '../plan/types';
import type { PaletteEntry } from './palette';

const DEFAULT_MAX_PIECES = 80;

const colorName = (c: ColorDef) => c.name.replace(/_/g, ' ');

/** Solid colours plus the common transparent ones, by name. */
export function promptColors(colors: Iterable<ColorDef>): { solid: string[]; trans: string[] } {
  const list = [...colors];
  return {
    solid: list.filter((c) => c.finish === 'solid' && c.code < 400 && c.code !== 16 && c.code !== 24).map(colorName),
    trans: list.filter((c) => c.finish === 'trans' && c.code < 100 && /^Trans/i.test(c.name) && !/IR_Lens/i.test(c.name)).map(colorName),
  };
}

const EXAMPLE = {
  name: 'Example',
  description: 'A red 2x4 brick with a blue 2x4 plate on top.',
  steps: [{ pieces: [{ part: '3001', color: 'Red', x: 0, y: 0, z: 0, rot: 0 }] }, { pieces: [{ part: '3020', color: 'Blue', x: 0, y: 3, z: 0, rot: 0 }] }],
  submodels: [],
};

export function buildSystemPrompt(palette: PaletteEntry[], colors: Iterable<ColorDef>): string {
  const { solid, trans } = promptColors(colors);
  const parts = palette.map((p) => `${p.id}  ${p.name}  ${p.w}×${p.d}×${p.heightPlates}`).join('\n');
  return `You design small, charming brick-built models (in the style of LEGO® sets) and write their build plans as JSON for BrickMotion Studio, which animates the build for a short vertical video.

# Coordinates
- The model sits on a stud grid. x and z are in studs, y is in plates (up is positive). 1 brick = 3 plates, so a brick is 3 tall and a plate or tile is 1 tall.
- Each item's x, y, z is the minimum corner of its rotated footprint and the bottom of the piece. The ground is y = 0.
- rot is the rotation around the vertical axis: 0, 90, 180 or 270. A part listed as w×d occupies w studs along x and d studs along z at rot 0; at rot 90 or 270 the two swap.
- Studs are on top. Every piece must rest on the ground or touch another piece (sit on its studs, or have a piece sitting on it). Nothing may float.
- Pieces must not overlap. A piece placed at y sits on whatever has its top at y.

# Parts
Use only these part ids, exactly as written. Each line is: id  name  w×d×height(in plates).
${parts}

# Colours
Use colour names from these lists.
Solid: ${solid.join(', ')}
Transparent: ${trans.join(', ')}

# Submodels
Use submodels for repeated or separately built assemblies such as engines, wings or wheels. A submodel has its own steps and its own coordinates starting at 0,0,0. It is built aside and then attached in one move. Place it with {"submodel": "<name>", "x":…, "y":…, "z":…, "rot":…}; the same footprint rule applies as for a piece. A submodel can be placed several times.

# Steps
Steps should read like real building instructions: bottom up, 1 to 6 pieces per step, each step adding a recognisable part of the model. Prefer symmetric, sturdy designs with smooth tops (tiles, slopes) and a clear silhouette.

# Output
Reply with one JSON object: {"name", "description", "steps": [{"pieces": [...]}], "submodels": [{"name", "steps"}]}.
Example (a 2×4 brick with a 2×4 plate on top):
${JSON.stringify(EXAMPLE)}`;
}

export function buildGenerateMessage(idea: string, opts: { maxPieces?: number } = {}): string {
  const max = opts.maxPieces ?? DEFAULT_MAX_PIECES;
  return `Design this model: ${idea.trim()}

Use at most ${max} pieces in total (count each submodel's pieces once per placement). Give it a short catchy name.`;
}

const withoutId = ({ id: _id, ...rest }: PlanItem) => rest;
const stripIds = (steps: Step[]) => steps.map((s) => ({ pieces: s.pieces.map(withoutId) }));

/** The plan in the AI's own JSON form (submodels as an array, no ids). */
export function planToAiJson(plan: Plan): string {
  return JSON.stringify(
    {
      name: plan.name,
      description: plan.description ?? '',
      steps: stripIds(plan.steps),
      submodels: Object.entries(plan.submodels ?? {}).map(([name, m]) => ({ name, steps: stripIds(m.steps) })),
    },
    null,
    2,
  );
}

export function buildFixMessage(plan: Plan, warnings: Warning[], note: string): string {
  const problems = warnings.length ? warnings.map((w) => `- ${w.message}`).join('\n') : '- (no automatic warnings)';
  return `Here is the current build plan:

${planToAiJson(plan)}

The automatic checks report:
${problems}

${note.trim() ? `The builder asks: ${note.trim()}\n\n` : ''}Fix these problems and return the complete corrected plan. Keep everything that already works as it is.`;
}

/** A prompt to paste into any chat assistant; its answer can be pasted back in. */
export function buildCopyPrompt(palette: PaletteEntry[], colors: Iterable<ColorDef>, idea: string): string {
  return `${buildSystemPrompt(palette, colors)}

---

${buildGenerateMessage(idea)}

Reply with only the JSON object: no prose and no code fences.`;
}
