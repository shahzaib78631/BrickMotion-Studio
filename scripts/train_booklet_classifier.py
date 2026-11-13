"""Fine-tune saved video-recognition weights for instruction callout crops.

Booklet split and near-duplicate removal happen before training. Synthetic
validation chooses the checkpoint; held-out booklet metrics are evaluated once,
after training. PDF template labels are silver, explicitly separate from the
small manually audited milestone set. No trained model is enabled automatically.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import multiprocessing as mp
import random
from pathlib import Path
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'python'))
import cv2
import numpy as np

from brickheadz.booklet_classifier import (
    PREPROCESS,adapt_head,classify,fingerprint,load_legacy,metrics,save_checkpoint,split_booklet_rows,
)
from brickheadz.part_classifier import real_part, build_model

_WORKER={}

def init_renderer(root):
    from assembly_model.ldraw import load_library
    from brickheadz.image_spec import ldconfig_rgb
    _WORKER['lib']=load_library(root)
    _WORKER['palette']=ldconfig_rgb(str(Path(root)/'LDConfig.ldr'))


def render_part(args):
    part,number,seed=args
    from brickheadz import part_render as pr
    mesh=pr.PartMesh(_WORKER['lib'],part)
    rng=random.Random(seed);palette=_WORKER['palette']
    colours=[c for c in pr.COLOUR_IDS if c in palette]
    images=[]
    for i in range(number):
        # Reuse the video renderer, with additional fixed-elevation views.
        view=pr.rotation(rng.uniform(15,70),rng.uniform(-45,-25),0) if i%2==0 else pr.random_view(rng)
        image=pr.render(mesh,view,palette[rng.choice(colours)],pr.random_light(rng),size=96,edge=.35)
        if image is None:raise ValueError(f'Cannot render {part}')
        images.append(pr.letterbox(image))
    return part,np.stack(images)


def make_synthetic(vocab,directory,train_per_part=4,seed=7,workers=4):
    key=hashlib.sha256(json.dumps([vocab,train_per_part,seed,'video-renderer-booklet-views-v1']).encode()).hexdigest()
    path=directory/f'synthetic-{key[:12]}.npz'
    if path.exists():
        data=np.load(path);return data['train_x'],data['train_y'],data['val_x'],data['val_y'],path
    jobs=[(part,train_per_part+1,seed*1000003+i*1009) for i,part in enumerate(vocab)]
    images={};started=time.time()
    with mp.get_context('spawn').Pool(workers,initializer=init_renderer,initargs=(str(ROOT/'public/ldraw'),)) as pool:
        for i,(part,batch) in enumerate(pool.imap_unordered(render_part,jobs),1):
            images[part]=batch
            if i%10==0 or i==len(jobs):print(f'rendered {i}/{len(jobs)} classes ({time.time()-started:.0f}s)',flush=True)
    train_x=np.concatenate([images[p][:-1] for p in vocab]);val_x=np.stack([images[p][-1] for p in vocab])
    train_y=np.repeat(np.arange(len(vocab)),train_per_part);val_y=np.arange(len(vocab))
    np.savez_compressed(path,train_x=train_x,train_y=train_y,val_x=val_x,val_y=val_y)
    return train_x,train_y,val_x,val_y,path


def augment_images(images,rng):
    batch=[]
    for image in images:
        h,w=image.shape[:2]
        scale=rng.uniform(.8,1.05);dx,dy=rng.uniform(-2,2,2)
        matrix=np.array([[scale,0,(1-scale)*w/2+dx],[0,scale,(1-scale)*h/2+dy]],np.float32)
        sample=cv2.warpAffine(image,matrix,(w,h),borderMode=cv2.BORDER_CONSTANT)
        sample=np.clip(sample.astype(float)*rng.uniform(.8,1.2)+rng.normal(0,1.5,sample.shape),0,255).astype(np.uint8)
        if rng.random()<.25:sample=cv2.GaussianBlur(sample,(3,3),.5)
        batch.append(sample)
    return np.stack(batch)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job',type=Path,default=ROOT/'.cache/instructions/heroes-complete-regression/placement-job.json')
    parser.add_argument('--parent',type=Path,default=ROOT/'python/.cache/part_classifier/model2.pt')
    parser.add_argument('--parent-vocab',type=Path,default=ROOT/'python/.cache/part_classifier/vocab2.json')
    parser.add_argument('--base-vocab',type=Path,default=ROOT/'python/.cache/part_classifier/vocab1.json')
    parser.add_argument('--out',type=Path,default=ROOT/'.cache/instructions/part-learning/pilot')
    parser.add_argument('--epochs',type=int,default=15)
    parser.add_argument('--batch',type=int,default=64)
    parser.add_argument('--steps-per-epoch',type=int,default=20)
    parser.add_argument('--synthetic-per-part',type=int,default=4)
    parser.add_argument('--workers',type=int,default=4)
    parser.add_argument('--seed',type=int,default=7)
    args=parser.parse_args()
    if min(args.epochs,args.steps_per_epoch,args.synthetic_per_part,args.workers)<1 or args.batch<2:
        parser.error('epochs, steps, synthetic count and workers must be positive; batch must be at least 2')
    import torch
    import torch.nn.functional as F
    from brickheadz.part_classifier import to_tensor
    torch.manual_seed(args.seed);np.random.seed(args.seed);random.seed(args.seed)
    torch.set_num_threads(4)
    device='mps' if torch.backends.mps.is_available() else 'cpu'
    out=args.out.resolve();out.mkdir(parents=True,exist_ok=True)
    job=json.loads(args.job.read_text());rows,excluded=split_booklet_rows(job)
    train=[r for r in rows if r['split']=='train'];test=[r for r in rows if r['split']=='test']
    parent,parent_vocab,width=load_legacy(args.parent,args.parent_vocab)
    base=json.loads(args.base_vocab.read_text());base=[p for p in base if real_part(p,base)]
    model,vocab=adapt_head(parent,parent_vocab,[r['part'] for r in train],seed=args.seed,base_parts=base)
    labels={p:i for i,p in enumerate(vocab)}
    metadata={'parent':{'path':str(args.parent.resolve()),'sha256':hashlib.sha256(args.parent.read_bytes()).hexdigest()},
              'preprocess':PREPROCESS,'seed':args.seed,'device':device,'torch':str(torch.__version__),
              'trainingBooklet':'6668730','testBooklet':'6668732','testUsedForCheckpointSelection':False,
              'trainSamples':len(train),'testSamples':len(test),'nearDuplicateTrainExclusions':len(excluded),
              'classCount':len(vocab),'parameters':sum(p.numel() for p in model.parameters()),
              'trainableParameters':sum(p.numel() for p in model.parameters() if p.requires_grad)}
    manifest={'metadata':metadata,'rows':[{k:v for k,v in r.items() if k!='image'} for r in rows],
              'excludedNearDuplicateTrainRows':excluded,'evaluationCaveat':'Most labels are silver template matches; audited milestone is only three held-out occurrences/two unique artworks.'}
    (out/'dataset.json').write_text(json.dumps(manifest,indent=2))
    print(json.dumps(metadata,indent=2),flush=True)
    # Same vocabulary and preprocessing for the primary before/after comparison.
    initial_state={k:v.detach().cpu().clone() for k,v in model.state_dict().items()}
    sx,sy,vx,vy,synthetic_path=make_synthetic(vocab,out,args.synthetic_per_part,args.seed,args.workers)
    real_x=np.stack([r['image'] for r in train]);real_y=np.array([labels[r['part']] for r in train])
    opt=torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],lr=2e-4,weight_decay=1e-4)
    model.to(device);rng=np.random.default_rng(args.seed);history=[];best=-1;best_epoch=0;started=time.time()
    for epoch in range(args.epochs):
        model.train()
        for block in list(model.children())[:3]:block.eval()
        total=0
        for step in range(args.steps_per_epoch):
            a=rng.integers(0,len(real_x),args.batch//2);b=rng.integers(0,len(sx),args.batch-len(a))
            images=np.concatenate([real_x[a],sx[b]]);ys=np.concatenate([real_y[a],sy[b]])
            xb=to_tensor(augment_images(images,rng)).to(device);yb=torch.tensor(ys,device=device)
            logits=model(xb);loss=F.cross_entropy(logits,yb,label_smoothing=.03)
            opt.zero_grad();loss.backward();opt.step();total+=float(loss.detach().cpu())
        predictions=classify(model,vocab,list(vx),device=device)
        top1=sum(predictions[i][0]['part']==vocab[vy[i]] for i in range(len(vy)))/len(vy)
        record={'epoch':epoch+1,'loss':total/args.steps_per_epoch,'syntheticValidationTop1':top1,'seconds':time.time()-started}
        history.append(record);print(json.dumps(record),flush=True)
        if top1>best:
            best=top1;best_epoch=epoch+1
            save_checkpoint(out/'best.pt',model,vocab,{**metadata,'epoch':best_epoch,'syntheticValidationTop1':best})
        save_checkpoint(out/'latest.pt',model,vocab,{**metadata,'epoch':epoch+1})
        (out/'history.json').write_text(json.dumps(history,indent=2))
    # All evaluation-only labels are read for metrics only after training.
    from brickheadz.booklet_classifier import load_checkpoint
    tuned,_v,_m=load_checkpoint(out/'best.pt',device)
    initial=build_model(len(vocab),width=width)
    initial.load_state_dict(initial_state)
    before=classify(initial,vocab,[r['image'] for r in test],device=device)
    after=classify(tuned,vocab,[r['image'] for r in test],device=device)
    details=[{'booklet':r['booklet'],'step':r['step'],'part':r['part'],'image':r['path'],
              'auditedMilestone':r['auditedMilestone'],'before':b,'after':a} for r,b,a in zip(test,before,after)]
    report={'metadata':metadata,'bestEpoch':best_epoch,'syntheticValidationTop1':best,
            'syntheticDataset':str(synthetic_path),'syntheticDatasetSHA256':hashlib.sha256(synthetic_path.read_bytes()).hexdigest(),'heldOutBefore':metrics(test,before,vocab),
            'heldOutAfter':metrics(test,after,vocab),'evaluationCaveat':manifest['evaluationCaveat'],
            'automaticPipelineEnabled':False,'predictions':details,'history':history}
    (out/'report.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({k:v for k,v in report.items() if k not in ('predictions','history')},indent=2),flush=True)
    return 0

if __name__=='__main__':raise SystemExit(main())
