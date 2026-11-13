"""Reconstruct a small booklet from reviewed image/part observations; no answer key imported."""
from pathlib import Path
import sys,json,time,argparse,hashlib
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
import cv2,numpy as np
from assembly_model.ldraw import load_library
from booklet_mpd.smallset.search import fit_first,advance,advance_compound,advance_units,fourfold_units,Hypothesis
from booklet_mpd.flagged_mpd import write_flagged_mpd


def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',type=Path,default=ROOT/'benchmarks/booklet-mpd/30023-small-set-input.json');p.add_argument('--max-steps',type=int,default=9);p.add_argument('--beam',type=int,default=8);p.add_argument('--resume',type=Path);args=p.parse_args()
 d=json.loads(args.input.read_text())
 import booklet_mpd.smallset.search as search
 search.COAXIAL_STACK='round-tower-sections-share-an-axis' in d.get('structuralConstraints',[])
 out=ROOT/'.cache/booklet-mpd'/f'small-set-{d["set"]}'/'search';out.mkdir(exist_ok=True);lib=load_library(str(ROOT/'public/ldraw'));states=[];history=[]
 occurrences={}
 for st in d['steps']:
  for colour in {c for p,c in st['newParts']}:occurrences.setdefault(colour,[]).append(st['number'])
 anchors=tuple(c for c,steps in occurrences.items() if len(steps)==1 and steps[0]<=2)
 if args.resume:
  saved=json.loads(args.resume.read_text());groups=[[(p,c,np.array(m)) for p,c,m in g] for g in saved['groups']]
  from booklet_mpd.solver.render import View
  states=[Hypothesis([x for g in groups for x in g],View(**saved['view']),saved['scalePoints'],saved['history'][-1]['score'],groups,anchors)];history=saved['history']
 for step in d['steps'][:args.max_steps]:
  if step['number']<=len(history):continue
  started=time.time();rgb=cv2.cvtColor(cv2.imread(str(ROOT/step['image'])),cv2.COLOR_BGR2RGB)
  if hashlib.sha256(rgb.tobytes()).hexdigest()!=step['pixelSHA256']:raise ValueError('Source pixels changed: '+step['image'])
  parts=[tuple(p) for p in step['newParts']]
  if not states:states=fit_first(lib,parts,rgb,step['ptsPerPixel'],keep=args.beam,log=lambda r:print(json.dumps(r),flush=True))
  else:
   proposed=[]
   for h in states:
    if step.get('compound'):proposed.extend(advance_compound(lib,h,step['compound'],rgb,step['ptsPerPixel']))
    elif any(u[0]=='fourfold' for u in fourfold_units(lib,parts)):proposed.extend(advance_units(lib,h,parts,rgb,step['ptsPerPixel']))
    else:proposed.extend(advance(lib,h,parts,rgb,step['ptsPerPixel']))
   proposed.sort(key=lambda h:-h.score);states=proposed[:args.beam]
  if not states:raise RuntimeError(f'No complete hypothesis at step {step["number"]}')
  for state in states:state.anchors=anchors
  h=states[0];history.append({'step':step['number'],'parts':len(h.model),'score':h.score,'seconds':time.time()-started});print(json.dumps(history[-1]),flush=True)
  write_flagged_mpd(out/'model.mpd',d['set'],h.groups,[[0.]*len(g) for g in h.groups],.5)
  (out/'model.json').write_text(json.dumps({'set':d['set'],'groups':[[(p,c,m.tolist()) for p,c,m in group] for group in h.groups],'view':{'yaw':h.view.yaw,'pitch':h.view.pitch,'scale':h.view.scale,'offset':h.view.offset},'anchorCodes':list(anchors),'scalePoints':h.scale_points,'history':history,'perception':d['perception'],'structuralConstraints':d.get('structuralConstraints',[]),'inputSHA256':hashlib.sha256(args.input.read_bytes()).hexdigest()},indent=2))
  (out/f'step-{step["number"]:02d}.json').write_text((out/'model.json').read_text())

if __name__=='__main__':main()
