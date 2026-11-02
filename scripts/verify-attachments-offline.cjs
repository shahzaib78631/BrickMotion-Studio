/* Verify precision-attachment metadata and graph matching without fetching
 * any parts, using three.js, or requiring the test runner. The full Vitest
 * suite exercises placement UI and collisions when npm dependencies exist. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { root, transpile, typecheck } = require('./offline-ts.cjs');
const source = [
  'src/ldraw/parse.ts', 'src/ldraw/attachmentHints.ts',
  'src/ldraw/attachments.ts', 'src/model/attachmentPlacements.ts',
];
const errors = typecheck(source);
if (errors) { process.stderr.write(`${errors}\n`); process.exit(1); }
// Parse the touched UI/editor modules, too. Their external imports cannot be
// type checked offline without node_modules; don't disguise that limitation.
const integration = [
  'src/ldraw/library.ts', 'src/ldraw/flatten.ts', 'src/ldraw/metrics.ts',
  'src/model/validate.ts', 'src/anim/construction/types.ts',
  'src/anim/construction/connections.ts', 'src/plan/placementEngine.ts',
  'src/state/placing.ts', 'src/state/appSettings.ts', 'src/storage/settings.ts',
  'src/ui/PartsPanel.tsx', 'src/ui/ViewportChrome.tsx',
];
for (const file of integration) transpile(file);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brickmotion-attachments-'));
try {
  for (const file of source) {
    const target = path.join(dir, file.replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, transpile(file));
  }
  const { attachmentHintsFromLDraw, properRigidBasis, orthogonalBasisParity } =
    require(path.join(dir, 'src/ldraw/attachmentHints.js'));
  const { parseLDraw } = require(path.join(dir, 'src/ldraw/parse.js'));
  const { attachmentSlotsFor, canonicalAttachmentPart, setReviewedAttachmentProfiles } =
    require(path.join(dir, 'src/ldraw/attachments.js'));
  const { attachmentLocalMatrix, attachmentFit, availableAttachmentTargets,
    discoverPlacedAttachments, multiplyAttachmentMatrices, inverseAttachmentWorldMatrix } =
    require(path.join(dir, 'src/model/attachmentPlacements.js'));

  const HELPS = `0 Minifig Scabbard for Two Swords with Bar
0 Name: 19141.dat
0 Author: Gerald Lasser [GeraldLasser]
0 !LDRAW_ORG Part UPDATE 2018-02
0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt

0 !HELP Positioning of Swords
0 !HELP 1 1 -.174 -9 35.1 0 -.01745 -.99985 -1 0 0 0 .99985 -.01745 30173.dat
0 !HELP 1 1 -35.1 -5 .174 0 -.99985 .01745 -1 0 0 0 .01745 .99985 30173.dat`;
  const I = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const [a,b] = attachmentSlotsFor('19141','30173');
  const sword = (id, slot=a, hostWorld=I) => ({ id, part:'30173', world:multiplyAttachmentMatrices(hostWorld,attachmentLocalMatrix(slot)) });
  const host = { id:'h', part:'19141', world:I };
  let passed = 0;
  function check(name, fn) { fn(); passed++; process.stdout.write(`  PASS  ${name}\n`); }

  check('official HELP parses exactly two true LDraw type-1 reference poses', () => {
    const file = parseLDraw(HELPS, '19141.dat');
    assert.equal(file.attachmentHints.length,2);
    assert.deepEqual(file.attachmentHints.map((h) => h.line),[8,9]);
    assert.deepEqual(file.attachmentHints.map((h) => h.mirrored),[false,true]);
    assert.equal(file.cmds.some((c) => c.t === 'ref'),false);
  });
  check('one official source pose is rigid; the other is reflected (not a rotation)', () => {
    assert.equal(orthogonalBasisParity(a.m),1);
    assert.equal(orthogonalBasisParity(b.m),-1);
    assert.equal(properRigidBasis(a.m),true);
    assert.equal(properRigidBasis(b.m),false);
  });
  check('arbitrary comments, paths, scaling, shear and invalid numbers are ignored', () => {
    assert.deepEqual(attachmentHintsFromLDraw('0 // !HELP 1 1 0 0 0 1 0 0 0 1 0 0 0 1 x.dat'),[]);
    assert.deepEqual(attachmentHintsFromLDraw('0 !HELP 1 1 0 0 0 1 0 0 0 1 0 0 0 1 ../x.dat'),[]);
    assert.deepEqual(attachmentHintsFromLDraw('0 !HELP 1 1 0 0 0 2 0 0 0 1 0 0 0 1 x.dat'),[]);
    assert.deepEqual(attachmentHintsFromLDraw('0 !HELP 1 1 0 0 0 1 1 0 0 1 0 0 0 1 x.dat'),[]);
    assert.deepEqual(attachmentHintsFromLDraw('0 !HELP 1 1 NaN 0 0 1 0 0 0 1 0 0 0 1 x.dat'),[]);
  });
  check('aliases are frame-safe; unrelated katana mould variants are not approved', () => {
    assert.equal(canonicalAttachmentPart('parts/30173.dat'),'30173a');
    assert.equal(attachmentSlotsFor('19141','30173a').length,2);
    assert.equal(attachmentSlotsFor('19141','30173b').length,0);
    assert.equal(attachmentSlotsFor('19140','30173').length,0);
  });
  check('both LDraw slots validate under exact-pose matching, including reflection', () => {
    assert.ok(attachmentFit(I,sword('a').world,a));
    assert.ok(attachmentFit(I,sword('b',b).world,b));
    assert.equal(attachmentFit(I,sword('b',b).world,a),null);
    assert.deepEqual(discoverPlacedAttachments([host,sword('a'),sword('b',b)]).map((m) => m.slot.id),[a.id,b.id]);
  });
  check('translations and quarter-turn host rotations preserve mate coordinates', () => {
    const R = [0,0,-1,0,0,1,0,0,1,0,0,0,70,-20,-40,1];
    assert.ok(attachmentFit(R,sword('s',a,R).world,a));
    const composed = multiplyAttachmentMatrices(inverseAttachmentWorldMatrix(R),R);
    composed.forEach((n,i) => assert.ok(Math.abs(n-I[i])<1e-8));
  });
  check('a sword 0.9 LDU away is not connected', () => {
    const moved=[...sword('s').world]; moved[12]+=.9;
    assert.equal(attachmentFit(I,moved,a),null);
  });
  check('nearby but wrongly oriented sword is not connected', () => {
    const badRotation=[Math.cos(.1),0,-Math.sin(.1),0,0,1,0,0,Math.sin(.1),0,Math.cos(.1),0,0,0,0,1];
    assert.equal(attachmentFit(I,multiplyAttachmentMatrices(sword('s').world,badRotation),a),null);
  });
  check('scale and shear cannot forge a joint', () => {
    const scaled=[...I]; scaled[0]=2;
    assert.equal(attachmentFit(scaled,sword('s').world,a),null);
  });
  check('slot occupancy accounts for every stationary sword', () => {
    assert.deepEqual(availableAttachmentTargets(sword('m'),[host,sword('occupied')],false,true).map((t)=>t.slot.id),[b.id]);
    assert.equal(availableAttachmentTargets(sword('m'),[host,sword('occupied'),sword('other',b)],false,true).length,0);
  });
  check('mirrored references require explicit user permission to offer as targets', () => {
    assert.deepEqual(availableAttachmentTargets(sword('m'),[host],false,false).map((t)=>t.slot.id),[a.id]);
    assert.deepEqual(availableAttachmentTargets(sword('m'),[host],false,true).map((t)=>t.slot.id),[a.id,b.id]);
  });
  check('unreviewed HELP does not become an implicit connection', () => {
    const h=attachmentHintsFromLDraw('0 !HELP Example\n0 !HELP 1 16 5 6 7 1 0 0 0 1 0 0 0 1 99999.dat');
    assert.equal(attachmentSlotsFor('other','99999',h).length,0);
    assert.equal(attachmentSlotsFor('other','99999',h,true)[0].evidence,'unreviewed-ldraw-help');
    assert.equal(discoverPlacedAttachments([{id:'h',part:'other',world:I,hints:h},{id:'s',part:'99999',world:I}]).length,0);
  });
  check('two swords in one slot produce no unambiguous connection', () => {
    assert.deepEqual(discoverPlacedAttachments([host,sword('a'),sword('b')]),[]);
    assert.deepEqual(discoverPlacedAttachments([host,{...host,id:'h2'},sword('a')]),[]);
  });
  check('registered profiles require valid reviewed evidence, exact parity and unique slots', () => {
    assert.throws(()=>setReviewedAttachmentProfiles([{...a,id:'bad',source:'http://example.com'}]));
    assert.throws(()=>setReviewedAttachmentProfiles([{...a,id:'bad',mirrored:true}]));
    assert.throws(()=>setReviewedAttachmentProfiles([a]));
    assert.throws(()=>setReviewedAttachmentProfiles([{...a,id:'duplicate',evidence:'reviewed-profile',reviewer:'QA Team',reviewedAt:'2026-11-02'}]));
    const profile={...a,id:'19141:custom',pos:[5,12,3],evidence:'reviewed-profile',reviewer:'QA Team',reviewedAt:'2026-11-02'};
    setReviewedAttachmentProfiles([profile]);
    assert.equal(attachmentSlotsFor('19141','30173').length,3);
    setReviewedAttachmentProfiles([]);
    assert.equal(attachmentSlotsFor('19141','30173').length,2);
  });
  console.log(`\n${passed} offline attachment regressions passed; pure core typechecked; ${integration.length} integration modules syntax-checked.`);
} finally {
  fs.rmSync(dir,{recursive:true,force:true});
}
