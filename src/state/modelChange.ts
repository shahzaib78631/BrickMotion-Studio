import { isSub, type Plan, type PlanItem, type Step } from '../plan/types';

/** A build spot is a view/planning annotation on a submodel *use*; it does
 * not change any brick's authored geometry. Reusing the assembled mesh when a
 * spot is dragged avoids briefly putting the editor into a loading state.
 *
 * This is deliberately conservative: a change to anything besides buildSpot
 * (including attachments, placement, step order or other hints) invalidates
 * the cache, as do new or deleted model definitions.
 */
const sameFields = (a: object, b: object): boolean => {
  const aa = a as Record<string, unknown>, bb = b as Record<string, unknown>;
  const keys = Object.keys(aa);
  return keys.length === Object.keys(bb).length && keys.every((key) => Object.hasOwn(bb, key) && aa[key] === bb[key]);
};
const sameExceptBuildSpot = (a: PlanItem, b: PlanItem): boolean => {
  if (a === b) return true;
  if (!isSub(a) || !isSub(b)) return false;
  const { assembly: aa, ...fa } = a;
  const { assembly: bb, ...fb } = b;
  if (!sameFields(fa, fb)) return false;
  const { buildSpot: _old, ...ha } = aa ?? {};
  const { buildSpot: _next, ...hb } = bb ?? {};
  return sameFields(ha, hb);
};
const sameStepsGeometry = (a: Step[], b: Step[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const sa = a[i], sb = b[i];
    if (sa === sb) continue;
    const { pieces: pa, ...fa } = sa, { pieces: pb, ...fb } = sb;
    if (!sameFields(fa, fb) || pa.length !== pb.length || !pa.every((v, j) => sameExceptBuildSpot(v, pb[j]))) return false;
  }
  return true;
};
const sameSubmodelsGeometry = (a: Plan['submodels'], b: Plan['submodels']): boolean => {
  if (a === b) return true;
  const aa = a ?? {}, bb = b ?? {};
  const names = Object.keys(aa);
  return names.length === Object.keys(bb).length && names.every(name =>
    Object.hasOwn(bb, name) && sameStepsGeometry(aa[name].steps, bb[name].steps));
};
export const sameGeometry = (a: Plan, b: Plan): boolean =>
  a.parts === b.parts && a.name === b.name && a.description === b.description &&
  sameStepsGeometry(a.steps, b.steps) && sameSubmodelsGeometry(a.submodels, b.submodels);

