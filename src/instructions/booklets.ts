import type { Booklet } from './types';

const CDN = 'https://www.lego.com/cdn/product-assets/product.bi.core.pdf/';

/** A bare LEGO booklet id becomes its CDN url; a url stays as it is; anything else is a local path (null). */
export function bookletUrl(idOrPath: string): string | null {
  const s = idOrPath.trim();
  if (/^\d+$/.test(s)) return `${CDN}${s}.pdf`;
  if (/^https?:\/\//i.test(s)) return s;
  return null;
}

const first = (b: Booklet) => b.steps[0];

/**
 * Drops regional duplicates (same text), orders booklets, and groups them into models:
 * a booklet whose steps start again at 1 is another figure, ordered by its first section
 * number; a booklet that carries on the numbering joins the previous model.
 */
export function orderBooklets(list: Booklet[]): { booklets: Booklet[]; models: string[][]; flags: string[] } {
  const flags: string[] = [];
  const unique: Booklet[] = [];
  for (const b of list) {
    if (!b.steps.length) throw new Error(`no instruction steps found in ${b.id}`);
    const dup = unique.find((u) => u.textHash === b.textHash);
    if (dup) flags.push(`${b.id} is a duplicate of ${dup.id}; skipped`);
    else unique.push(b);
  }

  const starts = unique.filter((b) => first(b).number === 1);
  const rest = unique.filter((b) => first(b).number !== 1).sort((a, b) => first(a).number - first(b).number);
  starts.sort((a, b) => (first(a).section ?? Infinity) - (first(b).section ?? Infinity));
  const models: Booklet[][] = starts.map((b) => [b]);
  for (const b of rest) {
    // joins the model whose last step it continues; otherwise its own model
    const host = models.find((m) => m[m.length - 1].steps.at(-1)!.number < first(b).number);
    if (host) host.push(b);
    else models.push([b]);
  }

  for (const m of models) {
    const numbers = m.flatMap((b) => b.steps.map((s) => s.number));
    const seen = new Set<number>();
    for (const n of numbers) {
      if (seen.has(n)) flags.push(`step ${n} appears twice`);
      seen.add(n);
    }
    for (let n = numbers[0]; n <= Math.max(...numbers); n++) if (!seen.has(n)) flags.push(`step ${n} missing`);
  }
  const booklets = models.flat();
  return { booklets, models: models.map((m) => m.map((b) => b.id)), flags };
}
