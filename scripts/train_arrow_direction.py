"""Train a local direction head without changing existing stud/tip weights."""
from __future__ import annotations
import argparse,hashlib,json,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
import cv2
import numpy as np
import torch
from brickheadz.keypoint_data import load_reviewed,augment
from brickheadz.arrow_annotations import validate_instances,transform_instances
from brickheadz.arrow_direction import ArrowDirectionNet,direction_loss,predict_maps,evaluate,save,load,raw_tensor_images
from brickheadz.keypoint_model import load as load_detector,tensor_images
from train_booklet_keypoints import dataset


def rotate_sample(sample,turns):
    result={**sample};image=sample['rgb'];h,w=image.shape[:2]
    if turns%4==0:return result
    # np.rot90 rotates counterclockwise in image coordinates.
    matrices={1:[[0,1,0],[-1,0,w-1]],2:[[-1,0,w-1],[0,-1,h-1]],3:[[0,-1,h-1],[1,0,0]]}
    matrix=np.array(matrices[turns%4],float);result['rgb']=np.rot90(image,turns).copy();nh,nw=result['rgb'].shape[:2]
    for key in ('studs','arrow_tips'):
        values=sample[key];result[key]=(np.column_stack([values,np.ones(len(values))])@matrix.T).tolist() if values else []
    result['arrow_instances']=transform_instances(sample.get('arrow_instances',[]),matrix,(nw,nh))
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--parent',type=Path,default=ROOT/'.cache/instructions/keypoint-learning/arrows-v3/best.pt')
    p.add_argument('--resume-direction',type=Path,help='Warm-start only from a direction model with matching frozen detector weights')
    p.add_argument('--learning-rate',type=float,default=1e-3)
    p.add_argument('--real-fraction',type=float,default=.5)
    p.add_argument('--labels',type=Path,default=ROOT/'benchmarks/instructions/arrow-direction-labels.json')
    p.add_argument('--out',type=Path,default=ROOT/'.cache/instructions/arrow-direction/rgb-preserved')
    p.add_argument('--steps',type=int,default=1200);p.add_argument('--train-scenes',type=int,default=1000)
    p.add_argument('--val-scenes',type=int,default=160);p.add_argument('--batch',type=int,default=16)
    p.add_argument('--workers',type=int,default=4);p.add_argument('--seed',type=int,default=41);p.add_argument('--every',type=int,default=200)
    args=p.parse_args()
    if min(args.steps,args.train_scenes,args.val_scenes,args.batch,args.workers,args.every)<1:p.error('counts must be positive')
    if not 0<=args.real_fraction<=1 or not np.isfinite(args.learning_rate) or args.learning_rate<=0:p.error('Invalid real fraction or learning rate')
    args.out.mkdir(parents=True,exist_ok=True);torch.set_num_threads(4);torch.manual_seed(args.seed);rng=np.random.default_rng(args.seed)
    device='mps' if torch.backends.mps.is_available() else 'cpu'
    rows=load_reviewed(args.labels,ROOT)
    for row in rows:validate_instances(row)
    real=[r for r in rows if r['split']=='train' and r['arrow_instances']];test=[r for r in rows if r['split']=='test']
    real_validation=[r for r in rows if r['split']=='validation' and r['arrow_instances']]
    if not real:p.error('No reviewed real direction-training instances')
    synthetic=dataset(args.out,args.train_scenes,False,args.seed*100003,args.workers)
    validation=dataset(args.out,args.val_scenes,True,(args.seed+1)*100003,args.workers)
    detector,thresholds,_=load_detector(args.parent);model=ArrowDirectionNet(detector).to(device)
    if args.resume_direction:
        resumed,resumed_thresholds,_=load(args.resume_direction,device)
        if not resumed.use_detail:raise ValueError('Warm start requires background-preserved RGB branch')
        if any(not torch.equal(v.cpu(),resumed.detector.state_dict()[k].cpu()) for k,v in detector.state_dict().items()):raise ValueError('Frozen detector does not match parent')
        model=resumed;thresholds=resumed_thresholds
    initial={k:v.clone() for k,v in model.detector.state_dict().items()}
    metadata={'parent':str(args.parent.resolve()),'parentSHA256':hashlib.sha256(args.parent.read_bytes()).hexdigest(),
              'labelsSHA256':hashlib.sha256(args.labels.read_bytes()).hexdigest(),'seed':args.seed,'device':device,
              'trainingBooklets':sorted({r['booklet'] for r in real}),'testBooklets':sorted({r['booklet'] for r in test}),
              'validationBooklets':sorted({r['booklet'] for r in real_validation}),
              'realValidationArrowheads':sum(len(r['arrow_instances']) for r in real_validation),
              'unitOfAnnotation':'arrowhead instance; bidirectional marks may have two heads',
              'realFraction':args.real_fraction,'learningRate':args.learning_rate,
              'resumeDirectionSHA256':hashlib.sha256(args.resume_direction.read_bytes()).hexdigest() if args.resume_direction else None,
              'realTrainingArrows':sum(len(r['arrow_instances']) for r in real),'realTestArrows':sum(len(r['arrow_instances']) for r in test),
              'syntheticTrainScenes':len(synthetic),'syntheticValidationScenes':len(validation),
              'trainableParameters':sum(p.numel() for p in model.parameters() if p.requires_grad),
              'studAndTipDetectorFrozen':True,'selection':'minimum equally-weighted synthetic/real-validation oracle-tip angular error, abstentions penalized at 180 degrees' if real_validation else 'minimum synthetic oracle-tip angular error, abstentions penalized at 180 degrees','rgbDetailBranch':True,'detailPreprocess':'background-preserved-rgb-v1',
              'caveat':json.loads(args.labels.read_text())['limitations'],'purposeAndShaftSegmentationTrained':False,
              'baseLengthCaveat':'Approximate directional anchors; head-base distance is experimental, not independently validated'}
    (args.out/'dataset.json').write_text(json.dumps(metadata,indent=2));print(json.dumps(metadata),flush=True)
    trainable=[p for p in model.parameters() if p.requires_grad]
    optimizer=torch.optim.AdamW(trainable,lr=args.learning_rate,weight_decay=1e-4)
    history=[];best=float('inf');started=time.time();accumulated=0.
    for step in range(1,args.steps+1):
        model.train();samples=[]
        for _ in range(args.batch):
            is_real=rng.random()<args.real_fraction;pool=real if is_real else synthetic
            sample=pool[int(rng.integers(len(pool)))];sample=rotate_sample(sample,int(rng.integers(4)))
            samples.append(augment(sample,rng,focus_probability=.5 if is_real else 0.))
        images=[s['rgb'] for s in samples]
        field=model(tensor_images(images).to(device),raw_tensor_images(images).to(device))[2]
        value=direction_loss(field,samples);optimizer.zero_grad();value.backward();torch.nn.utils.clip_grad_norm_(trainable,5);optimizer.step()
        accumulated+=float(value.detach().cpu())
        if step%args.every==0 or step==args.steps:
            measured=evaluate(validation,predict_maps(model,validation,device),thresholds,hybrid=False)
            score=measured['metrics']['oracleTipDirection']['meanDegreesWithAbstentionsAt180']
            real_metric=None
            if real_validation:
                measured_real=evaluate(real_validation,predict_maps(model,real_validation,device),thresholds,hybrid=False)
                real_metric=measured_real['metrics']['oracleTipDirection']
                real_score=real_metric['meanDegreesWithAbstentionsAt180']
                score=(score+real_score)/2
            record={'selectionScore':score,'realValidation':real_metric,'step':step,'loss':accumulated/min(args.every,step),'validation':measured['metrics']['oracleTipDirection'],'seconds':round(time.time()-started,1)}
            accumulated=0;history.append(record);print(json.dumps(record),flush=True)
            if score is not None and score<best:
                best=score;save(args.out/'best.pt',model,thresholds,{**metadata,'step':step,'validationMeanDegrees':score})
            save(args.out/'latest.pt',model,thresholds,{**metadata,'step':step});(args.out/'history.json').write_text(json.dumps(history,indent=2))
    frozen=all(torch.equal(v.cpu(),model.detector.state_dict()[k].cpu()) for k,v in initial.items())
    if not frozen:raise RuntimeError('Frozen detector weights changed')
    chosen,thresholds,chosen_metadata=load(args.out/'best.pt',device);by_book={}
    for book in sorted({r['booklet'] for r in test}):
        subset=[r for r in test if r['booklet']==book];maps=predict_maps(chosen,subset,device)
        by_book[book]=evaluate(subset,maps,thresholds,hybrid=True)
        for row,detail in zip(subset,by_book[book]['samples']):
            im=cv2.cvtColor(row['rgb'],cv2.COLOR_RGB2BGR)
            for a in row['arrow_instances']:
                cv2.arrowedLine(im,tuple(np.rint(a['head_base']).astype(int)),tuple(np.rint(a['tip']).astype(int)),(0,180,0),1,tipLength=.2)
            for a in detail['predictions']:
                if a['direction'] is None:continue
                tip=np.array(a['tip']);tail=tip-np.array(a['direction'])*20
                cv2.arrowedLine(im,tuple(np.rint(tail).astype(int)),tuple(np.rint(tip).astype(int)),(200,0,200),1,tipLength=.2)
            cv2.imwrite(str(args.out/f'{row["id"]}-directions.png'),im)
    report={'metadata':chosen_metadata,'thresholds':thresholds,'frozenDetectorUnchanged':frozen,
            'automaticPipelineEnabled':False,'byBooklet':by_book,'history':history}
    (args.out/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps({k:v['metrics'] for k,v in by_book.items()},indent=2),flush=True)

if __name__=='__main__':main()
