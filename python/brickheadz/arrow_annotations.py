"""Direction annotation validation and geometry-preserving image transforms."""
from __future__ import annotations
import copy
import numpy as np


def validate_instances(sample):
    instances=sample.get('arrow_instances',[])
    if len(instances)!=len(sample['arrow_tips']):raise ValueError('Every labelled tip requires an arrow instance')
    ids=set()
    for tip,arrow in zip(sample['arrow_tips'],instances):
        if arrow['id'] in ids:raise ValueError('Duplicate arrow identity')
        ids.add(arrow['id'])
        points=np.asarray([arrow['tip'],arrow['head_base']],float)
        if points.shape!=(2,2) or not np.isfinite(points).all():raise ValueError('Invalid arrow coordinates')
        if not np.allclose(tip,arrow['tip']):raise ValueError('Arrow instance/tip mismatch')
        if np.linalg.norm(points[0]-points[1])<2:raise ValueError('Degenerate arrowhead direction')
        shaft=arrow.get('shaft')
        if shaft is not None:
            path=np.asarray(shaft,float)
            if path.ndim!=2 or path.shape[1]!=2 or len(path)<2 or not np.isfinite(path).all():raise ValueError('Invalid shaft path')
            if not np.allclose(path[-1],arrow['head_base']):raise ValueError('Shaft must terminate at head base')


def transform_instances(instances,matrix,bounds):
    """Retain supervision only when both tip and head base have visible context.

    Shaft paths may be cropped; this is recorded rather than pretending the
    complete shaft is visible. Directions follow the local head segment.
    """
    matrix=np.asarray(matrix,float);w,h=bounds;result=[]
    def point(p):return (matrix@np.r_[p,1.]).tolist()
    def inside(p):return 2<=p[0]<w-2 and 2<=p[1]<h-2
    for original in instances:
        arrow=copy.deepcopy(original);arrow['tip']=point(arrow['tip']);arrow['head_base']=point(arrow['head_base'])
        if not inside(arrow['tip']) or not inside(arrow['head_base']):continue
        if arrow.get('shaft') is not None:
            arrow['shaft']=[point(p) for p in arrow['shaft']]
            arrow['shaft_complete']=arrow.get('shaft_complete',False) and all(inside(p) for p in arrow['shaft'])
        result.append(arrow)
    return result
