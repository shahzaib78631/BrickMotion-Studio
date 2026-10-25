/** Conservative coverage audit for the bundled LEGO 5590 model.
 * Uses LDraw headers and shadow metadata; "reachable" does NOT assert
 * the connector was inherited after SNAP_CLEAR and matching rules.
 * Run: node scripts/audit-v4-5590-mechanics.cjs
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const model=path.join(root,'samples/5590_-_whirl_n_wheel_super_truck.mpd');
// The 5590 MPD is not part of this repository (large sample assets are excluded
// from the delivered patches). The audited result is committed as
// samples/5590-v4-mechanical-coverage.json; only re-running needs the model.
if(!fs.existsSync(model)){
 console.log(`SKIP 5590 mechanics audit: ${path.relative(root,model)} is not present.`);
 console.log('The audited result is committed at samples/5590-v4-mechanical-coverage.json.');
 process.exit(0);
}
const mpd=fs.readFileSync(model,'utf8');
const shadow=JSON.parse(fs.readFileSync(path.join(root,'public/data/ldcad-shadow.json'),'utf8')).files;
const parts=new Map();
for(const line of mpd.split(/\r?\n/)){
 const t=line.trim().split(/\s+/);
 if(t[0]!=='1' || t.length!==15 || !/\.dat$/i.test(t[14]))continue;
 const file=t[14].replace(/\\/g,'/').toLowerCase();parts.set(file,(parts.get(file)??0)+1);
}
function source(part){
 for(const folder of ['parts','p','parts/s','p/8','p/48']){
  const file=path.join(root,'public/ldraw',folder,part);
  if(fs.existsSync(file))return file;
 }
 return null;
}
const cache=new Map();
function reachable(part,depth=0,seen=new Set()){
 if(cache.has(part))return cache.get(part);
 if(depth>16||seen.has(part))return false;
 if(shadow[part])return true;
 const file=source(part);if(!file)return false;
 const rec=new Set(seen);rec.add(part);
 const used=fs.readFileSync(file,'utf8').split(/\r?\n/).some(line=>{
  const t=line.trim().split(/\s+/);if(t[0]!=='1'||t.length!==15)return false;
  const p=t[14].replace(/\\/g,'/').toLowerCase();return reachable(p,depth+1,rec);
 });
 cache.set(part,used);return used;
}
const classify=(d)=>{
 const s=d.toLowerCase();
 if(/\bgear\b/.test(s))return /\bbevel\b/.test(s)?'bevel-gear':/\brack\b/.test(s)?'gear-rack':'spur-gear';
 for(const [pattern,id] of [[/\bturntable\b/,'turntable'],[/\bhinge\b/,'hinge'],[/\b(axle|shaft)\b/,'axle'],[/\bpin\b/,'pin'],[/\b(wheel|tyre|tire)\b/,'wheel-or-tyre']])if(pattern.test(s))return id;
 return 'other';
};
const categories={};let directSnapInstances=0,reachableSnapInstances=0,geometryMissing=[];
const relevant=[];
for(const [part,instances] of [...parts].sort()){
 const src=source(part);if(!src){geometryMissing.push(part);continue;}
 const desc=fs.readFileSync(src,'utf8').split(/\r?\n/)[0].replace(/^0\s+/, '').trim();
 const category=classify(desc);categories[category]=(categories[category]??0)+instances;
 const direct=!!shadow[part],inherited=reachable(part);
 if(direct)directSnapInstances+=instances;
 if(inherited)reachableSnapInstances+=instances;
 if(category!=='other')relevant.push({part,instances,category,description:desc,shadowDirect:direct,
  shadowPossiblyInherited:!direct&&inherited,shadowMissingFromHierarchy:!inherited});
}
const report={schema:'brickmotion-v4-mechanical-coverage-1',geometry:{mpdPartReferences:[...parts.values()].reduce((a,b)=>a+b,0),uniqueDatParts:parts.size,missingDat:geometryMissing},
 metadata:{directShadowInstances:directSnapInstances,shadowReachableInstances:reachableSnapInstances,
  note:'Shadow reachability is only a candidate; effective connector inheritance, matching and restrictions must be checked in the assembled model.'},
 categories,relevant,
 limits:[
 'Bevel gears (4143.dat) and gear racks (3743.dat) are recognized but not coupled automatically; they need authoritative gear geometry and an engagement solver.',
 'No automatically inferred physical angular joint stops, friction coefficients, tolerances, or masses.',
 'Gear 3647.dat has no direct shadow, but axlehole.dat is referenced and has a shadow; effective inherited axle-hole snaps require application-runtime confirmation.',
 'This is a static MPD/header and shadow coverage audit; it is NOT a running 5590 collision benchmark.'
 ]};
const output=path.join(root,'samples/5590-v4-mechanical-coverage.json');
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({counts:report.geometry,categories,autoSnapCandidates:reachableSnapInstances,relevant:relevant.length},null,2));
