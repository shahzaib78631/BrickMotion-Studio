/** Syntax-only verification for changed V7 app modules when npm packages
 * are unavailable. DOES NOT replace a complete project typecheck or build. */
const fs=require('fs');
const path=require('path');
const {execFileSync}=require('child_process');
let ts;
try{ts=require('typescript');}
catch{
 const root=execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim();
 ts=require(path.join(root,'typescript'));
}
const files=[
 'src/anim/motion/v6/spatialConstraints.ts',
 'src/anim/motion/v6/spatialSweep.ts',
 'src/anim/motion/v6/spatialRig.ts',
 'src/anim/motion/v6/spatialAdapter.ts',
 'src/anim/motion/v6/spatialMechanicProposal.ts',
 'src/state/mechanismLab.ts',
 'src/ui/SpatialMechanicsDesigner.tsx',
 'src/ui/MechanismLabPanel.tsx',
 'src/ui/Viewport.tsx',
];
let failures=0;
for(const name of files){
 const file=path.resolve(__dirname,'..',name);
 const input=fs.readFileSync(file,'utf8');
 const ast=ts.createSourceFile(name,input,ts.ScriptTarget.ES2022,true,
  name.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
 for(const diagnostic of ast.parseDiagnostics){
  console.error(`FAIL ${name}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText,' ')}`);
  failures++;
 }
 if(!ast.parseDiagnostics.length)console.log(`PASS V7 syntax ${name}`);
}
if(failures){process.exitCode=1;console.error(`${failures} V7 syntax issue(s)`);}
else console.log('This is syntax-only evidence; run npm run build with dependencies installed.');
