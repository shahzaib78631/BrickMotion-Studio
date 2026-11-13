"""Materialize explicit visual-review decisions; proposals alone never become labels."""
from pathlib import Path
import json,sys,hashlib,collections
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
import cv2,numpy as np
from brickheadz.keypoint_data import load_reviewed
from brickheadz.arrow_annotations import validate_instances


def main():
    root=ROOT/'.cache/instructions/arrow-catalog-100';catalog=json.loads((root/'catalog.json').read_text())
    review=json.loads((ROOT/'benchmarks/instructions/arrow-catalog-100-review.json').read_text())
    rows=[];sources=[]
    for book in catalog['booklets']:
        proposals=json.loads((root/'annotations'/book['set']/'proposals.json').read_text());accepted=[]
        if hashlib.sha256((ROOT/book['path']).read_bytes()).hexdigest()!=book['sha256']:raise ValueError('PDF source changed')
        for p in proposals['samples']:
            decision=review['decisions'].get(p['id'])
            if not decision or not decision['accepted']:continue
            if decision.get('pixel_sha256')!=p['pixel_sha256'] or decision.get('proposedInstancesAtReview')!=p['arrows']:
                raise ValueError('Proposal changed after review; re-review required')
            rgb=cv2.cvtColor(cv2.imread(str(ROOT/p['image'])),cv2.COLOR_BGR2RGB);h,w=rgb.shape[:2]
            if hashlib.sha256(rgb.tobytes()).hexdigest()!=p['pixel_sha256']:raise ValueError('Reviewed image changed')
            arrows=[];dropped=False
            for i,a in enumerate([] if decision['negative'] else p['arrows']):
                tip=np.array(a['tip']);base=np.array(a['head_base'])
                if np.any(tip<5) or tip[0]>=w-5 or tip[1]>=h-5 or np.any(base<2) or base[0]>=w-2 or base[1]>=h-2:
                    dropped=True;continue
                arrows.append({**a,'id':p['id']+f'-head{i}','mark_id':p['id']+f'-head{i}','kind':'single-headed','shaft':None,'shaft_complete':False,'purpose':'unknown','direction_reviewed':True,'provenance':'Shape-proposed tip and directional anchor visually checked by coding agent against source crop. Anchor length approximate; no independent human review.'})
            if not arrows and not decision['negative']:continue
            complete=decision['complete'] and not dropped
            row={**p,'booklet':book['booklet'],'set':book['set'],'split':book['split'],'panel':None,'reviewed':True,
                 'studs':[],'studs_complete':False,'arrows_complete':complete,'arrow_tips':[a['tip'] for a in arrows],'arrow_instances':arrows,
                 'sourcePDFSHA256':book['sha256'],'sourceURL':book['sourceURL'],'size':[w,h],
                 'annotationCompleteness':'All visible heads checked in selected crop' if complete else 'Selected reviewed heads only; other heads unknown'}
            row.pop('arrows',None);validate_instances(row);rows.append(row);accepted.append(row)
        sources.append({**book,'annotationStatus':'reviewed-selected-regions','acceptedRegions':len(accepted),'acceptedHeads':sum(len(r['arrow_instances']) for r in accepted)})
    # Only the pre-existing TRAIN split is replayed; old validation and test stay excluded.
    old=json.loads((ROOT/'benchmarks/instructions/arrow-direction-corpus-labels.json').read_text())
    rows.extend({**r,'catalogReplay':True} for r in old['samples'] if r['split']=='train')
    # Remove exact artwork duplicates across splits, retaining held-out artwork.
    order={'test':0,'validation':1,'train':2};seen={};unique=[];removed=[]
    for row in sorted(rows,key=lambda r:order[r['split']]):
        h=row['pixel_sha256']
        if h in seen and seen[h]!=row['split']:removed.append(row['id']);continue
        seen[h]=row['split'];unique.append(row)
    new_positive={r['set'] for r in unique if not r.get('catalogReplay') and r['arrow_instances']}
    if len(new_positive)<100:raise ValueError(f'Only {len(new_positive)} positively annotated new booklets')
    summary={split:{'booklets':len({r['booklet'] for r in unique if r['split']==split}),'regions':sum(r['split']==split for r in unique),'heads':sum(len(r['arrow_instances']) for r in unique if r['split']==split),'completeRegions':sum(r['arrows_complete'] for r in unique if r['split']==split)} for split in order}
    data={'version':1,'limitations':'Selected real source-image regions only, not exhaustive whole-booklet annotation. Shape proposals visually reviewed by coding agent, not independent human ground truth. Red/green arrows dominate new catalog. Local directional anchors approximate. Partial regions mask unlabelled heads. Entire sets and PDF hashes held apart. Prior train-only annotations replayed; prior validation/test excluded.',
          'newCatalogBooklets':len(sources),'newPositivelyAnnotatedBooklets':len(new_positive),'duplicateRowsRemoved':removed,'summary':summary,'samples':unique}
    out=ROOT/'benchmarks/instructions/arrow-catalog-100-labels.json';out.write_text(json.dumps(data,indent=2));load_reviewed(out,ROOT)
    (ROOT/'benchmarks/instructions/arrow-catalog-100-sources.json').write_text(json.dumps({'version':1,'booklets':sources},indent=2))
    (root/'annotation-summary.json').write_text(json.dumps({k:v for k,v in data.items() if k!='samples'},indent=2))
    print(json.dumps({k:v for k,v in data.items() if k!='samples'},indent=2))

if __name__=='__main__':main()
