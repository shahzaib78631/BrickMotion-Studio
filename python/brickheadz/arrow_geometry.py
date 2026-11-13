"""Conservative red shaft/head evidence complementing learned arrow tips.

A colour component must have a long thin shaft, a wider head near one end,
then narrow to a tip. Merely having a red/green extreme pixel is insufficient.
Black and green arrows remain the learned detector's responsibility.
"""
from __future__ import annotations
import cv2
import numpy as np


def red_arrow_tips(rgb,with_components=False):
    value=np.asarray(rgb,dtype=np.int16);r,g,b=np.moveaxis(value,-1,0)
    masks=[(r>110)&(r>1.5*g)&(r>1.5*b)]
    found=[];boxes=[]
    for mask in masks:
        count,labels,stats,_=cv2.connectedComponentsWithStats(mask.astype(np.uint8))
        for index in range(1,count):
            x,y,w,h,area=stats[index]
            if area<20 or max(w,h)<14:continue
            # Cropped coloured faces can mimic a head/shaft profile. Require
            # complete component context; the learned path still sees borders.
            if x<5 or y<5 or x+w>rgb.shape[1]-5 or y+h>rgb.shape[0]-5:continue
            yy,xx=np.where(labels[y:y+h,x:x+w]==index)
            pixels=np.column_stack([xx+x,yy+y]).astype(float)
            centred=pixels-pixels.mean(0)
            _,vectors=np.linalg.eigh(centred.T@centred)
            direction=vectors[:,-1];normal=np.array([-direction[1],direction[0]])
            for sign in (1,-1):
                axis=direction*sign;along=pixels@axis;across=pixels@normal
                distance=along.max()-along;length=distance.max()
                if length<14:continue
                widths=[]
                bins=np.floor(distance).astype(int)
                for k in range(int(length)+1):
                    values=across[bins==k]
                    widths.append(float(np.ptp(values)+1) if len(values) else 0.)
                widths=np.array(widths)
                # A filled arrowhead widens approximately linearly from the
                # tip, then drops abruptly to a persistent narrow shaft. Rounded
                # stud caps and long red brick faces do not have this transition.
                stop=min(len(widths)-7,max(4,int(.78*length)))
                if stop<=3:continue
                peak_index=3+int(np.argmax(widths[3:stop]))
                peak=float(widths[peak_index])
                shaft=widths[peak_index+4:max(peak_index+5,int(length)-2)]
                if peak<4 or length/peak<2.4 or len(shaft)<5:continue
                tail=float(np.median(shaft))
                if tail<1 or peak<2.2*tail:continue
                if np.mean((shaft>0)&(shaft<peak*.55))<.8:continue
                if np.mean(widths[peak_index+2:peak_index+5])>peak*.6:continue
                head=widths[:peak_index+1]
                ideal=np.linspace(head[0],peak,len(head))
                if np.mean(np.abs(head-ideal))/peak>.15:continue
                if np.mean(head[:max(1,len(head)//5)])>peak*.55:continue
                endpoint=pixels[distance<=.8].mean(0)
                if all(np.linalg.norm(endpoint-old)>=5 for old in found):
                    found.append(endpoint);boxes.append((x,y,x+w,y+h))
    points=np.asarray(found,float).reshape(-1,2)
    return (points,boxes) if with_components else points


def fuse_arrow_tips(rgb,learned,merge_radius=8.):
    """Geometry refines nearby chromatic predictions and supplies missed tips."""
    result=[list(map(float,p)) for p in learned]
    points,boxes=red_arrow_tips(rgb,with_components=True)
    for point,(x0,y0,x1,y1) in zip(points,boxes):
        nearby=[i for i,p in enumerate(result) if np.linalg.norm(point-np.asarray(p[:2]))<=merge_radius]
        if nearby:
            best=max(nearby,key=lambda i:result[i][2] if len(result[i])>2 else 0.)
            result[best][:2]=point.tolist()
            result=[p for i,p in enumerate(result) if i==best or i not in nearby]
        elif any(x0-3<=p[0]<=x1+3 and y0-3<=p[1]<=y1+3 for p in result):
            # A short head can make the width test point backwards along its
            # shaft. Do not add a second endpoint to an already detected mark.
            continue
        else:result.append([*point.tolist(),0.])  # 0 denotes geometry-only, not a neural probability.
    return result
