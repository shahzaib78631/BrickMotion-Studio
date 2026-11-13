"""Materialize reviewed corpus labels and an independently annotated City test.

Only decisions explicitly accepted in arrow-corpus-review.json enter the corpus.
New proposal crops have partial arrow labels: other visible heads are unknown.
"""
from pathlib import Path
import json,sys,hashlib
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
import cv2,numpy as np,pymupdf
from brickheadz.arrow_annotations import validate_instances


def main():
    directory=ROOT/'.cache/instructions/arrow-corpus/proposals'
    proposals=json.loads((directory/'filtered.json').read_text())['samples'];by_id={r['id']:r for r in proposals}
    review_path=ROOT/'benchmarks/instructions/arrow-corpus-review.json';review=json.loads(review_path.read_text())
    result=json.loads((ROOT/'benchmarks/instructions/arrow-direction-expanded-labels.json').read_text())
    for row in result['samples']:
        for arrow in row['arrow_instances']:
            arrow.setdefault('mark_id',arrow['id']);arrow.setdefault('kind','single-headed')
    for decision in review['decisions']:
        if not decision['accepted']:continue
        row=by_id[decision['id']].copy();tip=np.array(row['proposalTip']);base=np.array(row['proposalHeadBase'])
        endpoints=np.array(row['endpoints'])
        if decision['flip']:
            tip=max(endpoints,key=lambda p:np.linalg.norm(p-tip));vector=tip-endpoints.mean(0);base=tip-vector/np.linalg.norm(vector)*20
        tips=[tip.tolist()];bases=[base.tolist()];bidirectional=row['set']=='42606' and row['page']==60
        if bidirectional:
            other=max(endpoints,key=lambda p:np.linalg.norm(p-tip));v=other-endpoints.mean(0)
            tips.append(other.tolist());bases.append((other-v/np.linalg.norm(v)*20).tolist())
        row.update({'panel':None,'reviewed':True,'studs':[],'arrow_tips':tips,'studs_complete':False,'arrows_complete':False,
                    'arrow_instances':[{'id':row['id']+f'-head{i}','mark_id':row['id'],'kind':'bidirectional' if bidirectional else 'single-headed',
                                        'tip':tip,'head_base':base,'shaft':None,'shaft_complete':False,'direction_reviewed':True,'purpose':'motion' if bidirectional else 'unknown',
                                        'provenance':'CV-proposed, coding-agent visually checked against source crop. Base is an approximate directional anchor, not a measured head boundary.'}
                                       for i,(tip,base) in enumerate(zip(tips,bases))],
                    'annotationCompleteness':'Selected reviewed arrowhead(s) only; other visible heads remain unlabelled and must not count as false positives.'})
        decision['pixel_sha256']=row['pixel_sha256'];decision['approvedInstances']=row['arrow_instances']
        for key in ('proposalTip','proposalHeadBase','endpoints'):row.pop(key,None)
        validate_instances(row);result['samples'].append(row)
    review_path.write_text(json.dumps(review,indent=2))
    # Complete test regions were visually inspected without any model predictions.
    sources=json.loads((ROOT/'benchmarks/instructions/arrow-corpus-sources.json').read_text())['booklets']
    source=next(r for r in sources if r['set']=='60312');pdf=pymupdf.open(ROOT/source['path'])
    if hashlib.sha256((ROOT/source['path']).read_bytes()).hexdigest()!=source['sha256']:raise ValueError('City source changed')
    tests=[(10,'seat',[280,140,350,219],[[311,197],[327,211]],[[311,179],[327,191]],None),
           (12,'plate',[282,125,435,258],[[320,214],[375,192]],[[320,196],[375,174]],None),
           (18,'inset',[365,17,485,165],[[395,128],[450,105]],[[395,110],[450,87]],None),
           (18,'callout',[240,160,355,315],[[304,267]],[[304,250]],None),
           (40,'inset',[34,163,162,307],[[111,233],[122,242]],[[111,218],[122,227]],None),
           (40,'callout',[150,150,350,240],[[310,187]],[[294,187]],None),
           (43,'lift',[220,80,385,195],[[259,102],[260,168],[355,108],[354,177]],[[259,118],[260,152],[355,124],[354,161]],['lift-left','lift-left','lift-right','lift-right']),
           (14,'negative',[130,110,415,330],[],[],None),(24,'negative',[130,110,415,330],[],[],None)]
    out=ROOT/'.cache/instructions/arrow-corpus/test-city';out.mkdir(parents=True,exist_ok=True)
    for page,name,box,tips,bases,groups in tests:
        pix=pdf[page-1].get_pixmap(dpi=100,alpha=False,colorspace=pymupdf.csRGB)
        rgb=np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width,3).copy();x0,y0,x1,y1=box;crop=rgb[y0:y1,x0:x1]
        identity=f'60312-p{page}-{name}';path=out/(identity+'.png');cv2.imwrite(str(path),cv2.cvtColor(crop,cv2.COLOR_RGB2BGR))
        tips=[[x-x0,y-y0] for x,y in tips];bases=[[x-x0,y-y0] for x,y in bases]
        arrows=[{'id':identity+f'-head{i}','mark_id':identity+'-'+groups[i] if groups else identity+f'-head{i}',
                 'kind':'bidirectional' if groups else 'single-headed','tip':tip,'head_base':base,'shaft':None,'shaft_complete':False,
                 'direction_reviewed':True,'purpose':'motion' if groups else ('subassembly-callout' if name=='callout' else 'placement'),
                 'provenance':'Coding-agent manual source-image annotation before model evaluation; no independent human annotator. Both ends of lift marks labelled.'}
                for i,(tip,base) in enumerate(zip(tips,bases))]
        row={'id':identity,'booklet':source['booklet'],'set':source['set'],'split':'test','page':page,'panel':None,'image':str(path.relative_to(ROOT)),
             'studs':[],'arrow_tips':tips,'arrow_instances':arrows,'studs_complete':False,'arrows_complete':True,'reviewed':True,
             'pixel_sha256':hashlib.sha256(crop.tobytes()).hexdigest(),'size':[crop.shape[1],crop.shape[0]],'pdfDPI':100,'pageCropPixels':box,
             'sourcePDFSHA256':source['sha256'],'sourceURL':source['sourceURL'],'annotationCompleteness':'All visible arrowheads in the selected region manually checked.'}
        validate_instances(row);result['samples'].append(row)
    result.update({'version':2,'developmentBooklets':['6668733'],'transferTestBooklets':['6607929'],'validationBooklets':['6493649'],
                   'unitOfAnnotation':'arrowhead instance; bidirectional marks have two heads sharing mark_id',
                   'limitations':'Small coding-agent-reviewed corpus, not independent human ground truth. New training/validation head crops are partial labels: unannotated heads are unknown. City selected regions have complete head labels, not whole-booklet coverage. Entire source booklets are split, with City excluded from training/model selection. Doctor Doom is a development diagnostic. Base lengths are approximate directional anchors.'})
    path=ROOT/'benchmarks/instructions/arrow-direction-corpus-labels.json';path.write_text(json.dumps(result,indent=2))
    for split in ('train','validation','test'):
        subset=[r for r in result['samples'] if r['split']==split];print(split,len(subset),'regions',sum(len(r['arrow_instances']) for r in subset),'heads',sorted({r['booklet'] for r in subset}))

if __name__=='__main__':main()
