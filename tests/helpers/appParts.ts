/** Loads real LDraw parts (with the shadow pack) into the app's part service, as the browser does. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureParts, initPartService, setShadowPack } from '../../src/state/partService';

const root = join(__dirname, '..', '..', 'public', 'ldraw');
const pack = join(__dirname, '..', '..', 'public', 'data', 'ldcad-shadow.json');
export const appPartsReady = existsSync(join(root, 'parts', '3001.dat')) && existsSync(join(root, 'LDConfig.ldr')) && existsSync(pack);
let ready: Promise<void> | null = null;

export async function useAppParts(ids: string[]): Promise<void> {
  ready ??= (async () => {
    await initPartService(async (p) => {
      const f = join(root, p);
      return existsSync(f) ? readFileSync(f, 'utf8') : null;
    });
    setShadowPack(JSON.parse(readFileSync(pack, 'utf8')).files);
  })();
  await ready;
  await ensureParts(ids);
}
