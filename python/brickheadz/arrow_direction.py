"""Experimental local arrow direction on a frozen stud/tip detector.

Image axes: x right, y down. Direction is head base -> tip. Full shaft tracing,
arrow-purpose classification and 3D assembly motion are not inferred here.
"""
from __future__ import annotations
import argparse,json,math
from pathlib import Path
import cv2
import numpy as np
import torch
from torch import nn
import torch.nn.functional as F
from scipy.optimize import linear_sum_assignment
from brickheadz.keypoint_model import KeypointNet,PREPROCESS,STRIDE,tensor_images,decode
from brickheadz.keypoint_data import letterbox


class ArrowDirectionNet(nn.Module):
    def __init__(self,detector=None,use_detail=True):
        super().__init__();self.detector=detector if detector is not None else KeypointNet()
        for p in self.detector.parameters():p.requires_grad=False
        self.use_detail=use_detail
        self.detail=nn.Sequential(nn.Conv2d(3,16,5,stride=2,padding=2),nn.ReLU(),nn.Conv2d(16,32,3,padding=1),nn.ReLU()) if use_detail else None
        self.direction=nn.Sequential(nn.Conv2d(64 if use_detail else 32,32,3,padding=1),nn.ReLU(),
                                     nn.Conv2d(32,32,3,padding=1),nn.ReLU(),nn.Conv2d(32,3,1))
        self.detector.eval()

    def train(self,mode=True):
        super().train(mode);self.detector.eval();return self

    def forward(self,x,raw_rgb=None):
        with torch.no_grad():
            features=self.detector.features(x)
            heat=self.detector.heat(features);offset=self.detector.offset(features)
        if self.detail is not None:
            if raw_rgb is None:raise ValueError('Direction detail branch requires background-preserved RGB')
            features=torch.cat([features,self.detail(raw_rgb)],dim=1)
        return heat,offset,self.direction(features)


def raw_tensor_images(images):
    """Preserve paper/black-arrow contrast for the direction detail branch."""
    return torch.from_numpy(np.stack(images).copy()).permute(0,3,1,2).float()/255


def sample_field(field,points):
    """Bilinear samples in 256px network-input coordinates."""
    if not len(points):return field.new_empty((0,field.shape[1]))
    xy=torch.as_tensor(np.asarray(points),dtype=field.dtype,device=field.device)/STRIDE
    grid=xy/field.new_tensor([field.shape[3]-1,field.shape[2]-1])*2-1
    return F.grid_sample(field,grid.reshape(1,1,-1,2),mode='bilinear',align_corners=True).reshape(field.shape[1],-1).T.contiguous()


def direction_loss(field,samples):
    losses=[]
    for i,sample in enumerate(samples):
        arrows=sample.get('arrow_instances',[])
        if not arrows:continue
        tips=[];units=[];lengths=[]
        for arrow in arrows:
            if not arrow.get('direction_reviewed',False):continue
            vector=np.array(arrow['tip'])-arrow['head_base'];length=np.linalg.norm(vector)
            if length<2:continue
            for delta in [(0,0),(-2,0),(2,0),(0,-2),(0,2)]:
                tips.append(np.array(arrow['tip'])+delta);units.append(vector/length);lengths.append(length)
        if not tips:continue
        values=sample_field(field[i:i+1],tips)
        expected=field.new_tensor(np.asarray(units));normed=F.normalize(values[:,:2],dim=1,eps=1e-6)
        cosine=(normed*expected).sum(1)
        length_target=torch.log(field.new_tensor(lengths)/16.)
        losses.append((1-cosine).mean()+.25*F.smooth_l1_loss(values[:,:2].contiguous(),expected)+.1*F.smooth_l1_loss(values[:,2].contiguous(),length_target))
    return torch.stack(losses).mean() if losses else field.sum()*0


def decode_direction(field,points,scale=1.,offset=(0,0)):
    """Directions are not confidence-calibrated; invalid zero vectors abstain."""
    network=[[(p[0]*scale+offset[0]),(p[1]*scale+offset[1])] for p in points]
    values=sample_field(torch.as_tensor(field)[None],network).numpy();result=[]
    for point,value in zip(points,values):
        vector=value[:2].astype(float);norm=np.linalg.norm(vector)
        if not np.isfinite(value).all() or norm<.1:
            result.append({'tip':list(point[:2]),'direction':None,'headBase':None,'angleDegrees':None});continue
        unit=vector/norm;length=float(np.exp(np.clip(value[2],-3,4))*16/scale)
        result.append({'tip':list(map(float,point[:2])),'direction':unit.tolist(),
                       'headBase':(np.array(point[:2])-unit*length).tolist(),
                       'angleDegrees':math.degrees(math.atan2(unit[1],unit[0]))})
    return result


def predict_maps(model,samples,device='cpu',batch=16):
    model.eval();model.to(device);result=[]
    with torch.no_grad():
        for start in range(0,len(samples),batch):
            images=[letterbox(s)[0]['rgb'] for s in samples[start:start+batch]]
            heat,offset,field=model(tensor_images(images).to(device),raw_tensor_images(images).to(device))
            result.extend(zip(heat.sigmoid().cpu().numpy(),offset.cpu().numpy(),field.cpu().numpy()))
    return result


def angular_error(a,b):
    a=np.asarray(a,float);b=np.asarray(b,float)
    if not np.isfinite(a).all() or not np.isfinite(b).all() or min(np.linalg.norm(a),np.linalg.norm(b))<1e-8:return None
    return float(np.degrees(np.arccos(np.clip(a@b/(np.linalg.norm(a)*np.linalg.norm(b)),-1,1))))


def evaluate(samples,maps,thresholds,hybrid=True,tolerance=4,angle_tolerance=15):
    from brickheadz.arrow_geometry import fuse_arrow_tips
    totals={'labels':0,'matchedTips':0,'falsePositives':0,'missedTips':0,'directedCorrect':0,'reversed':0,'abstained':0,
            'completeRegions':0,'partialRegions':0}
    oracle=[];angles=[];baseline=[];details=[]
    for sample,(heat,offset,field) in zip(samples,maps):
        _,(scale,ox,oy)=letterbox(sample);h,w=sample['rgb'].shape[:2]
        points=[[(x-ox)/scale,(y-oy)/scale,score] for x,y,score in decode(heat,offset,thresholds)[1]
                if 0<=(x-ox)/scale<w and 0<=(y-oy)/scale<h]
        if hybrid:points=fuse_arrow_tips(sample['rgb'],points)
        predictions=decode_direction(field,points,scale,(ox,oy))
        truth=sample.get('arrow_instances',[])
        oracle_predictions=decode_direction(field,[a['tip'] for a in truth],scale,(ox,oy))
        for arrow,pred in zip(truth,oracle_predictions):
            expected=np.array(arrow['tip'])-arrow['head_base']
            oracle.append(angular_error(pred['direction'],expected) if pred['direction'] is not None else None)
            baseline.append(angular_error([0,1],expected))
        matches=[]
        if len(points) and len(truth):
            distance=np.linalg.norm(np.array(points)[:,:2][:,None]-np.array([a['tip'] for a in truth])[None],axis=2)
            penalty=min(distance.shape)+1;cost=np.where(distance<=tolerance,distance/max(tolerance,1e-8)/penalty,penalty)
            a,b=linear_sum_assignment(cost);matches=[(int(i),int(j)) for i,j in zip(a,b) if distance[i,j]<=tolerance]
        totals['labels']+=len(truth);totals['matchedTips']+=len(matches)
        complete=sample.get('complete',[False,True])[1]
        totals['completeRegions' if complete else 'partialRegions']+=1
        if complete:totals['falsePositives']+=len(points)-len(matches)
        totals['missedTips']+=len(truth)-len(matches)
        per_match=[]
        for i,j in matches:
            direction=predictions[i]['direction'];expected=np.array(truth[j]['tip'])-truth[j]['head_base']
            error=angular_error(direction,expected) if direction is not None else None
            if error is None:totals['abstained']+=1
            else:
                angles.append(error);totals['directedCorrect']+=error<=angle_tolerance;totals['reversed']+=error>90
            per_match.append({'arrowID':truth[j]['id'],'angularErrorDegrees':error})
        details.append({'id':sample.get('id','image'),'predictions':predictions,'matches':per_match})
    def summary(errors):
        valid=[v for v in errors if v is not None]
        return {'count':len(errors),'available':len(valid),'meanDegrees':float(np.mean(valid)) if valid else None,
                'meanDegreesWithAbstentionsAt180':float((sum(valid)+180*(len(errors)-len(valid)))/len(errors)) if errors else None,
                'within15Degrees':sum(v<=angle_tolerance for v in valid),'reversed':sum(v>90 for v in valid)}
    return {'metrics':{**totals,'angularErrorOnMatchedTips':summary(angles),
                       'oracleTipDirection':summary(oracle),'alwaysDownOracleBaseline':summary(baseline)},
            'tipTolerancePixels':tolerance,'angleToleranceDegrees':angle_tolerance,'samples':details,
            'caveat':'Oracle-tip direction is diagnostic with supplied tip locations; directedCorrect requires both detected tip and correct angle. Head-base lengths are approximate. False positives are scored only on complete regions; unannotated heads in partial regions are unknown.'}


def save(path,model,thresholds,metadata):
    torch.save({'format':'brickmotion-arrow-direction','version':3 if model.use_detail else 1,'preprocess':PREPROCESS,'thresholds':list(thresholds),
                'metadata':metadata,'state_dict':{k:v.detach().cpu() for k,v in model.state_dict().items()}},path)


def load(path,device='cpu'):
    state=torch.load(path,map_location='cpu',weights_only=True)
    if state.get('format')!='brickmotion-arrow-direction' or state.get('version') not in (1,3) or state.get('preprocess')!=PREPROCESS:
        raise ValueError('Unsupported arrow direction checkpoint')
    model=ArrowDirectionNet(use_detail=state['version']==3);model.load_state_dict(state['state_dict']);model.eval();model.to(device)
    return model,state['thresholds'],state['metadata']


class DirectionObserver:
    """Raw stud centres and hybrid tips, with optional image-direction metadata.

    Direction vectors do not become 3D displacement constraints. This adapter
    accepts only images and the saved detector, never reference poses or labels.
    """
    def __init__(self,checkpoint,device='cpu'):
        state=torch.load(checkpoint,map_location='cpu',weights_only=True)
        self.joint=state.get('format')=='brickmotion-joint-arrows'
        if self.joint:
            from brickheadz.joint_arrows import load as load_joint
            self.model,self.thresholds,self.metadata=load_joint(checkpoint,device)
        else:self.model,self.thresholds,self.metadata=load(checkpoint,device)
        self.device=device

    def __call__(self,rgb):
        from brickheadz.booklet_vision import observe,Observation
        base=observe(rgb);sample={'rgb':rgb,'studs':[],'arrow_tips':[],'complete':[False,False],'arrow_instances':[]}
        _,(scale,ox,oy)=letterbox(sample)
        heat,offset,field=predict_maps(self.model,[sample],self.device)[0]
        dimensions=np.median(base.studs[:,2:],axis=0) if len(base.studs) else np.array([18.,10.])
        points=[]
        for x,y,score in decode(heat,offset,self.thresholds)[0]:
            point=np.array([(x-ox)/scale,(y-oy)/scale])
            if not (0<=point[0]<rgb.shape[1] and 0<=point[1]<rgb.shape[0]):continue
            if all(np.linalg.norm(point-np.array(p[:2]))>=3 for p in points):points.append([*point,*dimensions])
        if self.joint:
            from brickheadz.joint_arrows import detect_arrows
            result=detect_arrows(self.model,rgb,self.thresholds,self.device)
        else:result=evaluate([sample],[(heat,offset,field)],self.thresholds,hybrid=True)['samples'][0]['predictions']
        tips=np.asarray([r['tip'] for r in result],float).reshape(-1,2)
        vectors=np.asarray([r['direction'] if r['direction'] is not None else [np.nan,np.nan] for r in result],float).reshape(-1,2)
        return Observation(rgb,base.foreground,np.asarray(points,float).reshape(-1,4),tips,vectors)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--checkpoint',type=Path,required=True)
    parser.add_argument('--hybrid',action='store_true');parser.add_argument('image',type=Path);args=parser.parse_args()
    bgr=cv2.imread(str(args.image))
    if bgr is None:raise FileNotFoundError(args.image)
    rgb=cv2.cvtColor(bgr,cv2.COLOR_BGR2RGB);model,thresholds,_=load(args.checkpoint)
    sample={'id':str(args.image),'rgb':rgb,'studs':[],'arrow_tips':[],'complete':[False,False],'arrow_instances':[]}
    result=evaluate([sample],predict_maps(model,[sample]),thresholds,hybrid=args.hybrid)
    print(json.dumps({'experimental':True,'coordinates':'original image pixels; x right, y down',
                      'directionConfidence':None,'purpose':'unknown','arrows':result['samples'][0]['predictions']},indent=2))

if __name__=='__main__':main()
