/** Check the exact identified parts and their subfile trees without substituting plain parts. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PartLibrary } from '../src/ldraw/library';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const ldraw=join(root,'public/ldraw');
const manifest=JSON.parse(readFileSync(join(root,'output/book1-parts/book1-parts.json'),'utf8'));
const lib=new PartLibrary(async (p)=>{const file=join(ldraw,p);return existsSync(file)?readFileSync(file,'utf8'):null;});
const memo=new Map<string,Promise<string[]>>();
async function missing(name:string, path=new Set<string>()):Promise<string[]> {
  if(path.has(name))return [];
  const old=memo.get(name);if(old)return old;
  const task=(async()=>{const file=await lib.getFile(name);if(!file)return [name];
    const next=new Set(path).add(name),out=new Set<string>();
    for(const c of file.cmds)if(c.t==='ref')for(const m of await missing(c.file,next))out.add(m);
    return [...out];})();memo.set(name,task);return task;
}
const ids=[...new Set<string>(manifest.steps.flatMap((s:{parts:{partId:string}[]})=>s.parts.map(p=>p.partId)))].sort();
const parts=[];
for(const id of ids){
  const absent=await missing(id+'.dat');
  const flat=await lib.loadPart(id);
  const triangles=flat?[...flat.tris.values(),...flat.doubleSided.values()].reduce((n,x)=>n+x.length/9,0):0;
  let basePart:string|null=null;
  if(!flat&&/pr\d+$/.test(id)){const base=id.replace(/pr\d+$/,'');if(await lib.loadPart(base))basePart=base;}
  parts.push({partId:id,status:!flat?(basePart?'decoration-unavailable':'missing'):absent.length?'incomplete':'available',missingFiles:absent,triangles,basePart});
}
const report={scope:'Exact book-one part IDs and recursive subfile dependencies; no substitutions installed',parts,
  sourceThread:'https://forums.ldraw.org/thread-27738.html',
  suppliedRaw:{path:'/Users/mac/Downloads/89680_raw.dat',part:'89680',usedInSet:false,status:'unofficial raw reference marked Needs Work; not installed'},
  counts:{identifiedPartIds:ids.length,available:parts.filter(p=>p.status==='available').length,decorationUnavailable:parts.filter(p=>p.status==='decoration-unavailable').length,incomplete:parts.filter(p=>p.status==='incomplete').length,missing:parts.filter(p=>p.status==='missing').length}};
writeFileSync(join(root,'output/book1-parts/mesh-audit.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report.counts));
console.log(JSON.stringify(parts.filter(p=>p.status!=='available'),null,2));
