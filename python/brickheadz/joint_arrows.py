"""Joint arrow-location/direction heads with explicit partial-label masking.

Legacy stud weights remain frozen. Arrow location, subpixel offsets and local
head direction share trainable RGB-preserving features; no geometric fallback
is used in the joint-model evaluation.
"""
from pathlib import Path
import argparse,json
import numpy as np
import cv2
import torch
from torch import nn
import torch.nn.functional as F
from brickheadz.arrow_direction import ArrowDirectionNet,direction_loss,raw_tensor_images,predict_maps,evaluate,decode_direction
from brickheadz.keypoint_model import PREPROCESS,SIZE,STRIDE,tensor_images,decode
from brickheadz.keypoint_data import letterbox


class JointArrowNet(nn.Module):
    def __init__(self,parent=None):
        super().__init__();base=parent if parent is not None else ArrowDirectionNet()
        if not base.use_detail:raise ValueError('Joint arrows require the RGB-preserving detail branch')
        self.detector=base.detector;self.detail=base.detail
        self.shared=nn.Sequential(*list(base.direction.children())[:-1]);self.direction=base.direction[-1]
        self.arrow_heat=nn.Conv2d(32,1,1);self.arrow_offset=nn.Conv2d(32,2,1)
        nn.init.constant_(self.arrow_heat.bias,-2.19);nn.init.zeros_(self.arrow_offset.weight);nn.init.zeros_(self.arrow_offset.bias)
        for p in self.detector.parameters():p.requires_grad=False
        self.detector.eval()

    def train(self,mode=True):
        super().train(mode);self.detector.eval();return self

    def forward(self,x,raw_rgb):
        with torch.no_grad():
            features=self.detector.features(x);heat=self.detector.heat(features);offset=self.detector.offset(features)
        shared=self.shared(torch.cat([features,self.detail(raw_rgb)],dim=1))
        return (torch.cat([heat[:,:1],self.arrow_heat(shared)],dim=1),
                torch.cat([offset[:,:2],self.arrow_offset(shared)],dim=1),self.direction(shared))


def location_targets(samples):
    n=len(samples);h=SIZE//STRIDE
    heat=np.zeros((n,1,h,h),np.float32);offset=np.zeros((n,2,h,h),np.float32)
    centres=np.zeros_like(heat);valid=np.zeros_like(heat)
    for i,s in enumerate(samples):
        if s['complete'][1]:valid[i]=1
        for point in s['arrow_tips']:
            xy=np.asarray(point)/STRIDE;x,y=np.rint(xy).astype(int)
            if not 0<=x<h or not 0<=y<h:continue
            left,right,top,bottom=max(0,x-5),min(h,x+6),max(0,y-5),min(h,y+6)
            yy,xx=np.mgrid[top:bottom,left:right];g=np.exp(-((xx-x)**2+(yy-y)**2)/(2*1.5**2))
            heat[i,0,top:bottom,left:right]=np.maximum(heat[i,0,top:bottom,left:right],g)
            centres[i,0,y,x]=1;offset[i,:,y,x]=xy-[x,y]
            # Known positive centres remain supervised in partial annotations;
            # no unlabelled pixel becomes a background negative.
            valid[i,0,y,x]=1
    return tuple(torch.from_numpy(v) for v in (heat,offset,centres,valid))


def joint_loss(outputs,samples):
    logits,offset,field=outputs;target,expected,centres,valid=(v.to(logits.device) for v in location_targets(samples))
    p=logits[:,1:2].sigmoid().clamp(1e-5,1-1e-5)
    positive=target.eq(1).float()*valid;negative=target.lt(1).float()*valid
    heat=(-torch.log(p)*(1-p)**2*positive-torch.log(1-p)*p**2*(1-target)**4*negative).sum()/positive.sum().clamp_min(1)
    mask=centres.repeat_interleave(2,dim=1)
    subpixel=(F.smooth_l1_loss(offset[:,2:].contiguous(),expected,reduction='none')*mask).sum()/mask.sum().clamp_min(1)
    angle=direction_loss(field,samples)
    return heat+subpixel+angle,{'heat':heat.detach(),'offset':subpixel.detach(),'direction':angle.detach()}


def save(path,model,thresholds,metadata):
    torch.save({'format':'brickmotion-joint-arrows','version':1,'preprocess':PREPROCESS,'detailPreprocess':'original-rgb-background-preserved',
                'metadata':metadata,'thresholds':list(thresholds),'state_dict':{k:v.detach().cpu() for k,v in model.state_dict().items()}},path)


def load(path,device='cpu'):
    state=torch.load(path,map_location='cpu',weights_only=True)
    if state.get('format')!='brickmotion-joint-arrows' or state.get('version')!=1 or state.get('preprocess')!=PREPROCESS or state.get('detailPreprocess')!='original-rgb-background-preserved':
        raise ValueError('Unsupported joint-arrow checkpoint')
    model=JointArrowNet();model.load_state_dict(state['state_dict']);model.eval();model.to(device)
    return model,state['thresholds'],state['metadata']


def detect_arrows(model,rgb,thresholds,device='cpu',overlap=64,batch=16):
    """Infer at native resolution in overlapping tiles; return original pixels.

    Full pages must not squeeze tiny arrowheads into a single 256px thumbnail.
    Overlapping predictions are deduplicated by confidence within four pixels.
    No source labels or geometric arrow proposals enter inference.
    """
    if rgb.ndim!=3 or rgb.shape[2]!=3 or min(rgb.shape[:2])<1:
        raise ValueError('Expected a nonempty RGB image')
    if not 0<=overlap<SIZE or batch<1:raise ValueError('Invalid overlap or batch')
    h,w=rgb.shape[:2]
    def origins(length):
        last=max(0,length-SIZE)
        return sorted(set(list(range(0,last+1,SIZE-overlap))+[last]))
    candidates=[];tiles=[];positions=[]
    for y in origins(h):
        for x in origins(w):
            tiles.append({'rgb':rgb[y:y+SIZE,x:x+SIZE],'studs':[],'arrow_tips':[],'complete':[False,False],'arrow_instances':[]})
            positions.append((x,y))
    # Batch the tiles themselves as well as network tensors, bounding memory.
    for start in range(0,len(tiles),batch):
        subset=tiles[start:start+batch];maps=predict_maps(model,subset,device,batch=batch)
        for tile,(x,y),(heat,offset,field) in zip(subset,positions[start:start+batch],maps):
            _,(scale,ox,oy)=letterbox(tile);th,tw=tile['rgb'].shape[:2]
            points=[[(px-ox)/scale,(py-oy)/scale,score] for px,py,score in decode(heat,offset,thresholds)[1]
                    if 0<=(px-ox)/scale<tw and 0<=(py-oy)/scale<th]
            for point,arrow in zip(points,decode_direction(field,points,scale,(ox,oy))):
                arrow['tip']=(np.array(arrow['tip'])+[x,y]).tolist()
                if arrow['headBase'] is not None:arrow['headBase']=(np.array(arrow['headBase'])+[x,y]).tolist()
                candidates.append({**arrow,'score':float(point[2])})
    result=[]
    for arrow in sorted(candidates,key=lambda a:a['score'],reverse=True):
        if all(np.linalg.norm(np.array(arrow['tip'])-a['tip'])>4 for a in result):result.append(arrow)
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--checkpoint',type=Path,required=True);p.add_argument('image',type=Path)
    p.add_argument('--device',default='cpu')
    args=p.parse_args();bgr=cv2.imread(str(args.image))
    if bgr is None:raise FileNotFoundError(args.image)
    model,thresholds,_=load(args.checkpoint,args.device);rgb=cv2.cvtColor(bgr,cv2.COLOR_BGR2RGB)
    arrows=detect_arrows(model,rgb,thresholds,args.device)
    print(json.dumps({'experimental':True,'geometricFallback':False,'coordinates':'original image pixels; x right, y down',
                      'inference':'native-resolution overlapping tiles','arrows':arrows},indent=2))

if __name__=='__main__':main()
