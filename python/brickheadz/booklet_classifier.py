"""Booklet adaptation of the existing video part classifier.

No 3D pose prediction: this only returns ranked whole-part identities for an
isolated callout crop. Original checkpoints remain unchanged. Training labels
from template matching are explicitly silver, not independent ground truth.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import cv2
import numpy as np

from brickheadz.part_classifier import build_model, real_part
from brickheadz.part_render import letterbox

PREPROCESS='corner-background-28-tight-letterbox64-v1'


def prepare_crop(bgr):
    image=np.asarray(bgr,np.uint8).copy()
    if image.ndim!=3 or image.shape[2]!=3 or min(image.shape[:2])<2:
        raise ValueError('Expected a nonempty BGR part crop')
    bg=np.median([image[0,0],image[0,-1],image[-1,0],image[-1,-1]],axis=0)
    fg=np.linalg.norm(image.astype(float)-bg,axis=2)>=28
    if fg.sum()<4:raise ValueError('No foreground part pixels')
    image[~fg]=0
    yy,xx=np.where(fg)
    return letterbox(image[yy.min():yy.max()+1,xx.min():xx.max()+1])


def fingerprint(image):
    return hashlib.sha256(np.ascontiguousarray(image).tobytes()).hexdigest()


def split_booklet_rows(job,train_booklet='6668730',test_booklet='6668732'):
    rows=[]
    for model in job['models']:
        for step in model['steps']:
            if step['booklet'] not in (train_booklet,test_booklet):continue
            split='train' if step['booklet']==train_booklet else 'test'
            for part in step['parts']:
                if not part['part'] or part['color'] is None or not part['countVerified']:continue
                if part['matchScore']<.9:continue
                image=cv2.imread(part['image'])
                if image is None:raise FileNotFoundError(part['image'])
                prepared=prepare_crop(image)
                rows.append({'booklet':step['booklet'],'step':step['number'],'part':part['part'],
                             'split':split,'path':part['image'],'image':prepared,'hash':fingerprint(prepared),
                             'labelProvenance':'silver: existing callout-template matcher score >= 0.9',
                             'auditedMilestone':(split=='train' and step['number'] in (1,2,3,4,34)) or
                                                (split=='test' and step['number'] in (1,2))})
    # A booklet split alone leaks reused part artwork. Remove any training image
    # nearly identical to held-out art; test labels are never used by this check.
    test=[r for r in rows if r['split']=='test']
    removed=[];kept=[]
    for row in rows:
        if row['split']=='train' and any(np.abs(row['image'].astype(float)-t['image']).mean()<3 for t in test):
            removed.append({k:v for k,v in row.items() if k!='image'})
        else:kept.append(row)
    if not any(r['split']=='train' for r in kept) or not test:
        raise ValueError('Training and held-out booklets must both have eligible crops')
    return kept,removed


def load_legacy(checkpoint,vocab_path):
    import torch
    vocab=json.loads(Path(vocab_path).read_text())
    state=torch.load(checkpoint,map_location='cpu',weights_only=True)
    width=int(state['3.0.weight'].shape[0])
    model=build_model(len(vocab),width=width)
    model.load_state_dict(state);model.eval()
    return model,vocab,width


def adapt_head(parent,vocab,extra_parts,seed=7,base_parts=None):
    import torch
    import torch.nn as nn
    torch.manual_seed(seed)
    groups={}
    for i,name in enumerate(vocab):
        part=real_part(name,vocab)
        if part:groups.setdefault(part,[]).append(i)
    canonical=list(groups) if base_parts is None else list(dict.fromkeys(base_parts))
    canonical.extend(sorted(set(extra_parts)-set(canonical)))
    width=parent[7].in_features
    result=build_model(len(canonical),width=width)
    state=result.state_dict()
    for key,value in parent.state_dict().items():
        if not key.startswith('7.'):state[key]=value.clone()
    for i,part in enumerate(canonical):
        if part in groups:
            state['7.weight'][i]=parent[7].weight.detach()[groups[part]].mean(0)
            state['7.bias'][i]=parent[7].bias.detach()[groups[part]].mean()
    result.load_state_dict(state)
    # Retain the early visual features; adapt the last convolution block/head.
    for block in list(result.children())[:3]:
        for parameter in block.parameters():parameter.requires_grad=False
    return result,canonical


def classify(model,vocab,images,device='cpu',batch=128):
    import torch
    from brickheadz.part_classifier import to_tensor
    model.eval();model.to(device);probabilities=[]
    with torch.no_grad():
        for i in range(0,len(images),batch):
            x=to_tensor(np.stack(images[i:i+batch])).to(device)
            probabilities.extend(torch.softmax(model(x),1).cpu().numpy())
    canonical=[real_part(p,vocab) for p in vocab]
    ranked=[]
    for probabilities_row in probabilities:
        scores={}
        for part,score in zip(canonical,probabilities_row):
            if part:scores[part]=scores.get(part,0)+float(score)
        mass=sum(scores.values())
        ranked.append([{'part':p,'p':s/max(1e-12,mass)} for p,s in sorted(scores.items(),key=lambda x:-x[1])[:5]])
    return ranked


def metrics(rows,predictions,vocab):
    available={real_part(p,vocab) for p in vocab}
    def measure(indices):
        return {'samples':len(indices),'uniqueArtwork':len({rows[i]['hash'] for i in indices}),
                'vocabularyCovered':sum(rows[i]['part'] in available for i in indices),
                'top1':sum(bool(predictions[i]) and predictions[i][0]['part']==rows[i]['part'] for i in indices),
                'top5':sum(rows[i]['part'] in [p['part'] for p in predictions[i]] for i in indices)}
    return {'allSilver':measure(list(range(len(rows)))),
            'auditedMilestone':measure([i for i,r in enumerate(rows) if r['auditedMilestone']])}


def save_checkpoint(path,model,vocab,metadata):
    import torch
    torch.save({'format':'brickmotion-booklet-part-classifier','version':1,
                'state_dict':{k:v.detach().cpu() for k,v in model.state_dict().items()},
                'vocab':vocab,'width':model[7].in_features,'preprocess':PREPROCESS,
                'metadata':metadata},path)


def load_checkpoint(path,device='cpu'):
    import torch
    data=torch.load(path,map_location='cpu',weights_only=True)
    if data.get('format')!='brickmotion-booklet-part-classifier' or data.get('preprocess')!=PREPROCESS:
        raise ValueError('Unsupported booklet classifier checkpoint/preprocessing')
    model=build_model(len(data['vocab']),width=data['width'])
    model.load_state_dict(data['state_dict']);model.eval();model.to(device)
    return model,data['vocab'],data['metadata']


def main():
    import argparse
    parser=argparse.ArgumentParser(description='Experimental whole-part proposals for isolated PDF callout crops')
    parser.add_argument('--checkpoint',type=Path,required=True)
    parser.add_argument('crops',type=Path,nargs='+')
    args=parser.parse_args()
    model,vocab,metadata=load_checkpoint(args.checkpoint)
    images=[]
    for path in args.crops:
        image=cv2.imread(str(path))
        if image is None:raise FileNotFoundError(path)
        images.append(prepare_crop(image))
    results=classify(model,vocab,images)
    print(json.dumps({'experimental':True,'requiresReview':True,
                      'predictions':[{'crop':str(path),'candidates':row} for path,row in zip(args.crops,results)]},indent=2))

if __name__=='__main__':main()
