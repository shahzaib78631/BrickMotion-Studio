"""Exact pairwise mesh collision, cached in the host part's local frame."""
import atexit,json,subprocess,selectors
from pathlib import Path
import numpy as np
from lab.oracle import Oracle
from booklet_mpd.solver.render import mesh
ROOT=Path(__file__).resolve().parents[3]


class LocalOracle(Oracle):
    def __init__(self):
        self.p=subprocess.Popen([str(ROOT/'node_modules/.bin/tsx'),'scripts/lab-oracle.ts'],cwd=ROOT,
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
        selector=selectors.DefaultSelector();selector.register(self.p.stdout,selectors.EVENT_READ)
        ready=selector.select(45);selector.close()
        if not ready:self.p.terminate();raise RuntimeError('Mesh collision oracle did not start')
        if not json.loads(self.p.stdout.readline()).get('ready'):raise RuntimeError('Mesh collision oracle failed')


_BOUNDS={}
def box(lib,entry):
    part,_c,m=entry;key=(id(lib),part)
    if key not in _BOUNDS:
        v=mesh(lib,part).reshape(-1,3);lo,hi=v.min(0),v.max(0)
        _BOUNDS[key]=np.array([[x,y,z] for x in [lo[0],hi[0]] for y in [lo[1],hi[1]] for z in [lo[2],hi[2]]])
    points=_BOUNDS[key]@m[:3,:3].T+m[:3,3]
    return points.min(0),points.max(0)

class PairwiseCollision:
    def __init__(self,lib):self.lib=lib;self.oracle=None;self.cache={};self.queries=0;atexit.register(self.close)
    def overlaps(self,entry,model):
        p,c,m=entry
        for q,k,n in model:
            lo,hi=box(self.lib,entry);otherlo,otherhi=box(self.lib,(q,k,n))
            if not np.all(np.minimum(hi,otherhi)-np.maximum(lo,otherlo)>4.):continue
            relative=np.linalg.inv(n)@m;key=(q,p,*tuple(np.round(relative.ravel(),4)))
            if key not in self.cache:
                if self.oracle is None:self.oracle=LocalOracle()
                self.oracle.reset()
                if not self.oracle.add(q,np.eye(4)):raise RuntimeError('Unknown collision geometry: '+q)
                self.cache[key]=self.oracle.hits(p,relative);self.queries+=1
            if self.cache[key]:return True
        return False
    def close(self):
        if self.oracle is not None:
            self.oracle.close();self.oracle=None


_INSTANCES={}
def collision_for(lib):
    if id(lib) not in _INSTANCES:_INSTANCES[id(lib)]=PairwiseCollision(lib)
    return _INSTANCES[id(lib)]
