"""Generate a two-step raster instruction fixture; not used by inference."""
from pathlib import Path

import cv2
import numpy as np
import pymupdf

from assembly_model.ldraw import load_library
from booklet_mpd.solver.picture import colour_rgb
from booklet_mpd.solver.render import View, bounds, render
from .build import ROOT, save_json
from .source import save_rgb


def illustration(lib, parts, shape, scale=None):
    view=View(np.eye(3),45.,30.,1.,(0.,0.))
    lo,hi=bounds(lib,parts,view)
    factor=scale or min((shape[1]-20)/max(1,hi[0]-lo[0]),(shape[0]-20)/max(1,hi[1]-lo[1]))
    view=view.replace(scale=factor)
    lo,hi=bounds(lib,parts,view)
    view=view.replace(offset=tuple((np.array([shape[1],shape[0]])-hi-lo)/2))
    depth,labels=render(lib,parts,view,shape)
    rgb=np.full((*shape,3),255,np.uint8)
    for k,(_,color,_) in enumerate(parts):
        rgb[labels==k]=colour_rgb(color)
        contours,_=cv2.findContours((labels==k).astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(rgb,contours,-1,(20,20,20),1)
    from booklet_mpd.solver.edges import part_edges, sample_segments, visible_points
    for part,_,matrix in parts:
        edges=part_edges(lib,part)
        if len(edges):
            world=edges.reshape(-1,3)@matrix[:3,:3].T+matrix[:3,3]
            projected=view.project(world).reshape(-1,2,3)
            points=visible_points(sample_segments(projected),depth)
            if len(points):
                rgb[points[:,0],points[:,1]]=(25,25,25)
    return rgb


def generate(folder):
    folder=Path(folder)
    folder.mkdir(parents=True,exist_ok=True)
    lib=load_library(str(ROOT/"public/ldraw"))
    first=("3001",4,np.eye(4))
    second_matrix=np.eye(4)
    second_matrix[:3,3]=[0,-24,-10]
    second=("3004",1,second_matrix)
    doc=pymupdf.open()
    for number,addition in enumerate((first,second),1):
        rgb=np.full((760,600,3),255,np.uint8)
        cv2.putText(rgb,str(number),(28,77),cv2.FONT_HERSHEY_SIMPLEX,1.8,(25,25,25),3,cv2.LINE_AA)
        rgb[25:155,105:370]=(231,240,247)
        thumb=illustration(lib,[(addition[0],addition[1],np.eye(4))],(90,140))
        thumb[(thumb==255).all(-1)]=(231,240,247)
        rgb[30:120,145:285]=thumb
        cv2.putText(rgb,"1x",(193,145),cv2.FONT_HERSHEY_SIMPLEX,.7,(25,25,25),2,cv2.LINE_AA)
        model=[first] if number==1 else [first,second]
        rgb[200:650,35:565]=illustration(lib,model,(450,530),scale=3.5)
        path=folder/f"page-{number}.png"
        save_rgb(path,rgb)
        page=doc.new_page(width=600,height=760)
        page.insert_image(page.rect,filename=str(path))
    doc.save(folder/"studio-demo.pdf")
    doc.close()
    save_json(folder/"expected-for-evaluation.json",{"parts":[(p,c,m.tolist()) for p,c,m in (first,second)]})
    print(folder/"studio-demo.pdf")
    return folder/"studio-demo.pdf"


if __name__=="__main__":
    import argparse
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("out",type=Path)
    generate(p.parse_args().out)
