"""Geometry-labelled keypoint rendering and explicitly reviewed booklet labels."""
from __future__ import annotations
import hashlib
import json
import random
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

from brickheadz import part_render as pr
from brickheadz.parts import info
from brickheadz.arrow_annotations import transform_instances

TRAIN_PARTS=('3024','3023','3710','3020','3021','3022','3031','3001','3003','3004','3005','87079','3070b','1126','22885','3958')
VAL_PARTS=('3795','3666','2420','4073')


@lru_cache(maxsize=64)
def mesh(lib,part):
    return pr.PartMesh(lib,part)


def render_patch(lib,palette,part,rng,size):
    model=mesh(lib,part)
    rotation=pr.rotation(rng.uniform(5,85),rng.uniform(20,55),rng.uniform(-8,8))
    if rng.random()<.12:rotation=pr.rotation(rng.uniform(0,360),rng.uniform(-50,-20),0)
    vertices=model.verts@rotation.T
    lo,hi=vertices[:,:2].min(0),vertices[:,:2].max(0)
    scale=(size-10)/max(hi-lo)
    uv=(vertices[:,:2]-lo)*scale+5
    colour=palette[rng.choice([0,4,14,70,71,72,1,322])]
    face_colours=np.tile(np.array(colour[::-1],np.float32),(model.n,1))
    depths=[]
    bgr,face=pr.raster(uv,vertices[:,2],model.tris,model.tri_poly,model.normals@rotation.T,
                       face_colours,pr.random_light(rng),(size,size),edge=rng.uniform(.15,.5),depth_out=depths)
    visible=face>=0;yy,xx=np.where(visible)
    if not len(xx):raise ValueError(f'Empty mesh render: {part}')
    x0,x1,y0,y1=xx.min(),xx.max()+1,yy.min(),yy.max()+1
    points=[];body=info(lib,part)
    for snap in lib.snaps(part+'.dat'):
        if snap.gender!='M':continue
        axis=np.array(snap.axis);point=np.array(snap.pos)+axis*4
        if abs(np.linalg.norm(axis)-1)>.05:continue
        # Underside tubes are not outward stud caps.
        if np.all(point>=np.array(body.lo)-.01) and np.all(point<=np.array(body.hi)+.01):continue
        normal=rotation@axis
        if normal[2]>=-.05:continue
        q=rotation@point;p=(q[:2]-lo)*scale+5
        x,y=np.rint(p).astype(int)
        if not (0<=x<size and 0<=y<size and visible[y,x]):continue
        if abs(depths[0][y,x]-q[2])>2:continue
        points.append([float(p[0]-x0),float(p[1]-y0)])
    return cv2.cvtColor(bgr[y0:y1,x0:x1],cv2.COLOR_BGR2RGB),visible[y0:y1,x0:x1],points


def synthetic_sample(lib,palette,seed,parts=TRAIN_PARTS,size=256):
    rng=random.Random(seed)
    bg=rng.choice([(211,237,252),(255,255,255),(230,230,230)])
    image=np.full((size,size,3),bg,np.uint8);studs=[]
    for _ in range(rng.randint(1,3)):
        patch,mask,points=render_patch(lib,palette,rng.choice(parts),rng,rng.randint(70,180))
        h,w=mask.shape;x=rng.randint(2,max(2,size-w-2));y=rng.randint(2,max(2,size-h-2))
        # Later pieces physically hide earlier stud centres.
        studs=[p for p in studs if not (x<=p[0]<x+w and y<=p[1]<y+h and mask[min(h-1,int(p[1]-y)),min(w-1,int(p[0]-x))])]
        view=image[y:y+h,x:x+w];view[mask]=patch[mask]
        studs.extend([[p[0]+x,p[1]+y] for p in points])
    arrows=[];instances=[];arrow_mask=np.zeros((size,size),np.uint8)
    for _ in range(rng.choices([0,1,2,3],[.25,.35,.3,.1])[0]):
        tip=np.array([rng.randint(28,size-28),rng.randint(28,size-28)],float)
        # Booklets include side-on, long, narrow and white-outlined arrows.
        angle=rng.choice([np.pi/2,0,np.pi,-np.pi/2])+rng.uniform(-.45,.45)
        direction=np.array([np.cos(angle),np.sin(angle)])
        head=rng.randint(9,31);width=rng.randint(7,22);shaft=rng.randint(2,4)
        normal=np.array([-direction[1],direction[0]]);root=tip-direction*head
        tail=np.clip(tip-direction*rng.randint(head+15,180),5,size-6)
        colour=rng.choice([(30,130,50),(220,0,0),(0,0,0),(50,70,200)])
        line=[tail,root]
        if rng.random()<.5:
            pre_root=root-direction*rng.randint(10,30)
            line=[tail,np.array([pre_root[0],tail[1]]),pre_root,root]
        line=np.rint(line).astype(np.int32)
        triangle=np.rint([tip,root+normal*width/2,root-normal*width/2]).astype(np.int32)
        outline=rng.choice([0,0,2,3])
        if outline:
            cv2.polylines(image,[line],False,(255,255,255),shaft+outline*2,cv2.LINE_AA)
            cv2.polylines(image,[triangle],True,(255,255,255),outline*2,cv2.LINE_AA)
        cv2.polylines(image,[line],False,colour,shaft,cv2.LINE_AA)
        cv2.fillConvexPoly(image,triangle,colour,lineType=cv2.LINE_AA)
        cv2.polylines(arrow_mask,[line],False,255,shaft+outline*2+2)
        cv2.fillConvexPoly(arrow_mask,triangle,255)
        arrows.append(tip.tolist())
        path=line.astype(float).tolist();path[-1]=root.tolist()
        instances.append({'id':f'synthetic-{seed}-a{len(arrows)}','tip':tip.tolist(),'head_base':root.tolist(),
                          'shaft':path,'shaft_complete':bool(np.all(line>=0) and np.all(line<size)),
                          'purpose':'unknown','direction_reviewed':True})
    # Occluded studs are unknown visually and must not be positive targets.
    studs=[p for p in studs if not arrow_mask[min(size-1,round(p[1])),min(size-1,round(p[0]))]]
    if rng.random()<.4:
        cv2.putText(image,str(rng.randint(1,200)),(rng.randint(4,20),rng.randint(20,40)),cv2.FONT_HERSHEY_SIMPLEX,.7,(0,0,0),2)
    return {'rgb':image,'studs':studs,'arrow_tips':arrows,'arrow_instances':instances,'complete':[True,True],
            'id':f'synthetic-{seed}','booklet':None,'provenance':'LDraw snap centres, depth-buffer visibility, and drawn arrow geometry'}


def load_reviewed(path,root):
    from brickheadz.booklet_vision import split_panels
    data=json.loads(Path(path).read_text());samples=[]
    for row in data['samples']:
        if not row.get('reviewed'):raise ValueError(f'Unreviewed labels: {row["id"]}')
        image=cv2.imread(str(Path(root)/row['image']))
        if image is None:raise FileNotFoundError(row['image'])
        rgb=cv2.cvtColor(image,cv2.COLOR_BGR2RGB)
        if row['panel'] is not None:rgb=split_panels(rgb)[row['panel']]
        if hashlib.sha256(rgb.tobytes()).hexdigest()!=row['pixel_sha256']:
            raise ValueError(f'Image changed since annotation: {row["id"]}')
        samples.append({**row,'rgb':rgb,'complete':[row['studs_complete'],row['arrows_complete']]})
    book_splits={};hash_splits={}
    for sample in samples:
        if sample['split'] not in ('train','validation','test'):raise ValueError('Unknown dataset split')
        book_splits.setdefault(sample['booklet'],set()).add(sample['split'])
        hash_splits.setdefault(sample['pixel_sha256'],set()).add(sample['split'])
    if any(len(splits)>1 for splits in book_splits.values()):raise ValueError('A booklet appears in multiple training/validation/test splits')
    if any(len(splits)>1 for splits in hash_splits.values()):raise ValueError('Identical artwork appears in multiple dataset splits')
    return samples


def letterbox(sample,size=256):
    image=sample['rgb'];h,w=image.shape[:2];scale=min(1.,size/max(h,w))
    nh,nw=round(h*scale),round(w*scale);ox=(size-nw)//2;oy=(size-nh)//2
    bg=np.median([image[0,0],image[0,-1],image[-1,0],image[-1,-1]],axis=0)
    canvas=np.full((size,size,3),bg,np.uint8)
    canvas[oy:oy+nh,ox:ox+nw]=cv2.resize(image,(nw,nh))
    def transform(points):return [[p[0]*scale+ox,p[1]*scale+oy] for p in points]
    result={**sample,'rgb':canvas,'studs':transform(sample['studs']),'arrow_tips':transform(sample['arrow_tips'])}
    if 'arrow_instances' in sample:
        result['arrow_instances']=transform_instances(sample['arrow_instances'],[[scale,0,ox],[0,scale,oy]],(size,size))
    return result,(scale,ox,oy)


def augment(sample,rng,size=256,focus_probability=0.):
    if sample['arrow_tips'] and rng.random()<focus_probability:
        # Real full-page arrows can shrink to a few pixels. Include local head
        # context at native scale, keeping every labelled tip inside the crop.
        image=sample['rgb'];h,w=image.shape[:2]
        centre=np.array(sample['arrow_tips'][int(rng.integers(len(sample['arrow_tips'])))])
        side=int(rng.integers(100,257));cw,ch=min(w,side),min(h,side)
        x=int(np.clip(centre[0]-cw*rng.uniform(.3,.7),0,w-cw))
        y=int(np.clip(centre[1]-ch*rng.uniform(.3,.7),0,h-ch))
        def cropped(points):return [[px-x,py-y] for px,py in points if x<=px<x+cw and y<=py<y+ch]
        instances=transform_instances(sample.get('arrow_instances',[]),[[1,0,-x],[0,1,-y]],(cw,ch))
        sample={**sample,'arrow_instances':instances,'rgb':image[y:y+ch,x:x+cw],
                'studs':cropped(sample['studs']),'arrow_tips':cropped(sample['arrow_tips'])}
    result,_=letterbox(sample,size)
    scale=rng.uniform(.8,1.15);angle=rng.uniform(-6,6)
    matrix=cv2.getRotationMatrix2D((size/2,size/2),angle,scale)
    matrix[:,2]+=rng.uniform(-12,12,2)
    bg=tuple(map(int,result['rgb'][0,0]))
    image=cv2.warpAffine(result['rgb'],matrix,(size,size),borderValue=bg)
    def points(values):
        return [p.tolist() for p in (np.column_stack([values,np.ones(len(values))])@matrix.T) if np.all(p>=2) and np.all(p<size-2)] if values else []
    if rng.random()<.3:image=image[:,:,rng.permutation(3)]
    if rng.random()<.15:image=cv2.cvtColor(cv2.cvtColor(image,cv2.COLOR_RGB2GRAY),cv2.COLOR_GRAY2RGB)
    image=np.clip(image.astype(float)*rng.uniform(.8,1.15)+rng.normal(0,1,image.shape),0,255).astype(np.uint8)
    final={**result,'rgb':image,'studs':points(result['studs']),'arrow_tips':points(result['arrow_tips'])}
    if 'arrow_instances' in result:final['arrow_instances']=transform_instances(result['arrow_instances'],matrix,(size,size))
    return final
