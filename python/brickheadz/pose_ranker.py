"""Experimental real-booklet candidate scorer; geometry remains responsible for constraints."""
from pathlib import Path
import cv2
import numpy as np
import torch
from brickheadz import verify_learn


def feature_patch(rgb,target,candidate,built):
    h,w=rgb.shape[:2];size=max(h,w)
    result=[]
    for channel in (rgb.mean(2)/255,target.astype(float),candidate.astype(float),built.astype(float)):
        canvas=np.zeros((size,size),np.float32);canvas[:h,:w]=channel
        result.append(cv2.resize(canvas,(48,48),interpolation=cv2.INTER_AREA))
    return np.stack(result).astype(np.float32)


class PoseRanker:
    def __init__(self,checkpoint,device='cpu'):
        state=torch.load(checkpoint,map_location='cpu',weights_only=True)
        if state.get('format')!='brickmotion-real-pose-ranker':raise ValueError('Unsupported pose ranker')
        self.model=verify_learn.make_net();self.model.load_state_dict(state['state_dict'])
        self.model.eval();self.model.to(device);self.device=device

    def __call__(self,lib,part,colour,matrices,masks,obs,built,cam,palette):
        from brickheadz.booklet_vision import colour_mask,silhouette
        target=colour_mask(obs,colour,palette);prior=np.zeros(obs.foreground.shape,bool)
        for p,c,m in built:prior|=silhouette(lib,p,m,cam,obs.foreground.shape)
        images=np.stack([feature_patch(obs.rgb,target,mask,prior) for mask in masks])
        with torch.no_grad():return self.model(torch.from_numpy(images).to(self.device)).flatten().cpu().numpy().tolist()
