import { createHash } from 'node:crypto';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}

/** Compare fully resolved definitions, not source filenames or connector IDs
 * used only for inheritance. Mate groups, profile sections, roll and limits all
 * remain significant. A disagreement blocks automatic reference selection. */
export function referenceSignature(definitions: readonly { definition: unknown; frame: unknown }[]): string {
  const rows = definitions.map(row => {
    const { id: _id, ...definition } = row.definition as Record<string, unknown>;
    return JSON.stringify(canonical({ definition, frame: row.frame }));
  }).sort();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
