import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURE_ROOT = join(__dirname, '..', 'fixtures', 'ldraw');

/** FetchText over the hand-made fixture library. Counts calls per path. */
export const fetchCounts = new Map<string, number>();
export async function fixtureFetchText(path: string): Promise<string | null> {
  const p = path.toLowerCase();
  fetchCounts.set(p, (fetchCounts.get(p) ?? 0) + 1);
  const full = join(FIXTURE_ROOT, p);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
}
