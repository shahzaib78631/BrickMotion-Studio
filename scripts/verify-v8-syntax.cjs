/** Syntax-only TS/TSX parser for modified V8 files, works without npm deps.
 * Not a typecheck or full React/Vite browser integration test. */
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
let ts;
try {ts=require('typescript');}catch{ts=require(path.join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'typescript'));}
const files=[
 'src/anim/motion/v6/spatialConstraints.ts',
 'src/anim/motion/v6/spatialSweep.ts',
 'src/anim/motion/v6/spatialAdapter.ts',
 'src/anim/motion/v6/spatialRig.ts',
 'src/anim/motion/v6/geometryScreen.ts',
 'src/anim/motion/v8/mechanismLaws.ts',
 'src/anim/motion/v8/spatialClip.ts',
 'src/ui/SpatialMechanicsDesigner.tsx',
 'src/ui/MechanismLabPanel.tsx',
];
let count=0;
for(const file of files){
 const kind=file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS;
 const tree=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,kind);
 if(tree.parseDiagnostics.length){
  for(const d of tree.parseDiagnostics)console.error('FAIL V8 syntax',file,ts.flattenDiagnosticMessageText(d.messageText,' '));
  process.exitCode=1;
 }else{console.log('PASS V8 syntax',file);count++;}
}
console.log(`Checked ${count} of ${files.length} modified source modules. Syntax only; build requires dependencies.`);
