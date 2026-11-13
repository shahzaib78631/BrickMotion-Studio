"""Evaluation-only external-surface and connector equivalence.

Full CAD exactness remains a separate metric. Hidden mould/lock features can
make nominally identical stud-up orientations differ in a CAD point signature.
"""
import numpy as np
from brickheadz.connectors import catalog
from booklet_mpd.solver.render import View,render
from booklet_mpd.viewfit import ORIENTATIONS


def sites(part,matrix):
    result=[]
    connectors=catalog().connectors(part)
    if not connectors or any(c.family!='stud' for c in connectors):return None
    for c in connectors:
        w=matrix@c.frame;result.append((c.sub,*tuple(np.round(w[:3,3],3)),*tuple(np.round(-w[:3,1],3))))
    return sorted(result)


def externally_equivalent(lib,part,a,b,depth_tolerance=.5):
    if not np.allclose(a[:3,3],b[:3,3],atol=.001):return False
    if sites(part,a)!=sites(part,b) or sites(part,a) is None:return False
    a=a.copy();b=b.copy();a[:3,3]=0;b[:3,3]=0
    from booklet_mpd.solver.render import world_triangles
    v=np.concatenate([world_triangles(lib,part,m).reshape(-1,3) for m in (a,b)])
    radius=float(np.linalg.norm(v,axis=1).max());size=int(np.ceil(2*radius+8));offset=(size/2,size/2);seen=set()
    for r in ORIENTATIONS:
        normal=tuple(r[2])
        if normal in seen:continue
        seen.add(normal);view=View(r,0.,0.,1.,offset)
        da,la=render(lib,[(part,1,a)],view,(size,size));db,lb=render(lib,[(part,1,b)],view,(size,size));ma=la>=0;mb=lb>=0;union=ma|mb
        if not union.any():return False
        if np.logical_xor(ma,mb).sum()/union.sum()>.002:return False
        both=ma&mb
        if both.any() and np.max(np.abs(da[both]-db[both]))>depth_tolerance:return False
    return True
