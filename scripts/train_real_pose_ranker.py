"""Adapt the existing synthetic pose verifier on labelled real-booklet candidates.

This is an isolated candidate-ranking experiment with labelled prior states, not
an autonomous rollout. Superman supplies train/validation groups; Batman is test.
"""
from __future__ import annotations
import argparse,hashlib,json,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
import cv2
import numpy as np
import torch

from assembly_model.ldraw import load_library
from brickheadz.image_spec import ldconfig_rgb
from brickheadz import verify_learn as verifier
from brickheadz.pose_ranker import feature_patch
from brickheadz.booklet_vision import (observe,lattice_camera,align_camera,align_footprint_camera,placements,
                                     silhouette,colour_mask,split_panels)
from brickheadz.instruction_place import grid_matrix
from brickheadz.parts import info
from brickheadz.reconstruct import steps_from_omr
from reconstruct_real_sequence import read_image


def geometry_signature(lib,part,matrix):
    vertices=lib.triangles(part+'.dat')@matrix[:3,:3].T+matrix[:3,3]
    vertices=np.round(vertices,3);vertices[np.abs(vertices)<.0005]=0
    return hashlib.sha256(np.unique(vertices,axis=0).tobytes()).hexdigest()




def candidate_group(lib,palette,label,split,rgb,built,part,colour,truths,cam,footprint):
    obs=observe(rgb);target=colour_mask(obs,colour,palette)
    built_mask=np.zeros(obs.foreground.shape,bool)
    for p,c,m in built:built_mask|=silhouette(lib,p,m,cam,obs.foreground.shape)
    correct={geometry_signature(lib,part,m) for p,c,m in truths if p==part and c==colour}
    images=[];labels=[];poses=[];seen=set()
    for matrix,grid in placements(lib,part,built,footprint):
        signature=geometry_signature(lib,part,matrix)
        if signature in seen:continue
        seen.add(signature)
        mask=silhouette(lib,part,matrix,cam,obs.foreground.shape)
        images.append(feature_patch(rgb,target,mask,built_mask));labels.append(signature in correct)
        poses.append({'grid':grid,'matrix':matrix.tolist()})
    if not any(labels):raise ValueError(f'True pose is absent from candidates: {label}')
    return {'id':label,'split':split,'images':np.stack(images),'labels':np.array(labels,bool),
            'poses':poses,'part':part,'color':colour}


def build_groups(job,lib,palette):
    groups=[]
    for mi,count,name in [(0,4,'superman'),(1,2,'batman')]:
        # References supply supervision / labelled prior state for this dataset.
        reference=steps_from_omr(str(ROOT/f'benchmarks/instructions/{name}-opening-reference.ldr'),preserve_empty=True)
        built=[]
        for i,step in enumerate(job['models'][mi]['steps'][:count]):
            additions=[(p['part'],p['color']) for p in step['parts'] for _ in range(p['count'])]
            if i==0:
                if len(additions)>1:
                    seed=max(additions,key=lambda pc:info(lib,pc[0]).w*info(lib,pc[0]).d);additions.remove(seed)
                else:
                    seed_row=job['unassignedInventory'][0];seed=(seed_row['part'],seed_row['color'])
                matrix=grid_matrix(lib,seed[0],0,0,0,np.eye(3))[0];built=[(*seed,matrix)]
            rgb=read_image(step['image']);obs=observe(rgb);cam,_=lattice_camera(obs.studs)
            cam,_=align_camera(lib,built,obs,cam,palette)
            split='test' if mi==1 else ('validation' if i==3 else 'train')
            for part,colour in dict.fromkeys(additions):
                groups.append(candidate_group(lib,palette,f'{name}-step-{i+1}-{part}',split,rgb,built,part,colour,reference[i],cam,
                                              (info(lib,seed[0]).w,info(lib,seed[0]).d)))
            built=[piece for group in reference[:i+1] for piece in group]
    step=job['models'][0]['steps'][33]
    panels=split_panels(read_image(step['image']))
    reference=steps_from_omr(str(ROOT/'benchmarks/instructions/superman-34-audited.ldr'),preserve_empty=True)
    seed=reference[0][0];built=[seed];cam=None
    for i,rgb in enumerate(panels):
        obs=observe(rgb)
        if i==0:
            cam,_=lattice_camera(obs.studs);cam,_=align_camera(lib,built,obs,cam,palette)
        else:cam,_=align_footprint_camera(lib,built,obs,cam)
        expected=[p for p in reference[i] if not (i==0 and p[0]==seed[0])]
        part,colour,_matrix=expected[0]
        groups.append(candidate_group(lib,palette,f'superman-panel-{i+1}','train',rgb,built,part,colour,expected,cam,(4,4)))
        built=[piece for group in reference[:i+1] for piece in group]
    return groups


def measure(net,groups,device):
    net.eval();results=[]
    with torch.no_grad():
        for g in groups:
            logits=net(torch.from_numpy(g['images']).to(device)).flatten()
            labels=torch.tensor(g['labels'],device=device)
            nll=torch.logsumexp(logits,0)-torch.logsumexp(logits[labels],0)
            pick=int(logits.argmax());results.append({'id':g['id'],'candidates':len(g['labels']),
                'positives':int(g['labels'].sum()),'correct':bool(g['labels'][pick]),'pick':pick,
                'selectedPose':g['poses'][pick],'nll':float(nll.cpu())})
    return {'groups':len(results),'correct':sum(r['correct'] for r in results),
            'meanNLL':float(np.mean([r['nll'] for r in results])),'results':results}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--out',type=Path,default=ROOT/'.cache/instructions/pose-learning/pilot')
    p.add_argument('--job',type=Path,default=ROOT/'.cache/instructions/heroes-complete-regression/placement-job.json')
    p.add_argument('--parent',type=Path,default=ROOT/'.cache/brickheadz/verifier.pt')
    p.add_argument('--steps',type=int,default=400)
    p.add_argument('--evaluate-checkpoint',type=Path,help='Evaluate existing weights without retraining or selecting them again')
    args=p.parse_args();args.out.mkdir(parents=True,exist_ok=True)
    torch.manual_seed(23);torch.set_num_threads(4);rng=np.random.default_rng(23)
    device='mps' if torch.backends.mps.is_available() else 'cpu'
    lib=load_library(str(ROOT/'public/ldraw'));palette=ldconfig_rgb(str(ROOT/'public/ldraw/LDConfig.ldr'))
    groups=build_groups(json.loads(args.job.read_text()),lib,palette)
    train=[g for g in groups if g['split']=='train'];validation=[g for g in groups if g['split']=='validation'];test=[g for g in groups if g['split']=='test']
    manifest=[{k:(v.tolist() if isinstance(v,np.ndarray) else v) for k,v in g.items() if k!='images'} for g in groups]
    (args.out/'dataset.json').write_text(json.dumps({'labelledPriorStates':True,'groups':manifest},indent=2))
    net=verifier.make_net();parent=torch.load(args.parent,map_location='cpu',weights_only=True);net.load_state_dict(parent)
    initial={k:v.clone() for k,v in net.state_dict().items()};net.to(device)
    for parameter in net[0].parameters():parameter.requires_grad=False
    opt=torch.optim.AdamW([p for p in net.parameters() if p.requires_grad],lr=3e-4,weight_decay=1e-4)
    best=float('inf');history=[];start=time.time()
    for step in range(1,(0 if args.evaluate_checkpoint else args.steps)+1):
        g=train[int(rng.integers(len(train)))];x=g['images'].copy()
        x=np.rot90(x,int(rng.integers(4)),axes=(2,3)).copy()
        if rng.random()<.5:x=x[:,:,:,::-1].copy()
        x[:,0]=np.clip(x[:,0]*rng.uniform(.9,1.1),0,1)
        net.train();logits=net(torch.from_numpy(x).to(device)).flatten();label=torch.tensor(g['labels'],device=device)
        value=torch.logsumexp(logits,0)-torch.logsumexp(logits[label],0)
        opt.zero_grad();value.backward();opt.step()
        if step%50==0 or step==args.steps:
            val=measure(net,validation,device);record={'step':step,'validationCorrect':val['correct'],'validationGroups':val['groups'],
                'validationNLL':val['meanNLL'],'seconds':round(time.time()-start,2)}
            history.append(record);print(json.dumps(record),flush=True)
            if val['meanNLL']<best:
                best=val['meanNLL'];torch.save({'format':'brickmotion-real-pose-ranker','version':1,
                    'state_dict':{k:v.detach().cpu() for k,v in net.state_dict().items()},'step':step,
                    'input':'global letterboxed 48x48 grey/colour/candidate/built maps','teacherForcedDatasetPrior':True,
                    'parentSHA256':hashlib.sha256(args.parent.read_bytes()).hexdigest()},args.out/'best.pt')
    # Test is measured only after checkpoint selection on the separate validation group.
    chosen=torch.load(args.evaluate_checkpoint or args.out/'best.pt',map_location='cpu',weights_only=True);net.load_state_dict(chosen['state_dict'])
    after=measure(net,test,device);net.load_state_dict(initial);before=measure(net,test,device)
    report={'parent':str(args.parent),'parentSHA256':hashlib.sha256(args.parent.read_bytes()).hexdigest(),
        'parameters':sum(p.numel() for p in net.parameters()),'checkpointStep':chosen['step'],
        'trainGroups':len(train),'validationGroups':len(validation),'testGroups':len(test),
        'testUsedForCheckpointSelection':False,'evaluationMode':'isolated candidate ranking with labelled correct prior geometry',
        'referenceFrame':'canonical foundation orientation, fixed globally for all steps','fullAssemblyDemonstrated':False,'automaticPipelineEnabled':False,'before':before,'after':after,'history':history}
    (args.out/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2),flush=True)

if __name__=='__main__':main()
