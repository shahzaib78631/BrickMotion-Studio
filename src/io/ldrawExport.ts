import { resolveColor, type ColorDef } from '../ldraw/colors';
import { assemble, type Metrics } from '../model/assemble';
import { isSub, type Plan, type Step } from '../plan/types';

const fmt = (n: number) => {
  const r = Math.round(n * 10000) / 10000;
  return String(Object.is(r, -0) ? 0 : r);
};

/** Writes the plan as an LDraw multi-part document. The main model comes first. */
export function exportLDraw(plan: Plan, metrics: Metrics, colors: Map<number, ColorDef>): string {
  const lines: string[] = [];
  const writeModel = (fileName: string, title: string, steps: Step[]) => {
    lines.push(`0 FILE ${fileName}`, `0 ${title}`, `0 Name: ${fileName}`, '0 Author: BrickMotion Studio');
    const asm = assemble({ ...plan, steps }, metrics, colors);
    const byStep = new Map<number, string[]>();
    for (const n of asm.nodes) {
      const item = steps[n.step].pieces[n.order];
      const { pos, m } = n.local;
      const nums = [...pos, ...m].map(fmt).join(' ');
      let line: string;
      if (isSub(item)) line = `1 16 ${nums} ${item.submodel}.ldr`;
      else {
        const code = item.color === 16 || item.color === '16' ? 16 : (resolveColor(colors, item.color) ?? 16);
        line = `1 ${code} ${nums} ${item.part}.dat`;
      }
      if (!byStep.has(n.step)) byStep.set(n.step, []);
      byStep.get(n.step)!.push(line);
    }
    steps.forEach((_, si) => {
      lines.push(...(byStep.get(si) ?? []), '0 STEP');
    });
    lines.push('0 NOFILE');
  };
  writeModel(`${plan.name}.ldr`, plan.name, plan.steps);
  for (const [name, sub] of Object.entries(plan.submodels ?? {})) writeModel(`${name}.ldr`, name, sub.steps);
  return lines.join('\n') + '\n';
}
