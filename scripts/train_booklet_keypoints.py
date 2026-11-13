"""Train/evaluate dense stud and arrow-tip heads; held-out booklets never select weights."""
from __future__ import annotations
import argparse
import hashlib
import json
import multiprocessing as mp
from pathlib import Path
import sys
import time

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
import cv2
import numpy as np
import torch
from brickheadz.keypoint_data import TRAIN_PARTS,VAL_PARTS,augment,load_reviewed,synthetic_sample,letterbox
from brickheadz.keypoint_model import initialize,tensor_images,targets,loss,predict_maps,evaluate,save,load

_CONTEXT={}

def init_worker(root):
    from assembly_model.ldraw import load_library
    from brickheadz.image_spec import ldconfig_rgb
    _CONTEXT['lib']=load_library(root);_CONTEXT['palette']=ldconfig_rgb(str(Path(root)/'LDConfig.ldr'))


def generate_one(args):
    seed,validation=args
    return synthetic_sample(_CONTEXT['lib'],_CONTEXT['palette'],seed,parts=VAL_PARTS if validation else TRAIN_PARTS)


def dataset(directory,count,validation,seed,workers):
    import brickheadz.keypoint_data as source
    source_hash=hashlib.sha256(Path(source.__file__).read_bytes()).hexdigest()[:10]
    path=directory/f'synthetic-v2-{source_hash}-{count}-{int(validation)}-{seed}.npz';labels=path.with_suffix('.json')
    if path.exists() and labels.exists():
        images=np.load(path)['images'];rows=json.loads(labels.read_text())
        return [{**r,'rgb':im} for r,im in zip(rows,images)]
    rows=[];started=time.time()
    with mp.get_context('spawn').Pool(workers,initializer=init_worker,initargs=(str(ROOT/'public/ldraw'),)) as pool:
        for i,sample in enumerate(pool.imap(generate_one,[(seed+i,validation) for i in range(count)]),1):
            rows.append(sample)
            if i%50==0 or i==count:print(f'generated {i}/{count} {"validation" if validation else "training"} scenes ({time.time()-started:.0f}s)',flush=True)
    np.savez_compressed(path,images=np.stack([r['rgb'] for r in rows]))
    labels.write_text(json.dumps([{k:v for k,v in r.items() if k!='rgb'} for r in rows]))
    return rows


def baseline(samples):
    from brickheadz.booklet_vision import observe
    from brickheadz.keypoint_model import point_counts
    totals=[{'tp':0,'fp':0,'fn':0} for _ in range(2)];details=[]
    for row in samples:
        obs=observe(row['rgb']);pred=[obs.studs[:,:2].tolist(),obs.arrows.tolist()]
        detail={'id':row['id']}
        for index,key in enumerate(('studs','arrow_tips')):
            if not row['complete'][index]:continue
            tp,fp,fn,_errors=point_counts(pred[index],row[key])
            for k,v in [('tp',tp),('fp',fp),('fn',fn)]:totals[index][k]+=v
            detail[key]={'tp':tp,'fp':fp,'fn':fn}
        details.append(detail)
    metrics={}
    for key,r in zip(('studs','arrow_tips'),totals):
        tp,fp,fn=r['tp'],r['fp'],r['fn']
        metrics[key]={**r,'precision':tp/max(1,tp+fp),'recall':tp/max(1,tp+fn),'f1':2*tp/max(1,2*tp+fp+fn)}
    return {'metrics':metrics,'samples':details,'tolerancePixels':4}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path,default=ROOT/'.cache/instructions/keypoint-learning/pilot')
    parser.add_argument('--labels',type=Path,default=ROOT/'benchmarks/instructions/keypoint-labels.json')
    parser.add_argument('--parent',type=Path,default=ROOT/'python/.cache/part_classifier/model2.pt')
    parser.add_argument('--resume',type=Path,help='Warm-start a detector without overwriting its checkpoint')
    parser.add_argument('--arrow-weight',type=float,default=1.)
    parser.add_argument('--real-fraction',type=float,default=.4)
    parser.add_argument('--focus-arrows',type=float,default=0.)
    parser.add_argument('--steps',type=int,default=600)
    parser.add_argument('--train-scenes',type=int,default=500)
    parser.add_argument('--val-scenes',type=int,default=96)
    parser.add_argument('--batch',type=int,default=12)
    parser.add_argument('--workers',type=int,default=4)
    parser.add_argument('--seed',type=int,default=17)
    parser.add_argument('--every',type=int,default=100)
    args=parser.parse_args()
    if min(args.steps,args.train_scenes,args.val_scenes,args.batch,args.workers,args.every)<1:parser.error('counts must be positive')
    if not np.isfinite(args.arrow_weight) or args.arrow_weight<=0:parser.error('arrow weight must be positive and finite')
    if not 0<=args.real_fraction<=1 or not 0<=args.focus_arrows<=1:parser.error('fractions must be in [0,1]')
    out=args.out.resolve();out.mkdir(parents=True,exist_ok=True)
    torch.manual_seed(args.seed);torch.set_num_threads(4);rng=np.random.default_rng(args.seed)
    device='mps' if torch.backends.mps.is_available() else 'cpu'
    reviewed=load_reviewed(args.labels,ROOT)
    real_train=[r for r in reviewed if r['split']=='train'];test=[r for r in reviewed if r['split']=='test']
    synthetic=dataset(out,args.train_scenes,False,args.seed*100003,args.workers)
    validation=dataset(out,args.val_scenes,True,(args.seed+1)*100003,args.workers)
    model,parent=initialize(args.parent,args.seed)
    if args.resume:
        model,_thresholds,_meta=load(args.resume)
        for parameter in model.encoder[0].parameters():parameter.requires_grad=False
        parent={'path':str(args.resume.resolve()),'sha256':hashlib.sha256(args.resume.read_bytes()).hexdigest()}
    model.to(device)
    metadata={'parent':parent,'seed':args.seed,'device':device,'parameters':sum(p.numel() for p in model.parameters()),
              'labelsSHA256':hashlib.sha256(args.labels.read_bytes()).hexdigest(),
              'trainBooklets':sorted({r['booklet'] for r in real_train}),
              'testBooklets':sorted({r['booklet'] for r in test}),
              'testUsedForModelSelection':False,'testRole':'development regression after pilot inspection; not a new blind test','arrowWeight':args.arrow_weight,'syntheticTrainScenes':len(synthetic),'syntheticValidationScenes':len(validation),
              'trainPartIDs':list(TRAIN_PARTS),'validationPartIDs':list(VAL_PARTS),
              'realFraction':args.real_fraction,'arrowFocusProbability':args.focus_arrows,
              'developmentBooklets':json.loads(args.labels.read_text()).get('developmentBooklets',[]),
              'transferTestBooklets':json.loads(args.labels.read_text()).get('transferTestBooklets',[]),
              'realTrainingImages':len(real_train),'realTestImages':len(test),
              'labelCaveat':'CV-proposed and coding-agent visually reviewed, not independent human annotation; incomplete channels excluded'}
    (out/'dataset.json').write_text(json.dumps(metadata,indent=2));print(json.dumps(metadata,indent=2),flush=True)
    decoder=[p for name,p in model.named_parameters() if not name.startswith('encoder.')]
    encoder=[p for name,p in model.named_parameters() if name.startswith('encoder.') and p.requires_grad]
    optimizer=torch.optim.AdamW([{'params':decoder,'lr':8e-4},{'params':encoder,'lr':5e-5}],weight_decay=1e-4)
    best=-1;history=[];started=time.time();accumulated=0
    for step in range(1,args.steps+1):
        model.train();model.encoder[0].eval()
        samples=[]
        for i in range(args.batch):
            is_real=rng.random()<args.real_fraction
            pool=real_train if is_real else synthetic
            samples.append(augment(pool[int(rng.integers(len(pool)))],rng,focus_probability=args.focus_arrows if is_real else 0.))
        x=tensor_images([s['rgb'] for s in samples]).to(device)
        y=tuple(v.to(device) for v in targets(samples))
        value=loss(model(x),y,arrow_weight=args.arrow_weight)
        optimizer.zero_grad();value.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),5);optimizer.step()
        accumulated+=float(value.detach().cpu())
        if step%args.every==0 or step==args.steps:
            maps=predict_maps(model,validation,device)
            thresholds=[]
            for channel,key in enumerate(('studs','arrow_tips')):
                scores=[]
                for threshold in (.1,.2,.3,.4,.5):
                    proposed=[.25,.25];proposed[channel]=threshold
                    score=evaluate(validation,maps,proposed)['metrics'][key]['f1']
                    scores.append((score,threshold))
                thresholds.append(max(scores)[1])
            result=evaluate(validation,maps,thresholds)
            score=sum(r['f1'] for r in result['metrics'].values())/2
            record={'step':step,'loss':accumulated/min(args.every,step),'validation':result['metrics'],
                    'thresholds':thresholds,'seconds':round(time.time()-started,2)}
            accumulated=0;history.append(record);print(json.dumps(record),flush=True)
            if score>best:
                best=score;save(out/'best.pt',model,{**metadata,'step':step,'validationMacroF1':score},thresholds)
            save(out/'latest.pt',model,{**metadata,'step':step},thresholds)
            (out/'history.json').write_text(json.dumps(history,indent=2))
    chosen,thresholds,chosen_metadata=load(out/'best.pt',device)
    # Test labels are used for evaluation only, after checkpoint/threshold selection.
    measured=evaluate(test,predict_maps(chosen,test,device),thresholds)
    current=baseline(test)
    by_booklet={}
    for booklet in sorted({s['booklet'] for s in test}):
        subset=[s for s in test if s['booklet']==booklet]
        by_booklet[booklet]=evaluate(subset,predict_maps(chosen,subset,device),thresholds)
    report={'metadata':chosen_metadata,'thresholds':thresholds,'baseline':current,'learned':measured,
            'automaticPipelineEnabled':False,'history':history,'byBooklet':by_booklet}
    (out/'report.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({'out':str(out),'baseline':current['metrics'],'learned':measured['metrics']},indent=2),flush=True)
    for row,detail in zip(test,measured['samples']):
        image=row['rgb'].copy()
        for key,colour in [('studs',(0,200,0)),('arrow_tips',(200,0,200))]:
            for x,y,confidence in detail['predictions'][key]:
                if 0<=x<image.shape[1] and 0<=y<image.shape[0]:cv2.drawMarker(image,(round(x),round(y)),colour,cv2.MARKER_CROSS,7,1)
        cv2.imwrite(str(out/f'{row["id"]}-predicted.png'),cv2.cvtColor(image,cv2.COLOR_RGB2BGR))
    return 0

if __name__=='__main__':raise SystemExit(main())
