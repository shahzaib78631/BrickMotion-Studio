"""Dense stud/arrow-tip heads reusing the trained video classifier encoder."""
from __future__ import annotations
import hashlib
from pathlib import Path

import cv2
import numpy as np
import torch
from torch import nn
import torch.nn.functional as F
from scipy.optimize import linear_sum_assignment

from brickheadz.part_classifier import build_model
from brickheadz.keypoint_data import letterbox

SIZE=256
STRIDE=2
PREPROCESS='corner-background-full-frame-rgb256-v1'


class KeypointNet(nn.Module):
    def __init__(self):
        super().__init__()
        original=build_model(2)
        self.encoder=nn.ModuleList(list(original.children())[:3])
        def block(a,b):return nn.Sequential(nn.Conv2d(a,b,3,padding=1),nn.ReLU(),nn.Conv2d(b,b,3,padding=1),nn.ReLU())
        self.decode2=block(128+64,64)
        self.decode1=block(64+32,32)
        self.heat=nn.Conv2d(32,2,1);self.offset=nn.Conv2d(32,4,1)
        nn.init.constant_(self.heat.bias,-2.19)
        nn.init.zeros_(self.offset.weight);nn.init.zeros_(self.offset.bias)

    def features(self,x):
        a=self.encoder[0](x);b=self.encoder[1](a);c=self.encoder[2](b)
        x=self.decode2(torch.cat([F.interpolate(c,size=b.shape[-2:],mode='bilinear',align_corners=False),b],1))
        x=self.decode1(torch.cat([F.interpolate(x,size=a.shape[-2:],mode='bilinear',align_corners=False),a],1))
        return x

    def forward(self,x):
        features=self.features(x)
        return self.heat(features),self.offset(features)


def initialize(parent_path,seed=17):
    torch.manual_seed(seed);model=KeypointNet()
    parent=torch.load(parent_path,map_location='cpu',weights_only=True)
    state=model.state_dict()
    for key in state:
        if key.startswith('encoder.'):
            original=key[len('encoder.'):]
            state[key]=parent[original].clone()
    model.load_state_dict(state)
    for parameter in model.encoder[0].parameters():parameter.requires_grad=False
    return model,{'path':str(Path(parent_path).resolve()),'sha256':hashlib.sha256(Path(parent_path).read_bytes()).hexdigest()}


def tensor_images(images):
    batch=[]
    for rgb in images:
        image=np.asarray(rgb,np.uint8).copy()
        bg=np.median([image[0,0],image[0,-1],image[-1,0],image[-1,-1]],axis=0)
        image[np.linalg.norm(image.astype(float)-bg,axis=2)<24]=0
        batch.append(image)
    return torch.from_numpy(np.stack(batch).copy()).permute(0,3,1,2).float()/255


def targets(samples):
    n=len(samples);h=SIZE//STRIDE
    heat=np.zeros((n,2,h,h),np.float32);offset=np.zeros((n,4,h,h),np.float32)
    mask=np.zeros((n,2,h,h),np.float32);complete=np.array([s['complete'] for s in samples],np.float32)
    for i,sample in enumerate(samples):
        for channel,key in enumerate(('studs','arrow_tips')):
            if not complete[i,channel]:continue
            for point in sample[key]:
                xy=np.array(point)/STRIDE;x,y=np.rint(xy).astype(int)
                if not (0<=x<h and 0<=y<h):continue
                left,right,top,bottom=max(0,x-5),min(h,x+6),max(0,y-5),min(h,y+6)
                yy,xx=np.mgrid[top:bottom,left:right]
                gaussian=np.exp(-((xx-x)**2+(yy-y)**2)/(2*1.5**2))
                heat[i,channel,top:bottom,left:right]=np.maximum(heat[i,channel,top:bottom,left:right],gaussian)
                offset[i,channel*2:channel*2+2,y,x]=xy-[x,y]
                mask[i,channel,y,x]=1
    return tuple(torch.from_numpy(a) for a in (heat,offset,mask,complete))


def loss(outputs,labels,arrow_weight=1.):
    logits,offset=outputs;target,expected_offset,centres,complete=labels
    probability=logits.sigmoid().clamp(1e-5,1-1e-5)
    valid=complete[:,:,None,None]
    positive=target.eq(1).float()*valid;negative=target.lt(1).float()*valid
    pos=-torch.log(probability)*(1-probability)**2*positive
    neg=-torch.log(1-probability)*probability**2*(1-target)**4*negative
    channel_loss=(pos+neg).sum(dim=(0,2,3))/positive.sum(dim=(0,2,3)).clamp_min(1)
    heat_loss=(channel_loss*logits.new_tensor([1.,arrow_weight])).mean()
    offset_mask=centres.repeat_interleave(2,dim=1)
    offset_loss=(F.smooth_l1_loss(offset,expected_offset,reduction='none')*offset_mask).sum()/offset_mask.sum().clamp_min(1)
    return heat_loss+offset_loss


def decode(heat,offset,thresholds=(.25,.25)):
    result=[]
    for channel,threshold in enumerate(thresholds):
        values=heat[channel]
        local=cv2.dilate(values,np.ones((5,5),np.uint8))
        yy,xx=np.where((values>=local-1e-7)&(values>=threshold))
        order=np.argsort(-values[yy,xx]);points=[]
        for index in order[:256]:
            x,y=xx[index],yy[index]
            delta=np.clip(offset[channel*2:channel*2+2,y,x],-.75,.75)
            point=(np.array([x,y])+delta)*STRIDE
            if any(np.linalg.norm(point-np.array(old[:2]))<5 for old in points):continue
            points.append([float(point[0]),float(point[1]),float(values[y,x])])
        result.append(points)
    return result


def predict_maps(model,samples,device='cpu',batch=16):
    model.eval();model.to(device);result=[]
    with torch.no_grad():
        for start in range(0,len(samples),batch):
            images=[letterbox(s)[0]['rgb'] for s in samples[start:start+batch]]
            heat,offset=model(tensor_images(images).to(device))
            result.extend(zip(heat.sigmoid().cpu().numpy(),offset.cpu().numpy()))
    return result


def predict_image(model,rgb,thresholds=(.25,.25),device='cpu',tile_scale=None,batch=16):
    """Return points in original pixels, optionally retaining detail via tiles.

    Overlap supplies context at tile seams; score-ordered suppression merges
    duplicate detections. Blank tiles are skipped, without masking any artwork.
    """
    if tile_scale is not None and (not np.isfinite(tile_scale) or tile_scale<=0):
        raise ValueError('tile_scale must be positive and finite')
    h,w=rgb.shape[:2]
    if not h or not w:raise ValueError('Empty image')
    if tile_scale is None:
        sample={'rgb':rgb,'studs':[],'arrow_tips':[],'complete':[False,False]}
        _,(scale,ox,oy)=letterbox(sample)
        heat,offset=predict_maps(model,[sample],device,batch)[0]
        return [[[(x-ox)/scale,(y-oy)/scale,score] for x,y,score in points
                 if 0<=(x-ox)/scale<w and 0<=(y-oy)/scale<h]
                for points in decode(heat,offset,thresholds)]
    nw,nh=max(1,round(w*tile_scale)),max(1,round(h*tile_scale))
    scaled=cv2.resize(rgb,(nw,nh),interpolation=cv2.INTER_AREA if tile_scale<1 else cv2.INTER_CUBIC)
    sx,sy=nw/w,nh/h
    def starts(length):return sorted(set(list(range(0,max(1,length-SIZE+1),192))+[max(0,length-SIZE)]))
    tiles=[];positions=[];result=[[],[]]
    for y in starts(nh):
        for x in starts(nw):
            patch=scaled[y:y+SIZE,x:x+SIZE]
            if np.mean(np.min(patch,axis=2)<235)<.005:continue
            tiles.append({'rgb':patch,'studs':[],'arrow_tips':[],'complete':[False,False]})
            positions.append((x,y,patch.shape[1],patch.shape[0]))
    maps=predict_maps(model,tiles,device,batch) if tiles else []
    for sample,position,(heat,offset) in zip(tiles,positions,maps):
        _,(_,ox,oy)=letterbox(sample);x,y,pw,ph=position
        for channel,points in enumerate(decode(heat,offset,thresholds)):
            for px,py,score in points:
                px-=ox;py-=oy
                # Ignore uncertain border predictions where another tile has context.
                if not (0<=px<pw and 0<=py<ph):continue
                if (x>0 and px<12) or (y>0 and py<12):continue
                if (x+pw<nw and px>=pw-12) or (y+ph<nh and py>=ph-12):continue
                result[channel].append([(px+x)/sx,(py+y)/sy,score])
    for channel,points in enumerate(result):
        kept=[]
        for point in sorted(points,key=lambda p:-p[2]):
            if all(np.linalg.norm(np.array(point[:2])-old[:2])>=5/min(sx,sy) for old in kept):kept.append(point)
        result[channel]=kept
    return result


def point_counts(predicted,expected,tolerance=4):
    if not len(predicted) or not len(expected):return 0,len(predicted),len(expected),[]
    distance=np.linalg.norm(np.asarray(predicted)[:,:2][:,None]-np.asarray(expected)[None,:,:],axis=2)
    # Maximize matches within tolerance before minimizing localization error.
    # Plain distance assignment can sacrifice a valid pair for one exact match.
    valid=distance<=tolerance
    penalty=min(distance.shape)+1
    cost=np.where(valid,distance/max(tolerance,1e-8)/penalty,penalty)
    a,b=linear_sum_assignment(cost)
    matched=distance[a,b]<=tolerance
    tp=int(matched.sum())
    return tp,len(predicted)-tp,len(expected)-tp,distance[a[matched],b[matched]].tolist()


def evaluate(samples,maps,thresholds=(.25,.25),tolerance=4,arrow_postprocess=None):
    totals=[{'tp':0,'fp':0,'fn':0,'errors':[]} for _ in range(2)];details=[]
    for sample,(heat,offset) in zip(samples,maps):
        boxed,transform=letterbox(sample);scale,ox,oy=transform
        decoded=decode(heat,offset,thresholds);record={'id':sample['id'],'predictions':{}}
        for channel,key in enumerate(('studs','arrow_tips')):
            predicted=[[(p[0]-ox)/scale,(p[1]-oy)/scale,p[2]] for p in decoded[channel]]
            if key=='arrow_tips' and arrow_postprocess is not None:
                predicted=arrow_postprocess(sample['rgb'],predicted)
            record['predictions'][key]=predicted
            if not sample['complete'][channel]:continue
            tp,fp,fn,errors=point_counts(predicted,sample[key],tolerance)
            counts=totals[channel]
            for metric,value in [('tp',tp),('fp',fp),('fn',fn)]:counts[metric]+=value
            counts['errors']+=errors;record[key]={'tp':tp,'fp':fp,'fn':fn}
        details.append(record)
    result={}
    for key,counts in zip(('studs','arrow_tips'),totals):
        tp,fp,fn=counts['tp'],counts['fp'],counts['fn']
        result[key]={'tp':tp,'fp':fp,'fn':fn,'precision':tp/max(1,tp+fp),'recall':tp/max(1,tp+fn),
                     'f1':2*tp/max(1,2*tp+fp+fn),'meanErrorPixels':float(np.mean(counts['errors'])) if counts['errors'] else None}
    return {'metrics':result,'tolerancePixels':tolerance,'samples':details}


def save(path,model,metadata,thresholds):
    torch.save({'format':'brickmotion-stud-arrow-detector','version':1,'preprocess':PREPROCESS,
                'state_dict':{k:v.detach().cpu() for k,v in model.state_dict().items()},
                'thresholds':list(thresholds),'metadata':metadata},path)


def load(path,device='cpu'):
    state=torch.load(path,map_location='cpu',weights_only=True)
    if state.get('format')!='brickmotion-stud-arrow-detector' or state.get('preprocess')!=PREPROCESS:
        raise ValueError('Unsupported keypoint model')
    model=KeypointNet();model.load_state_dict(state['state_dict']);model.eval();model.to(device)
    return model,state['thresholds'],state['metadata']


class LearnedObserver:
    """Image-only detector adapter; optional ellipse refinement/fusion is explicit.

    Ellipse dimensions come from image contours for lattice calibration. Learned
    heads supply centres and arrow endpoints; no model/pose truth is accepted.
    """
    def __init__(self,checkpoint,mode='raw',device='cpu',arrow_geometry=False):
        if mode not in ('raw','refined','fused'):raise ValueError('Unknown observation mode')
        self.model,self.thresholds,self.metadata=load(checkpoint,device)
        self.mode=mode;self.device=device;self.arrow_geometry=arrow_geometry

    def __call__(self,rgb):
        from brickheadz.booklet_vision import observe,Observation
        base=observe(rgb)
        sample={'rgb':rgb,'studs':[],'arrow_tips':[],'complete':[False,False]}
        _boxed,(scale,ox,oy)=letterbox(sample)
        heat,offset=predict_maps(self.model,[sample],self.device)[0]
        detected=decode(heat,offset,self.thresholds)
        points=[]
        dimensions=np.median(base.studs[:,2:],axis=0) if len(base.studs) else np.array([18.,10.])
        for x,y,score in detected[0]:
            point=np.array([(x-ox)/scale,(y-oy)/scale])
            if not (0<=point[0]<rgb.shape[1] and 0<=point[1]<rgb.shape[0]):continue
            size=dimensions
            if self.mode in ('refined','fused') and len(base.studs):
                distance=np.linalg.norm(base.studs[:,:2]-point,axis=1);nearest=int(distance.argmin())
                if distance[nearest]<3:point=base.studs[nearest,:2];size=base.studs[nearest,2:]
            if all(np.linalg.norm(point-np.array(old[:2]))>=3 for old in points):points.append([*point,*size])
        arrows=[[(p[0]-ox)/scale,(p[1]-oy)/scale] for p in detected[1]
                if 0<=(p[0]-ox)/scale<rgb.shape[1] and 0<=(p[1]-oy)/scale<rgb.shape[0]]
        if self.arrow_geometry:
            from brickheadz.arrow_geometry import fuse_arrow_tips
            arrows=[p[:2] for p in fuse_arrow_tips(rgb,arrows)]
        if self.mode=='fused':
            for row in base.studs:
                if all(np.linalg.norm(row[:2]-np.array(old[:2]))>=3 for old in points):points.append(row.tolist())
            for row in base.arrows:
                if all(np.linalg.norm(row-np.array(old))>=4 for old in arrows):arrows.append(row.tolist())
        return Observation(rgb,base.foreground,np.array(points,float).reshape(-1,4),np.array(arrows,float).reshape(-1,2))


def main():
    import argparse,json
    parser=argparse.ArgumentParser(description='Experimental learned stud-centre and arrow-tip proposals')
    parser.add_argument('--checkpoint',type=Path,required=True)
    parser.add_argument('--tile-scale',type=float,help='Use overlapping tiles at this image scale for large diagrams')
    parser.add_argument('--arrow-geometry',action='store_true',help='Add conservative red shaft/head evidence')
    parser.add_argument('image',type=Path)
    args=parser.parse_args()
    bgr=cv2.imread(str(args.image))
    if bgr is None:raise FileNotFoundError(args.image)
    rgb=cv2.cvtColor(bgr,cv2.COLOR_BGR2RGB)
    model,thresholds,metadata=load(args.checkpoint)
    detected=predict_image(model,rgb,thresholds,tile_scale=args.tile_scale)
    if args.arrow_geometry:
        from brickheadz.arrow_geometry import fuse_arrow_tips
        detected[1]=fuse_arrow_tips(rgb,detected[1])
    result={key:[{'x':x,'y':y,'score':score,'source':'geometry' if score==0 else 'learned'} for x,y,score in points]
            for key,points in zip(('studs','arrow_tips'),detected)}
    print(json.dumps({'experimental':True,'coordinates':'original image pixels','keypoints':result},indent=2))

if __name__=='__main__':main()
