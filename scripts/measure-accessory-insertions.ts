import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Matrix4, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { attachmentHintsFromLDraw } from '../src/ldraw/attachmentHints';
import { accessoryGeometry, sectionAtY } from './lib/accessory-geometry';

const root = resolve(process.argv[2] ?? 'public/ldraw');
const output = resolve(process.argv[3] ?? '.cache/measurements');
mkdirSync(output, { recursive: true });
// Preserve exact reference examples across the library, including non-accessory
// assemblies. They are not automatically classified as connectors or rigid fits.
const placements = [];
const unparsedHelp: { host: string; line: number; text: string; source: { path: string; sha256: string; license: string | null } }[] = [];
for (const filename of readdirSync(resolve(root, 'parts')).filter(n => /\.dat$/i.test(n)).sort()) {
  const bytes = readFileSync(resolve(root, 'parts', filename)), text = bytes.toString('utf8');
  if (!text.includes('!HELP')) continue;
  const hints = attachmentHintsFromLDraw(text), accepted = new Set(hints.map(h => h.line));
  const source = { path: `parts/${filename}`, sha256: createHash('sha256').update(bytes).digest('hex'),
    license: text.split(/\r?\n/).find(line => line.startsWith('0 !LICENSE')) ?? null };
  for (const hint of hints) placements.push({ host: filename.slice(0, -4), ...hint, source,
    status: hint.mirrored ? 'mirrored-reference-only' : 'documented-placement-unvalidated' });
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^0 !HELP\b/i.test(line) && !accepted.has(i + 1)) unparsedHelp.push({ host: filename.slice(0, -4), line: i + 1, text: line, source });
  });
}
writeFileSync(resolve(output, 'independent-placement-references.json'), JSON.stringify({
  format: 'brickmotion-independent-placement-references', version: 1, fullCoverage: false,
  placements, unparsedHelp,
}, null, 2) + '\n');

const blade = accessoryGeometry(root, 's/30173s01.dat');
// All three parts explicitly reference this exact blade at the identity transform.
// Guard/grip differences still require separate whole-part collision tests.
const variants = ['30173a', '30173b', '21459'];
for (const id of variants) {
  const text = readFileSync(resolve(root, 'parts', `${id}.dat`), 'utf8');
  if (!/^1 16 0 0 0 1 0 0 0 1 0 0 0 1 s[\\/]30173s01\.dat\s*$/m.test(text)) throw new Error(`Blade frame changed: ${id}`);
}
const sections = Array.from({ length: 80 }, (_, i) => sectionAtY(blade.triangles, -18.5 - i));
const measuredBlade = { sourcePart: 's/30173s01.dat', status: 'CAD-profile-measured', units: 'LDU', millimetresPerLdu: 0.4,
  variants, bounds: blade.bounds, axialSpanLdu: blade.bounds.max[1] - blade.bounds.min[1],
  insertionAxisLocalCandidate: [0, -1, 0], sources: blade.sources, sections };
const geometry = (points: number[]) => new BufferGeometry().setAttribute('position', new Float32BufferAttribute(points, 3));
const fits = [], slotSections = [];
for (const pose of placements.filter(p => ['19141', '30177'].includes(p.host) && /^30173(?:a)?\.dat$/.test(p.part))) {
  const host = accessoryGeometry(root, `${pose.host}.dat`), hostMesh = geometry(host.triangles), bvh = new MeshBVH(hostMesh);
  const m = pose.m, p = pose.pos;
  const seated = new Matrix4().set(m[0], m[1], m[2], p[0], m[3], m[4], m[5], p[1], m[6], m[7], m[8], p[2], 0, 0, 0, 1);
  const withdrawal = new Vector3(m[1], m[4], m[7]).normalize();
  // Measure the host in the documented blade frame, preserving actual wall
  // segments rather than approximating a curved rectangular slot as a cylinder.
  const localHost = hostMesh.clone().applyMatrix4(seated.clone().invert());
  const localTree = new MeshBVH(localHost);
  const hostPoints = Array.from(localHost.getAttribute('position').array);
  const walls = sections.map(section => {
    const bounds = section.boundsXZ!;
    const center = new Vector3((bounds.min[0] + bounds.max[0]) / 2, section.y, (bounds.min[1] + bounds.max[1]) / 2);
    const distances = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].map(direction => {
      const hit = localTree.raycastFirst(new Ray(center, new Vector3(...direction)), DoubleSide);
      return hit?.distance ?? null;
    });
    return { y: section.y, probeOrigin: center.toArray(),
      nearestWallDistanceLdu: { positiveX: distances[0], negativeX: distances[1], positiveZ: distances[2], negativeZ: distances[3] },
      hostSection: sectionAtY(hostPoints, section.y) };
  });
  slotSections.push({ host: pose.host, sourceLine: pose.line, coordinateSystem: 'documented sword local frame',
    mirrored: pose.mirrored, status: 'CAD-wall-sections-measured-not-certified-cavity', walls, hostSources: host.sources });
  localHost.dispose();
  if (pose.mirrored) {
    fits.push({ host: pose.host, sourceLine: pose.line, status: 'mirrored-reference-needs-review' });
    hostMesh.dispose(); continue;
  }
  for (const insert of variants) {
    const part = accessoryGeometry(root, `${insert}.dat`), mesh = geometry(part.triangles);
    const samples = Array.from({ length: 61 }, (_, i) => {
      const distanceLdu = i * 2, matrix = seated.clone();
      matrix.setPosition(new Vector3(...p).addScaledVector(withdrawal, distanceLdu));
      return { distanceLdu, surfaceIntersection: bvh.intersectsGeometry(mesh, matrix) };
    });
    fits.push({ host: pose.host, insert, sourceLine: pose.line,
      status: samples.some(s => s.surfaceIntersection) ? 'sampled-surface-intersection-needs-review' : 'sampled-surfaces-clear-unvalidated',
      evidence: insert === '30173a' ? 'documented-placement' : 'shared-blade-placement-candidate',
      seatedPose: { pos: p, m }, withdrawalAxisCandidate: withdrawal.toArray(),
      insertionAxisCandidate: withdrawal.clone().negate().toArray(), samples,
      seatedSurfaceIntersection: samples[0].surfaceIntersection,
      intersectingSampleCount: samples.filter(s => s.surfaceIntersection).length,
      hostSources: host.sources, insertSources: part.sources });
    mesh.dispose();
  }
  hostMesh.dispose();
}
const report = { format: 'brickmotion-accessory-insertion-measurements', version: 1, fullCoverage: false,
  blade: measuredBlade, slotSections, fits, limitations: [
    'Source poses are examples, not physical fit certificates', 'Blade length is not scabbard insertion depth',
    'Straight axial motion is a candidate; curved blade paths may differ',
    '2 LDU discrete surface-intersection samples can miss intermediate collisions and solid containment',
    'Float32 triangle contact may report contact as intersection; no tolerance or friction is inferred',
    'Slot mouth, usable depth, retaining force and physical fit remain unvalidated',
    'Wall rays describe distances from section-envelope centers; they do not prove those centers are in a connected cavity',
  ] };
const sourcePaths = new Set(Object.keys(blade.sources));
for (const fit of fits) if ('hostSources' in fit) {
  Object.keys(fit.hostSources!).forEach(path => sourcePaths.add(path));
  Object.keys(fit.insertSources!).forEach(path => sourcePaths.add(path));
}
const attribution = [...sourcePaths].sort().map(path => {
  const text = readFileSync(resolve(root, path), 'utf8');
  return { path, headers: text.split(/\r?\n/).filter(line => /^0 (?:Author:|!LICENSE)/.test(line)) };
});
writeFileSync(resolve(output, 'accessory-insertions.json'), JSON.stringify(report, null, 2) + '\n');
// Compact, shareable data: retain provenance and directional wall measurements,
// with full triangle/plane segments available in the detailed report above.
writeFileSync(resolve(output, 'accessory-connection-summary.json'), JSON.stringify({
  format: 'brickmotion-accessory-connection-candidates', version: 1, fullCoverage: false,
  units: 'LDU', millimetresPerLdu: 0.4, attribution,
  blade: { ...measuredBlade, sections: sections.map(({ segments: _segments, ...section }) => section) },
  slotSections: slotSections.map(s => ({ ...s, walls: s.walls.map(({ hostSection: _section, ...wall }) => wall) })),
  fits: fits.map(f => 'samples' in f ? { ...f, samples: undefined,
    sweepStepLdu: 2, sweepEndLdu: 120,
    surfaceIntersectionAtWithdrawalsLdu: f.samples!.filter(s => s.surfaceIntersection).map(s => s.distanceLdu) } : f),
  additionalDocumentedPoses: placements.filter(p => p.host === '95348'),
  unresolvedKatanaPoseAnnotations: unparsedHelp.filter(p => p.host === '98132'),
  limitations: report.limitations,
}, null, 2) + '\n');
console.log(JSON.stringify({ documentedPlacements: placements.length, mirroredReferences: placements.filter(p => p.mirrored).length,
  bladeSections: sections.length, fits: fits.map(f => ({ host: f.host, insert: 'insert' in f ? f.insert : null, status: f.status })) }));
