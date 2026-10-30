/**
 * Local additions to the LDCad Shadow Library (CC BY-SA 4.0, Roland Melkert
 * and contributors): connectors a part has in its LDraw geometry that the
 * upstream shadow files do not describe. Each is merged into the shadow pack
 * when it is read, so no re-import is needed; a line the upstream file
 * already has is not added twice. Candidates to contribute upstream
 * (github.com/RolandMelkert/LDCadShadowLibrary).
 */
export const SHADOW_PATCHES: Readonly<Record<string, string>> = {
  /**
   * Wheel rim 44772: three pin holes on a 20 LDU bolt circle, each modelled
   * as peghole.dat at z = -12 and z = 8 with a 16 LDU cylinder between them
   * (a 20 LDU through hole centred at z = -2, along z). peghole.dat only
   * describes a hole's 2 LDU end, so the whole hole is described here with
   * the library's own connhole.dat. Hub 92909's three pins fit them.
   */
  '44772.dat': [
    '0 !LDCAD SNAP_INCL [ref=connhole.dat] [pos=0 20 -2] [ori=1 0 0 0 0 -1 0 1 0]',
    '0 !LDCAD SNAP_INCL [ref=connhole.dat] [pos=17.321 -10 -2] [ori=1 0 0 0 0 -1 0 1 0]',
    '0 !LDCAD SNAP_INCL [ref=connhole.dat] [pos=-17.321 -10 -2] [ori=1 0 0 0 0 -1 0 1 0]',
  ].join('\n'),
};

/** The pack's files with the local patches merged in (lower-case keys). */
export function withShadowPatches(files: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) out[k.toLowerCase().replace(/\\/g, '/')] = v;
  const squash = (l: string) => l.trim().replace(/\s+/g, ' ');
  for (const [k, patch] of Object.entries(SHADOW_PATCHES)) {
    const have = out[k] ?? '';
    const known = new Set(have.split(/\r?\n/).map(squash));
    const add = patch.split('\n').filter(l => !known.has(squash(l)));
    if (add.length) out[k] = [have, ...add].filter(Boolean).join('\n');
  }
  return out;
}
