import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Archives may be flat or wrapped in ldraw/. Reject empty sources before any writes. */
export function resolvePartsLibrary(source: string, complete: boolean): string {
  const hasDat = (dir: string): boolean => existsSync(dir) && statSync(dir).isDirectory() &&
    readdirSync(dir, { withFileTypes: true }).some(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.dat'));
  for (const root of [source, join(source, 'ldraw')]) {
    if (hasDat(join(root, 'parts')) && hasDat(join(root, 'p')) &&
        (!complete || existsSync(join(root, 'LDConfig.ldr')))) return root;
  }
  throw new Error(`Invalid or empty parts library at ${source}; installed parts left unchanged`);
}
