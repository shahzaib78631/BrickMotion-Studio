/** Shared syntax-only parser for the V7/V8 offline checks. Not a typecheck.
 * The project's TypeScript 7 has no JS compiler API, so this uses the esbuild
 * that ships with Vite, and only falls back to a classic TypeScript install. */
const fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
function parser(){
  try{const esbuild=require('esbuild');
    return (name,src)=>{try{esbuild.transformSync(src,{loader:name.endsWith('.tsx')?'tsx':'ts',jsx:'preserve'});return [];}
      catch(e){return (e.errors??[{text:String(e.message??e)}]).map(x=>`${x.location?`line ${x.location.line}: `:''}${x.text}`);}};
  }catch{/* fall through */}
  const ts=require('typescript');
  if(typeof ts.createSourceFile!=='function')throw Error('No syntax parser: install dependencies (esbuild ships with Vite).');
  return (name,src)=>ts.createSourceFile(name,src,ts.ScriptTarget.Latest,true,name.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS)
    .parseDiagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,' '));
}
module.exports=function checkSyntax(label,files){
  const parse=parser();let failures=0;
  for(const name of files){
    const errors=parse(name,fs.readFileSync(path.join(ROOT,name),'utf8'));
    for(const e of errors)console.error(`FAIL ${label} syntax ${name}: ${e}`);
    if(errors.length)failures++;else console.log(`PASS ${label} syntax ${name}`);
  }
  if(failures){process.exitCode=1;console.error(`${failures} ${label} syntax failure(s)`);}
  else console.log(`Checked ${files.length} modules. Syntax only; run npm run build for types.`);
};
