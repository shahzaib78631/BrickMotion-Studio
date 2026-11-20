/** Mine model placements and measure explicitly documented part pairs. */
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, sep } from 'node:path';
import { Box3, BufferGeometry, Float32BufferAttribute, Matrix4, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { hasSnapMate, worldSnaps } from '../src/anim/snapMates';
import { attachmentHintsFromLDraw, orthogonalBasisParity } from '../src/ldraw/attachmentHints';
import { parseLDraw, parseMpd, type Mat3, type Vec3 } from '../src/ldraw/parse';
import type { Snap } from '../src/ldraw/shadow';
import { accessoryGeometry, sectionAtY } from './lib/accessory-geometry';
import targets from '../docs/data/assembly-use-case-targets.json';

const [corpusArg, outputArg = '.cache/measurements', ldrawArg = 'public/ldraw'] = process.argv.slice(2);
if (!corpusArg) throw new Error('Usage: tsx scripts/measure-assembly-use-cases.ts OMR_MODEL_DIRECTORY [OUTPUT] [LDRAW]');
const corpus = resolve(corpusArg), output = resolve(outputArg), ldraw = resolve(ldrawArg);
const manifestPath = resolve(corpus, 'manifest.json');
const manifestBytes = readFileSync(manifestPath);
const manifest: { set: string; file: string; url: string }[] = JSON.parse(manifestBytes.toString());
const inventory = JSON.parse(readFileSync(resolve(output, 'coverage.json'), 'utf8')) as {
  inventoryHash: string;
  parts: { id: string; description?: string }[];
  sources: Record<string, string>;
};
const inventoryIds = new Set(inventory.parts.map(part => part.id));
// These classifications queue candidates for review, including descriptive
// false positives. Each family has a broad, explicit search across the inventory.
const families = [
  ['scabbard-and-quiver', /\b(?:Scabbard|Sword Holder|Quiver)\b/i],
  ['drawer-and-slider', /\b(?:Drawer Slots?|Cupboard|Sliding Door|Piston|Linear Actuator|Gear Rack)\b/i],
  ['accessory-holder', /\b(?:Tool Holder|Stretcher|Signal Holder|Ski Pole|Pet Flap|Lens Holder)\b/i],
  ['visor-and-coupling', /\b(?:Helmet Visor|Windscreen Hinge|Train Coupling)\b/i],
  ['wheel-rim-and-tyre', /^(?:Wheel Rim|Tyre)\b/i],
] as const;
const familyParts = new Map(inventory.parts.flatMap(part => {
  const description = part.description ?? '';
  if (/^(?:[~=|_]|Sticker\b)/i.test(description) || /\bPattern\b/i.test(description)) return [];
  const family = families.find(([, pattern]) => pattern.test(description))?.[0];
  return family ? [[part.id, { family, description }] as const] : [];
}));
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const matrix = (m: Mat3, p: Vec3) => new Matrix4().set(
  m[0], m[1], m[2], p[0], m[3], m[4], m[5], p[1], m[6], m[7], m[8], p[2], 0, 0, 0, 1);
const pose = ({ elements: e }: Matrix4) => ({
  pos: [e[12], e[13], e[14]] as Vec3,
  m: [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]] as Mat3,
});
const partName = /^[a-z0-9][a-z0-9_-]*\.dat$/;
const pairKey = (host: string, insert: string) => `${host}/${insert}`;
const failures: { subject: string; issue: string }[] = [];
const failure = (subject: string, error: unknown) => failures.push({ subject, issue: String(error) });

function loadGeometry(id: string) {
  const data = accessoryGeometry(ldraw, `${id}.dat`);
  for (const [path, hash] of Object.entries(data.sources)) {
    if (inventory.sources[path] !== hash) throw new Error(`CAD source differs from frozen inventory: ${path}`);
  }
  const mesh = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(data.triangles, 3));
  const bounds = new Box3(new Vector3(...data.bounds.min), new Vector3(...data.bounds.max));
  const tree = new MeshBVH(mesh);
  mesh.boundsTree = tree;
  return { mesh, bounds, sources: data.sources, tree, triangles: data.triangles };
}
const geometries = new Map<string, ReturnType<typeof loadGeometry> | null>();
function geometry(id: string) {
  if (geometries.has(id)) return geometries.get(id)!;
  try { geometries.set(id, loadGeometry(id)); }
  catch (error) { failure(id, error); geometries.set(id, null); }
  return geometries.get(id)!;
}

function measure(host: string, insert: string, transform: Matrix4, axis?: number[]) {
  const a = geometry(host), b = geometry(insert);
  if (!a || !b) return { status: 'missing-geometry' };
  const otherBounds = b.bounds.clone().applyMatrix4(transform);
  const seatedSurfaceIntersection = a.tree.intersectsGeometry(b.mesh, transform);
  const closest = seatedSurfaceIntersection ? null : a.tree.closestPointToGeometry(b.mesh, transform, undefined, undefined, 0, 4);
  const sweep = axis && orthogonalBasisParity(pose(transform).m) === 1 ? [-1, 1].map(sign => {
    const direction = new Vector3(...axis).transformDirection(transform).multiplyScalar(sign);
    // At this offset the two bounds can no longer overlap along the probe axis.
    const end = Math.min(640, Math.ceil((a.bounds.getSize(new Vector3()).length() +
      otherBounds.getSize(new Vector3()).length() + a.bounds.distanceToPoint(otherBounds.getCenter(new Vector3())) + 4) / 2) * 2);
    const start = new Vector3().setFromMatrixPosition(transform);
    const samples = Array.from({ length: end / 2 + 1 }, (_, index) => {
      const offset = index * 2;
      const moved = transform.clone().setPosition(start.clone().addScaledVector(direction, offset));
      return a.tree.intersectsGeometry(b.mesh, moved);
    });
    return { directionInHost: direction.toArray(), signRelativeToCandidate: sign, sampleStepLdu: 2, finalOffsetLdu: end,
      intersectingOffsetsLdu: samples.flatMap((intersects, index) => intersects ? [index * 2] : []),
      finalBoundsSeparated: !a.bounds.intersectsBox(otherBounds.clone().translate(direction.clone().multiplyScalar(end))) };
  }) : undefined;
  return { status: 'CAD-surface-test', seatedSurfaceIntersection, nearestSurfaceDistanceBelow4Ldu: seatedSurfaceIntersection ? 0 : closest?.distance ?? null,
    boundsOverlap: a.bounds.intersectsBox(otherBounds), sweep, geometrySources: { host: a.sources, insert: b.sources } };
}

/** Sample the rim's outer envelope and the tyre's innermost surface about host Z. */
function tyreProfile(host: string, insert: string, transform: Matrix4) {
  const rim = geometry(host), tyre = geometry(insert);
  if (!rim || !tyre) return undefined;
  const rotate = new Matrix4().makeRotationX(-Math.PI / 2);
  const points = (triangles: number[], matrix: Matrix4) => {
    const xyz = new Vector3(), result: number[] = [];
    for (let i = 0; i < triangles.length; i += 3) {
      xyz.fromArray(triangles, i).applyMatrix4(matrix);
      result.push(xyz.x, xyz.y, xyz.z);
    }
    return result;
  };
  const hostPoints = points(rim.triangles, rotate);
  const insertPoints = points(tyre.triangles, rotate.clone().multiply(transform));
  const tireBounds = tyre.bounds.clone().applyMatrix4(transform);
  const start = Math.max(rim.bounds.min.z, tireBounds.min.z);
  const end = Math.min(rim.bounds.max.z, tireBounds.max.z);
  const samples = [];
  for (let z = start + 0.5; z < end; z += 1) {
    const rimSections = sectionAtY(hostPoints, z).segments;
    const tyreSections = sectionAtY(insertPoints, z).segments;
    if (!rimSections.length || !tyreSections.length) continue;
    const rimOuterRadiusLdu = Math.max(...rimSections.flat().map(([x, y]) => Math.hypot(x, y)));
    const tyreInnerRadiusLdu = Math.min(...tyreSections.map(([a, b]) => {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const fraction = Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / (dx * dx + dy * dy)));
      return Math.hypot(a[0] + dx * fraction, a[1] + dy * fraction);
    }));
    samples.push({ hostZ: z, rimOuterRadiusLdu, tyreInnerRadiusLdu,
      envelopeDifferenceLdu: tyreInnerRadiusLdu - rimOuterRadiusLdu });
  }
  return { axisInHost: [0, 0, 1], sectionStepLdu: 1, samples,
    interpretation: 'Radii are extrema across each section. Angular alignment and material compliance are unmeasured.' };
}

const documented = [];
for (const target of targets.ldrawHelpPairs) {
  const path = `parts/${target.host}.dat`, bytes = readFileSync(resolve(ldraw, path)), text = bytes.toString();
  if (inventory.sources[path] !== sha256(bytes)) throw new Error(`HELP source differs from frozen inventory: ${path}`);
  let parsedText = text;
  if (target.inlineHelp) parsedText = text.replace(/^(0 !HELP) [^\r\n:]+:[ \t]*(1 [^\r\n]+)$/gm, '$1 $2');
  if (target.unnamedKatanaHint) parsedText = text.replace(/^(0 !HELP) Place (?:first|second) katana at:[ \t]+([-.\d \t]+)(?=\r?$)/gm,
    (_, prefix, coordinates) => `${prefix} 1 16 ${coordinates.trim()} ${target.insert}.dat`);
  const hints = attachmentHintsFromLDraw(parsedText).filter(h => h.part === `${target.insert}.dat`);
  const resolvedInsert = target.insert === '30173' ? '30173a' : target.insert;
  let aliasEvidence: { path: string; sha256: string } | undefined;
  if (resolvedInsert !== target.insert) {
    const path = `parts/${target.insert}.dat`, bytes = readFileSync(resolve(ldraw, path));
    const hash = sha256(bytes);
    const commands = parseLDraw(bytes.toString(), target.insert).cmds.filter(cmd => cmd.t !== 'bfc');
    const reference = commands[0];
    if (hash !== inventory.sources[path] || commands.length !== 1 || reference?.t !== 'ref' ||
        reference.invert || reference.file !== `${resolvedInsert}.dat` ||
        !matrix(reference.m, reference.pos).equals(new Matrix4())) {
      throw new Error(`Non-identical alias frame: ${target.insert}`);
    }
    aliasEvidence = { path, sha256: hash };
  }
  for (const h of hints) {
    const transform = matrix(h.m, h.pos);
    documented.push({ ...target, resolvedInsert, seat: { m: h.m, pos: h.pos }, mirrored: h.mirrored,
      evidence: target.unnamedKatanaHint ? 'part-author-pose-with-insert-variant-assumed' : 'part-author-placement',
      aliasEvidence,
      source: { path, line: h.line, sha256: sha256(bytes), attribution:
        text.split(/\r?\n/).filter(l => /^0 (?:Author:|!LICENSE)/.test(l)) },
      geometry: h.mirrored ? { status: 'reflection-only' } : measure(target.host, resolvedInsert, transform, target.withdrawalAxisInInsert),
      radialProfile: target.kind === 'tyre-seat' && !h.mirrored ? tyreProfile(target.host, resolvedInsert, transform) : undefined });
  }
  if (!hints.length) failure(path, `No matching placement for ${target.insert}`);
}

const known = new Map(targets.modelPairs.map(p => [pairKey(p.host, p.insert), p]));
const discover = new Set([...targets.discoverAroundHosts, ...familyParts.keys()]);
const hosts = new Set([...discover, ...targets.modelPairs.map(p => p.host)]);
const presence = new Map<string, Set<string>>();
type Instance = { id: string; world: Matrix4; path: string[] };
const candidates = new Map<string, { host: string; insert: string; kind: string; seat: ReturnType<typeof pose>;
  geometry: ReturnType<typeof measure>; observations: { set: string; url: string; modelHash: string; attribution: string[]; hostPath: string[]; insertPath: string[]; seat: ReturnType<typeof pose> }[] }>();
let scanned = 0, relevant = 0, skippedEmbeddedInstances = 0, skippedNonRigidInstances = 0, skippedReflectedInstances = 0;
const embeddedFamilyReferences = new Map<string, Set<string>>();
const checkedPairs = new Set<string>();
for (const source of manifest) {
  let bytes: Buffer;
  try {
    const path = resolve(corpus, source.file);
    if (!path.startsWith(corpus + sep)) throw new Error('Model path is outside the corpus');
    bytes = readFileSync(path);
  } catch (error) { failure(source.file, error); continue; }
  scanned++;
  if (scanned % 250 === 0) console.log(`Scanned ${scanned}/${manifest.length} model files; ${candidates.size} candidate poses`);
  const text = bytes.toString();
  const refs = new Set(Array.from(text.matchAll(/^\s*1(?:[ \t]+\S+){13}[ \t]+([a-z0-9_-]+)\.dat\s*$/gim), m => m[1].toLowerCase()));
  for (const match of text.matchAll(/^0 FILE +[^\r\n]+? - ([a-z0-9_-]+)\.dat\s*$/gim)) {
    const id = match[1].toLowerCase();
    if (!hosts.has(id)) continue;
    const sets = embeddedFamilyReferences.get(id) ?? new Set<string>();
    sets.add(source.set); embeddedFamilyReferences.set(id, sets);
  }
  if (![...hosts].some(id => refs.has(id))) continue;
  relevant++;
  const model = parseMpd(text), instances: Instance[] = [];
  const walk = (name: string, parent: Matrix4, path: string[], stack: string[]) => {
    if (stack.includes(name) || stack.length > 32) { failure(source.file, `Invalid hierarchy at ${name}`); return; }
    const block = model.files.get(name);
    if (!block) return;
    block.cmds.forEach((cmd, index) => {
      if (cmd.t !== 'ref') return;
      const nextPath = [...path, `${name}#${index + 1}`];
      const world = parent.clone().multiply(matrix(cmd.m, cmd.pos));
      if (partName.test(cmd.file)) {
        if (model.files.has(cmd.file)) { skippedEmbeddedInstances++; return; }
        const id = cmd.file.slice(0, -4);
        if (!inventoryIds.has(id)) return;
        const parity = orthogonalBasisParity(pose(world).m);
        if (parity === -1) { skippedReflectedInstances++; return; }
        if (parity === 0) { skippedNonRigidInstances++; return; }
        instances.push({ id, world, path: nextPath });
        if (hosts.has(id)) {
          const observations = presence.get(id) ?? new Set<string>();
          observations.add(source.set); presence.set(id, observations);
        }
      } else if (model.files.has(cmd.file)) walk(cmd.file, world, nextPath, [...stack, name]);
    });
  };
  walk(model.main, new Matrix4(), [], []);
  const modelHash = sha256(bytes);
  const attribution = (model.raw.get(model.main) ?? '').split(/\r?\n/).filter(line => /^0 (?:Author:|!LICENSE)/i.test(line));
  for (const host of instances.filter(p => hosts.has(p.id))) {
    const inverse = host.world.clone().invert();
    const hostGeom = geometry(host.id);
    if (!hostGeom) continue;
    const hostCenter = new Vector3().setFromMatrixPosition(host.world);
    const range = hostGeom.bounds.getSize(new Vector3()).length() / 2 + hostGeom.bounds.getCenter(new Vector3()).length() + 75;
    for (const insert of instances) {
      if (insert === host || insert.id === host.id) continue;
      const pair = pairKey(host.id, insert.id), target = known.get(pair);
      if (!target && !discover.has(host.id)) continue;
      if (!target && familyParts.get(host.id)?.family === 'wheel-rim-and-tyre' &&
          familyParts.get(insert.id)?.family !== 'wheel-rim-and-tyre') continue;
      if (!target && new Vector3().setFromMatrixPosition(insert.world).distanceTo(hostCenter) > range) continue;
      const relative = inverse.clone().multiply(insert.world), seat = pose(relative);
      if (orthogonalBasisParity(seat.m) !== 1) continue;
      // Quantization only groups near-identical poses across model authors. The
      // unrounded matrix and position of every observation remain in the report.
      const key = `${pair}:${[...seat.pos, ...seat.m.map(v => v * 20)].map(v => Math.round(v * 4)).join(',')}`;
      if (!candidates.has(key)) {
        if (checkedPairs.has(key)) continue;
        checkedPairs.add(key);
        const insertGeom = geometry(insert.id);
        if (!insertGeom || !hostGeom.bounds.clone().expandByScalar(1).intersectsBox(insertGeom.bounds.clone().applyMatrix4(relative))) continue;
        const result = measure(host.id, insert.id, relative, target?.withdrawalAxisInInsert);
        if (result.nearestSurfaceDistanceBelow4Ldu == null || result.nearestSurfaceDistanceBelow4Ldu > 1) continue;
        candidates.set(key, { host: host.id, insert: insert.id, kind: target?.kind ?? 'nearby-surfaces', seat, geometry: result, observations: [] });
      }
      candidates.get(key)!.observations.push({ set: source.set, url: source.url, modelHash, attribution, hostPath: host.path, insertPath: insert.path, seat });
    }
  }
}

const pairs = [...candidates.values()];
const ids = new Set([...familyParts.keys(), ...[...pairs, ...documented].flatMap(p => [p.host, 'resolvedInsert' in p ? p.resolvedInsert : p.insert])]);
const referenceFile = resolve(output, 'reference-library.jsonl');
const shadow: Record<string, number> = {};
const shadowSnaps = new Map<string, Snap[]>();
for await (const line of createInterface({ input: createReadStream(referenceFile), crlfDelay: Infinity })) {
  const row = JSON.parse(line);
  if (ids.has(row.id)) {
    shadow[row.id] = row.connectors.length;
    shadowSnaps.set(row.id, row.connectors);
  }
}
function shadowCheck(host: string, insert: string, seat: ReturnType<typeof pose>, mirrored = false) {
  if (mirrored) return 'reflection-skipped';
  const hostSnaps = shadowSnaps.get(host), insertSnaps = shadowSnaps.get(insert);
  if (!hostSnaps || !insertSnaps) return 'missing-reference-export-row';
  if (!hostSnaps.length || !insertSnaps.length) return 'no-shadow-records-on-one-or-both-parts';
  return hasSnapMate(worldSnaps(hostSnaps, new Matrix4().elements), worldSnaps(insertSnaps, matrix(seat.m, seat.pos).elements))
    ? 'web-matcher-found-a-shadow-mate' : 'web-matcher-found-no-shadow-mate';
}
const evaluatedDocuments = documented.map(p => ({ ...p, shadowCheck: shadowCheck(p.host, p.resolvedInsert, p.seat, p.mirrored) }));
const evaluatedPairs = pairs.map(p => ({ ...p, representativePoseShadowCheck: shadowCheck(p.host, p.insert, p.seat) }));
const sourceManifest = JSON.parse(readFileSync(`${referenceFile}.manifest.json`, 'utf8'));
const noMate = (status: string) => status === 'web-matcher-found-no-shadow-mate' || status === 'no-shadow-records-on-one-or-both-parts';
const summary = { manifestEntries: manifest.length, modelFilesRead: scanned, relevantModelFiles: relevant, documentedPoses: documented.length,
  prioritizedInventoryParts: familyParts.size,
  modelPoseCandidates: pairs.length, distinctModelPairs: new Set(pairs.map(p => pairKey(p.host, p.insert))).size,
  targetModelPairCandidates: pairs.filter(p => p.kind !== 'nearby-surfaces').length,
  modelObservations: pairs.reduce((n, p) => n + p.observations.length, 0),
  documentedPosesWithAtLeastOneZeroShadowPart: documented.filter(p => shadow[p.host] === 0 || shadow[p.resolvedInsert] === 0).length,
  documentedPosesWithNoWebShadowMate: evaluatedDocuments.filter(p => noMate(p.shadowCheck)).length,
  modelPoseCandidatesWithNoWebShadowMate: evaluatedPairs.filter(p => noMate(p.representativePoseShadowCheck)).length,
  skippedEmbeddedInstances, skippedNonRigidInstances, skippedReflectedInstances, issues: failures.length };
const documentedHosts = new Set(documented.map(p => p.host)), candidateHosts = new Set(pairs.map(p => p.host));
const familyQueue = [...familyParts].map(([id, details]) => ({ id, ...details, shadowConnectorCount: shadow[id] ?? null,
  documentedPlacement: documentedHosts.has(id), nearbyModelCandidate: candidateHosts.has(id),
  modelSets: [...presence.get(id) ?? []].sort(), embeddedNameCandidateSets: [...embeddedFamilyReferences.get(id) ?? []].sort(),
}));
const report = { format: 'brickmotion-assembly-use-cases', version: 1, fullCoverage: false, units: 'LDU', summary, inventoryHash: inventory.inventoryHash,
  corpus: { url: 'https://library.ldraw.org/omr', manifestSha256: sha256(manifestBytes) },
  shadow: { reference: sourceManifest.reference, interpretation: sourceManifest.interpretation, connectorCountByPart: shadow },
  documented: evaluatedDocuments, modelCandidates: evaluatedPairs, familyQueue, instructionEvidence: targets.instructionEvidence,
  targetPairsWithoutModelCandidates: targets.modelPairs.filter(t => !pairs.some(p => p.host === t.host && p.insert === t.insert)),
  issues: failures,
  limits: ['Model proximity within 1 LDU is a review candidate. It may be incidental or an ordinary snap.',
    'Model placements have one observation frame per model occurrence. Embedded custom parts and non-rigid frames are skipped.',
    'Free discovery filters by part descriptions and proximity of the part origins before the mesh test. Far-origin and variant cases may be missed.',
    'Positive shadow counts give no evidence that the particular interaction is represented.',
    'Shadow mate checks exercise the web matcher with only exported shadow records. A matching result may be a different interface on the same pair.',
    'Mesh surface tests report contact and crossings alike. Discrete sweeps can miss collisions and containment.',
    'Probe directions are geometry hypotheses. Physical clearance, engagement, freedom and travel remain unverified.'],
};
mkdirSync(output, { recursive: true });
const path = resolve(output, 'assembly-use-cases.json');
writeFileSync(`${path}.tmp`, JSON.stringify(report) + '\n');
renameSync(`${path}.tmp`, path);
console.log(JSON.stringify(summary));
