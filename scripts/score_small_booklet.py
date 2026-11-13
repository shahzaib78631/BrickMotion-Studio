"""Evaluation only, deliberately separate from the reconstruction process."""
from pathlib import Path
import argparse,json,sys,hashlib
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
import numpy as np
from assembly_model.ldraw import load_library
from booklet_mpd.solver.mepnet import parse_mpd,flatten
from booklet_mpd.solver.evaluate import aligned,canonical
from booklet_mpd.score import exact_flags


def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--set',default='30023');p.add_argument('--model',type=Path);args=p.parse_args();folder=ROOT/'.cache/booklet-mpd'/f'small-set-{args.set}'/'search';path=args.model or folder/'model.json';d=json.loads(path.read_text());pred=[(p,c,np.array(m)) for g in d['groups'] for p,c,m in g]
 reference=Path('/Users/mac/Projects/BrickMotion-Data/omr/models')/f'{args.set}-1'/f'{args.set}-1.mpd';files=parse_mpd(reference.read_text());truth=flatten(files,next(iter(files)),np.eye(4));truth=[(p.removesuffix('.dat'),c,m) for p,c,m in truth];corrected=[(p,72 if args.set=='30023' and p=='3700' and c==71 else c,m) for p,c,m in truth];lib=load_library(str(ROOT/'public/ldraw'))
 raw,nraw=aligned(lib,pred,truth);moved,n=aligned(lib,pred,corrected);flags=exact_flags(lib,canonical(lib,moved,corrected),corrected)
 from booklet_mpd.smallset.equivalence import externally_equivalent
 used=set();functional=[]
 for part,colour,m in moved:
  hit=None
  for i,(q,c,expected) in enumerate(corrected):
   if i in used or q!=part or c!=colour:continue
   if exact_flags(lib,[(part,colour,m)],[(q,c,expected)])[0] or externally_equivalent(lib,part,m,expected):hit=i;break
  functional.append(hit is not None)
  if hit is not None:used.add(hit)
 report={'predictedParts':len(pred),'referenceParts':len(truth),'rawReferenceExact':nraw,'inventoryCorrectedExact':n,'connectorAndExternalSurfaceEquivalent':sum(functional),'equivalenceToleranceLDU':.5,'perPart':[{'part':p,'colour':c,'exact':f,'externalAndConnectorEquivalent':eq,'matrix':m.tolist()} for (p,c,m),f,eq in zip(pred,flags,functional)],'referenceSHA256':hashlib.sha256(reference.read_bytes()).hexdigest(),'inferenceArtifactSHA256':hashlib.sha256(path.read_bytes()).hexdigest(),'evaluationOnly':True,'correction':'30023 reference 3700 colour 71 -> inventory/source colour 72; no poses altered'};out=path.with_name(path.stem+'-score.json');out.write_text(json.dumps(report,indent=2));print(json.dumps({k:v for k,v in report.items() if k!='perPart'},indent=2))

if __name__=='__main__':main()
