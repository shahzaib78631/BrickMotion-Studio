"""Independent recheck of the camera-hypothesis fix; production outputs untouched."""
import sys,json,time,subprocess,hashlib,argparse
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
import cv2,numpy as np
from assembly_model.ldraw import load_library
from booklet_mpd.solver import step,pipeline
from booklet_mpd.solver.collide import Collider
from booklet_mpd.solver.evaluate import canonical,aligned
from booklet_mpd.score import exact_flags
from booklet_mpd.solver.dataset import pairs,extract_of
from booklet_mpd.solver.parts import element_index,rebrickable_client


def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--step2-only',action='store_true');parser.add_argument('--hypotheses',type=int);args=parser.parse_args()
 if args.hypotheses is not None:
  if not 1<=args.hypotheses<=24:parser.error('hypotheses must be between 1 and 24')
  step.HYPOTHESES=args.hypotheses
 out=ROOT/'.cache/booklet-mpd/independent-diagnostics/41488/camera-fix-recheck';out.mkdir(exist_ok=True)
 data=json.loads((ROOT/'benchmarks/booklet-mpd/41488-camera-selection-regression.json').read_text());s=data['sourceImage']
 rgb=cv2.cvtColor(cv2.imread(str(ROOT/s['path'])),cv2.COLOR_BGR2RGB);base=[(p,c,np.array(m)) for p,c,m in s['base']];expected=[(p,c,np.array(m)) for p,c,m in s['added']]
 report={'hypothesisLimit':step.HYPOTHESES,'sourceHashes':{name:hashlib.sha256((ROOT/'python/booklet_mpd/solver'/name).read_bytes()).hexdigest() for name in ['step.py','register.py','pipeline.py','evaluate.py']},'commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'diagnosticOnly':True,'registrationSearches':[]}
 original_search=step.search
 def observed(*args,**kwargs):
  regs=original_search(*args,**kwargs);report['registrationSearches'].append({'refineRequested':kwargs.get('refine'),'returnedOrientations':[r.orientation_index for r in regs],'uniqueOrientations':len({r.orientation_index for r in regs})});return regs
 step.search=observed
 lib=load_library(str(ROOT/'public/ldraw'))
 for p,c,_m in base+expected:
  if not len(lib.triangles(p+'.dat')):raise RuntimeError('Missing geometry: '+p)
 # Use the installed tsx directly: npm exec can wait on package-manager locks.
 from lab import oracle
 original_popen=oracle.subprocess.Popen
 def local_popen(args,*a,**kw):
  if args[:3]==['npx','tsx','scripts/lab-oracle.ts']:args=[str(ROOT/'node_modules/.bin/tsx'),'scripts/lab-oracle.ts']
  return original_popen(args,*a,**kw)
 oracle.subprocess.Popen=local_popen
 report['collisionOracleLauncher']='installed node_modules/.bin/tsx; same lab-oracle.ts'
 collider=Collider(lib)
 try:
  print('Replaying step 2 with correct previous assembly and identities',flush=True);start=time.time()
  result=step.solve(lib,base,[(p,c) for p,c,_m in expected],rgb,s['ptsPerPixel'],collider=collider)
  report['step2CorrectPreviousAndIdentity']={'exact':sum(exact_flags(lib,canonical(lib,result.placed,expected),expected)),'parts':len(expected),'status':result.status,'completedScore':result.completed,'hypotheses':result.hypotheses,'seconds':time.time()-start,'collisionOracleExact':collider.exact,'view':{'orientation':result.view.orientation.tolist() if result.view else None,'yaw':result.view.yaw if result.view else None,'pitch':result.view.pitch if result.view else None}}
  (out/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report['step2CorrectPreviousAndIdentity']),flush=True)
  if args.step2_only:return
  print('Running first two steps from actual PDF and parts reader',flush=True);start=time.time();pair=pairs()['41488'];extract,folder=extract_of('41488')
  run=pipeline.run(lib,pair.pdf,extract,folder,element_index(),collider=collider,client=rebrickable_client(),max_steps=2,log=lambda row:print(json.dumps(row),flush=True))
  moved,n=aligned(lib,run.model,base+expected)
  report['pdfFreeRunFirstTwoSteps']={'exact':n,'expectedParts':len(base+expected),'predictedParts':len(run.model),'partsByStep':[len(g) for g in run.groups],'rows':run.rows,'giveUpFrom':run.failed_from,'unsupportedFrom':run.unsupported_from,'review':run.review,'seconds':time.time()-start}
  report['sourceUnchanged']={name:hashlib.sha256((ROOT/'python/booklet_mpd/solver'/name).read_bytes()).hexdigest()==digest for name,digest in report['sourceHashes'].items()}
  report['headUnchanged']=report['commit']==subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
  (out/'report.json').write_text(json.dumps(report,indent=2));pipeline.write(run,out/'first-two-steps.mpd','41488-first-two',.5);print(json.dumps(report,indent=2),flush=True)
 finally:collider.close()

if __name__=='__main__':main()
