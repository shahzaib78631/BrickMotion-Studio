"""Measured reconstruction of small, studs-up instruction sequences.

Uses real image stud centres, arrow tips, and LDraw polygon silhouettes. No
reference model or target poses are accepted by the inference API. This is a
limited plate/tile experiment, not an arbitrary instruction interpreter.
Install the optional ``vision`` extra to run it.
"""
from __future__ import annotations
from dataclasses import dataclass
from itertools import combinations
from functools import lru_cache
import math

import cv2
import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.distance import cdist

from brickheadz.instruction_place import Camera, grid_matrix
from brickheadz.parts import info, body_aabb


@dataclass
class Observation:
    rgb: np.ndarray
    foreground: np.ndarray
    studs: np.ndarray  # x,y,major,minor
    arrows: np.ndarray  # receiving-stud positions
    arrow_directions: np.ndarray | None = None  # image unit vectors; NaN means unknown


def observe(rgb):
    rgb=np.asarray(rgb,np.uint8)
    bg=np.median(np.array([rgb[0,0],rgb[0,-1],rgb[-1,0],rgb[-1,-1]]),axis=0)
    foreground=np.linalg.norm(rgb.astype(float)-bg,axis=2)>35
    if foreground.sum()<50:raise ValueError("No usable model drawing in the image")
    big=cv2.resize(rgb,None,fx=3,fy=3,interpolation=cv2.INTER_CUBIC)
    saturation=big.max(2).astype(np.int16)-big.min(2)
    colour=((saturation>100)&(big.max(2)>140)).astype(np.uint8)*255
    edges=cv2.Canny(big,60,140)
    found=[]
    dark=(cv2.cvtColor(big,cv2.COLOR_RGB2GRAY)<100).astype(np.uint8)*255
    for mask in (colour,edges,dark):
        contours,_=cv2.findContours(mask,cv2.RETR_LIST,cv2.CHAIN_APPROX_NONE)
        for contour in contours:
            if len(contour)<15:continue
            (x,y),(a,b),angle=cv2.fitEllipse(contour)
            if min(a,b)<8 or max(a,b)>big.shape[1]*.2 or not .35<min(a,b)/max(a,b)<.68:continue
            t=np.deg2rad(angle)
            r=np.array([[np.cos(t),np.sin(t)],[-np.sin(t),np.cos(t)]])
            q=(contour[:,0,:]-[x,y])@r.T/[a/2,b/2]
            if np.mean(np.abs(np.linalg.norm(q,axis=1)-1))>.07:continue
            if cv2.contourArea(contour)<.7*np.pi*a*b/4:continue
            if any(np.hypot(x/3-s[0],y/3-s[1])<2 for s in found):continue
            found.append((x/3,y/3,max(a,b)/3,min(a,b)/3))
    if found:
        median=np.median([s[2] for s in found])
        found=[s for s in found if .75*median<s[2]<1.3*median]
    # Green arrows are diagram marks, not new part pixels. Their pointed lower
    # endpoints identify receiving studs, even when the new part is exploded.
    green=(rgb[:,:,1]>rgb[:,:,0]*1.3)&(rgb[:,:,1]>rgb[:,:,2]*1.2)&(rgb[:,:,1]>70)
    n,labels,stats,_=cv2.connectedComponentsWithStats(green.astype(np.uint8))
    tips=[]
    for i in range(1,n):
        x,y,w,h,area=stats[i]
        if area<12 or h<2*w:continue
        yy,xx=np.where(labels==i)
        end=yy.max(); tips.append((float(np.median(xx[yy>=end-1])),float(end)))
    return Observation(rgb,foreground,np.array(found,float).reshape(-1,4),np.array(tips,float).reshape(-1,2))


def lattice_camera(studs):
    if len(studs)<6:raise ValueError('Too few visible studs to estimate a lattice')
    centres=studs[:,:2]; diameter=np.median(studs[:,2])
    diffs=(centres[:,None]-centres[None,:]).reshape(-1,2)
    length=np.linalg.norm(diffs,axis=1)
    good=(diffs[:,0]>0)&(length>diameter*1.05)&(length<diameter*2.2)
    candidates=diffs[good]
    directions=[]
    for sign in (-1,1):
        subset=candidates[(candidates[:,1]*sign>.2*candidates[:,0]) & (candidates[:,1]*sign<1.4*candidates[:,0])]
        if not len(subset):raise ValueError('Two independent stud lattice directions were not found')
        neighbours=cdist(subset,subset)<1.8
        clusters=[]
        for index in np.argsort(-neighbours.sum(1)):
            vector=np.median(subset[neighbours[index]],axis=0)
            if any(np.linalg.norm(vector-old[0])<2 for old in clusters):continue
            clusters.append((vector,int(neighbours[index].sum())))
            if len(clusters)==8:break
        directions.append(clusters)
    # Cross-height point pairs can be more numerous than true grid neighbours.
    # Both grid axes must imply the same orthographic camera elevation, also
    # broadly consistent with the detected circular studs' ellipse aspect ratio.
    aspect=float(np.median(studs[:,3]/studs[:,2]));pairs=[]
    for u,uc in directions[0]:
        for v,vc in directions[1]:
            a,b=u[1]/v[0],-v[1]/u[0]
            if max(abs(a),abs(b))>=1 or abs(a-b)>.15:continue
            if abs(abs((a+b)/2)-aspect)>.18:continue
            pairs.append((uc+vc-20*abs(a-b),u,v))
    if not pairs:raise ValueError('Detected grid directions do not form a consistent camera')
    _score,u,v=max(pairs,key=lambda item:item[0])
    scale=np.hypot(u[0],v[0])/20
    yaw=np.degrees(np.arctan2(v[0],u[0]))
    pitch=np.degrees(np.arcsin(np.clip(np.mean([u[1]/v[0],-v[1]/u[0]]),-.99,.99)))
    return Camera(float(yaw),float(pitch),float(scale)), (u,v)


def projected(cam,points):
    u,v,_=cam.project(np.asarray(points));return np.column_stack([u,v])


def stud_points(lib,part,matrix):
    out=[]
    for snap in lib.snaps(part+'.dat'):
        if snap.gender=='M' and np.allclose(snap.axis,(0,-1,0)):
            point=np.array(snap.pos)+np.array(snap.axis)*4
            out.append(matrix[:3,:3]@point+matrix[:3,3])
    return np.unique(np.round(out,5),axis=0) if out else np.empty((0,3))


def visible_studs(lib,pieces):
    boxes=[body_aabb(lib,p,m) for p,c,m in pieces]
    result=[]
    for i,(part,colour,matrix) in enumerate(pieces):
        for point in stud_points(lib,part,matrix):
            if any(j!=i and np.all(point>np.array(lo)+.1) and np.all(point<np.array(hi)-.1)
                   for j,(lo,hi) in enumerate(boxes)):
                continue
            result.append((point,colour))
    return result


@lru_cache(maxsize=128)
def _mesh(lib,part):
    polygons=lib._tri_walk(part+'.dat',np.eye(4))
    if not polygons:raise ValueError(f'Missing geometry: {part}')
    return np.concatenate(polygons),np.cumsum([0,*[len(p) for p in polygons]])


def silhouette(lib,part,matrix,cam,shape):
    mask=np.zeros(shape,np.uint8)
    vertices,offsets=_mesh(lib,part)
    world=vertices@matrix[:3,:3].T+matrix[:3,3]
    uv=np.rint(projected(cam,world)).astype(np.int32)
    for start,end in zip(offsets[:-1],offsets[1:]):
        cv2.fillConvexPoly(mask,uv[start:end],1)
    return mask.astype(bool)


def colour_mask(obs,colour,palette):
    target=np.array(palette[colour],float)
    chroma=target-target.mean()
    rgb=obs.rgb.astype(float)
    if np.ptp(target)>40:
        # Hue direction tolerates booklet flat shading without confusing red and yellow.
        vectors=rgb-rgb.mean(2,keepdims=True)
        similarity=(vectors@chroma)/(np.linalg.norm(vectors,axis=2)*np.linalg.norm(chroma)+1e-9)
        raw=(similarity>.94)&(np.ptp(rgb,axis=2)>70)&obs.foreground
    else:
        raw=obs.foreground&(np.ptp(rgb,axis=2)<45)&(rgb.mean(2)<160)
    # Close thin drawing outlines, then fill enclosed stud-ring holes.
    mask=cv2.morphologyEx(raw.astype(np.uint8),cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
    contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(mask,contours,-1,1,cv2.FILLED)
    return mask.astype(bool)


def overlap(a,b):
    return float((a&b).sum())/max(1,int((a|b).sum()))


def align_camera(lib,pieces,obs,cam,palette,*,minimum=4):
    points=visible_studs(lib,pieces)
    if not points:raise ValueError('No known visible studs for camera alignment')
    world=np.array([p for p,c in points]);pred=projected(cam,world)
    actual=obs.studs[:,:2]
    if not len(actual):raise ValueError('No image studs for camera alignment')
    # Stud correspondence must preserve colour. Matching red known studs to
    # newly added yellow studs creates a convincing but one-row-shifted camera.
    pixels=obs.rgb[np.clip(np.rint(actual[:,1]).astype(int),0,obs.rgb.shape[0]-1),
                   np.clip(np.rint(actual[:,0]).astype(int),0,obs.rgb.shape[1]-1)].astype(float)
    vectors=pixels-pixels.mean(1,keepdims=True)
    compatible=[]
    for _point,colour in points:
        target=np.array(palette[colour],float);chroma=target-target.mean()
        if np.ptp(target)>40:
            similarity=(vectors@chroma)/(np.linalg.norm(vectors,axis=1)*np.linalg.norm(chroma)+1e-9)
            compatible.append((similarity>.92)&(np.ptp(pixels,axis=1)>65))
        else:compatible.append(np.ptp(pixels,axis=1)<50)
    compatible=np.array(compatible)
    # Translation hypotheses from all possible correspondence pairs; no pose truth.
    proposals=[]
    all_world=np.concatenate([lib.triangles(p+'.dat')@m[:3,:3].T+m[:3,3] for p,c,m in pieces])
    model_bounds=projected(cam,all_world)
    fy,fx=np.where(obs.foreground)
    observed_bounds=np.array([fx.min(),fy.min(),fx.max(),fy.max()])
    base_bounds=np.r_[model_bounds.min(0),model_bounds.max(0)]
    for offset in (actual[:,None]-pred[None,:]).reshape(-1,2):
        distance=cdist(pred+offset,actual)
        distance[~compatible]=1e6
        nearest=distance.argmin(1)
        hits=distance.min(1)<2
        count=len(set(nearest[hits]))
        box_error=np.abs(base_bounds+np.tile(offset,2)-observed_bounds).sum()
        proposals.append((count,-box_error,offset,nearest,hits))
    proposals.sort(key=lambda x:(-x[0],-x[1]))
    count,_error,offset,nearest,hits=proposals[0]
    if count<minimum:raise ValueError(f'Only {count} camera correspondences; need {minimum}')
    # One-to-one matches only.
    chosen=[];used=set()
    for i in np.argsort(np.linalg.norm(pred+offset-actual[nearest],axis=1)):
        if hits[i] and nearest[i] not in used:chosen.append(i);used.add(nearest[i])
    chosen=np.array(chosen)
    initial=np.array([cam.yaw,cam.pitch,cam.scale,*offset])
    def residual(values):
        trial=Camera(*values)
        return (projected(trial,world[chosen])-actual[nearest[chosen]]).ravel()
    fitted=least_squares(residual,initial,bounds=([5,-70,.05,-10000,-10000],[85,-5,20,10000,10000]),max_nfev=150)
    camera=Camera(*fitted.x)
    return camera,{'matches':count,'rmsPixels':float(np.sqrt(np.mean(residual(fitted.x)**2))),
                   'yaw':camera.yaw,'pitch':camera.pitch,'scale':camera.scale,'ox':camera.ox,'oy':camera.oy}


def placements(lib,part,built,footprint):
    heights={}
    for p,c,m in built:
        lo,hi=body_aabb(lib,p,m)
        for x in range(round(lo[0]/20),round(hi[0]/20)):
            for z in range(round(lo[2]/20),round(hi[2]/20)):
                heights[x,z]=max(heights.get((x,z),0),round(-lo[1]/8))
    for turn in (0,90,180,270):
        theta=math.radians(turn)
        r=np.round([[math.cos(theta),0,math.sin(theta)],[0,1,0],[-math.sin(theta),0,math.cos(theta)]])
        _m,w,d=grid_matrix(lib,part,0,0,0,r)
        for x in range(footprint[0]-w+1):
            for z in range(footprint[1]-d+1):
                y=max(heights.get((xx,zz),0) for xx in range(x,x+w) for zz in range(z,z+d))
                matrix,_,_=grid_matrix(lib,part,x,y,z,r)
                yield matrix,(x,y,z,turn)


def solve_additions(lib,built,parts,obs,cam,palette,footprint,*,candidate_ranker=None):
    if not parts or len(parts)>2 or (len(parts)==2 and parts[0]!=parts[1]):
        raise ValueError('This experiment requires one addition or two identical additions')
    if any(info(lib,p).h!=1 or info(lib,p).side_studs for p,c in parts):
        raise ValueError('Only studs-up plates/tiles are supported by this experiment')
    colours={c for p,c in parts}
    targets={c:colour_mask(obs,c,palette) for c in colours}
    prior={c:np.zeros(obs.foreground.shape,bool) for c in colours}
    for p,c,m in built:
        if c in colours:prior[c]|=silhouette(lib,p,m,cam,obs.foreground.shape)
    choices=[]
    for part,colour in parts:
        row=[]
        for matrix,grid in placements(lib,part,built,footprint):
            mask=silhouette(lib,part,matrix,cam,obs.foreground.shape)
            # Rank using joint scene colour coverage, not an isolated colour blob.
            quality=overlap(prior[colour]|mask,targets[colour])
            arrow_error=0.
            if len(obs.arrows):
                tops=stud_points(lib,part,matrix)
                if not len(tops):continue
                # Arrow endpoints mark receiving studs on the supporting surface.
                receiving=tops.copy();receiving[:,1]+=info(lib,part).h*8
                arrow_error=float(np.minimum(cdist(obs.arrows,projected(cam,receiving)).min(1),50).mean())
                quality=-arrow_error
            row.append((quality,matrix,grid,mask,arrow_error,quality))
        if candidate_ranker and row:
            scores=candidate_ranker(lib,part,colour,[r[1] for r in row],[r[3] for r in row],obs,built,cam,palette)
            if len(scores)!=len(row) or not np.isfinite(scores).all():raise ValueError('Invalid candidate ranker output')
            row=[(float(score),*item[1:]) for score,item in zip(scores,row)]
        row.sort(key=lambda item:-item[0])
        choices.append(row)
    if any(not row for row in choices):raise ValueError('No legal in-footprint placement candidates')
    if len(parts)==1:
        best=choices[0][0]
        if len(obs.arrows) and best[4]/cam.scale>5:
            raise ValueError('Arrow endpoints do not identify a supported placement')
        if not len(obs.arrows) and best[5]<.85:
            raise ValueError(f'Insufficient image agreement: {best[5]:.3f}')
        selected_box=body_aabb(lib,parts[0][0],best[1])
        alternatives=[item[0] for item in choices[0] if not np.allclose(body_aabb(lib,parts[0][0],item[1]),selected_box)]
        return [(parts[0][0],parts[0][1],best[1])],{'score':best[0],'grid':[best[2]],'arrowErrorPixels':best[4],
            'nextDifferentBoundsScore':max(alternatives) if alternatives else None,
            'geometricScore':best[5], 'metric':'neural candidate logit' if candidate_ranker else ('negative arrow endpoint distance in pixels' if len(obs.arrows) else 'scene-colour silhouette IoU')}
    # Joint enumeration for the two identical tiles in the selected sequence.
    if len(parts)!=2 or parts[0]!=parts[1]:raise ValueError('Milestone supports one addition or two identical additions')
    results=[]
    for a,b in combinations(choices[0],2):
        alo,ahi=body_aabb(lib,parts[0][0],a[1]);blo,bhi=body_aabb(lib,parts[0][0],b[1])
        if np.all(np.minimum(ahi,bhi)-np.maximum(alo,blo)>1e-3):continue
        score=overlap(prior[parts[0][1]]|a[3]|b[3],targets[parts[0][1]])
        results.append((a[0]+b[0] if candidate_ranker else score,score,a,b))
    results.sort(key=lambda item:-item[0])
    if not results:raise ValueError('No non-overlapping pair of placements')
    rank_score,score,a,b=results[0]
    if score<.85:raise ValueError(f'Insufficient joint image agreement: {score:.3f}')
    return [(parts[0][0],parts[0][1],a[1]),(parts[1][0],parts[1][1],b[1])],{'score':rank_score,'geometricScore':score,'grid':[a[2],b[2]],'metric':'sum of neural candidate logits' if candidate_ranker else 'joint scene-colour silhouette IoU'}


def split_panels(rgb):
    obs=observe(rgb)
    n,labels,stats,_=cv2.connectedComponentsWithStats(obs.foreground.astype(np.uint8))
    boxes=[tuple(s[:4]) for s in stats[1:] if s[4]>1000 and s[2]>40 and s[3]>40]
    boxes.sort(key=lambda b:b[0])
    result=[]
    bg=np.median(np.array([rgb[0,0],rgb[0,-1],rgb[-1,0],rgb[-1,-1]]),axis=0)
    for x,y,w,h in boxes:
        canvas=np.broadcast_to(bg,(h+12,w+12,3)).copy().astype(np.uint8)
        canvas[6:h+6,6:w+6]=rgb[y:y+h,x:x+w]
        result.append(canvas)
    return result


def align_footprint_camera(lib,built,obs,cam):
    # For this contained plate/tile build, leftmost body and bottom footprint
    # corners persist when the upper surface is covered by studless tiles.
    vertices=np.concatenate([lib.triangles(p+'.dat')@m[:3,:3].T+m[:3,3] for p,c,m in built])
    xy=projected(Camera(cam.yaw,cam.pitch,1),vertices)
    yy,xx=np.where(obs.foreground)
    scale=(xx.max()-xx.min())/np.ptp(xy[:,0])
    result=Camera(cam.yaw,cam.pitch,float(scale),float(xx.min()-xy[:,0].min()*scale),
                  float(yy.max()-xy[:,1].max()*scale))
    return result,{'method':'persistent-footprint','scale':scale,'ox':result.ox,'oy':result.oy}


def reconstruct_sequence(lib,palette,steps,foundation,*,observer=None,candidate_ranker=None):
    observer=observer or observe
    part,colour=foundation
    pi=info(lib,part)
    if pi.h!=1 or not pi.top_studs or pi.side_studs or pi.w*pi.d>64:
        raise ValueError('Foundation must be a small studs-up plate')
    seed=grid_matrix(lib,part,0,0,0,np.eye(3))[0]
    built=[(part,colour,seed)];reports=[];groups=[]
    footprint=(info(lib,part).w,info(lib,part).d)
    for index,step in enumerate(steps):
        obs=observer(step['rgb'])
        camera,_axes=lattice_camera(obs.studs)
        camera,calibration=align_camera(lib,built,obs,camera,palette,minimum=max(4,math.ceil(len(stud_points(lib,part,seed))*.75)) if index==0 else 4)
        if calibration['rmsPixels']/camera.scale>.5:raise ValueError('Stud correspondences do not establish a consistent camera')
        additions,fit=solve_additions(lib,built,step['parts'],obs,camera,palette,footprint,candidate_ranker=candidate_ranker)
        built.extend(additions)
        groups.append(([(part,colour,seed)] if index==0 else [])+additions)
        reports.append({'step':step['number'],'camera':calibration,'fit':fit,
                        'detectedStuds':len(obs.studs),'detectedArrows':len(obs.arrows)})
        if obs.arrow_directions is not None:
            reports[-1]['arrowDirectionVectorsImage']=[v.tolist() if np.isfinite(v).all() else None for v in obs.arrow_directions]
            reports[-1]['directionUsedFor3DPlacement']=False
    return built,groups,reports


def reconstruct_panel_build(lib,palette,rgb,parts,*,observer=None,candidate_ranker=None):
    observer=observer or observe
    panels=split_panels(rgb)
    if len(panels)!=2:raise ValueError(f'Expected two ordered sub-build panels; found {len(panels)}')
    bases=[(p,c) for p,c in parts if info(lib,p).top_studs]
    if len(bases)!=1:raise ValueError('A single studded foundation is required for this panel experiment')
    foundation=bases[0];remaining=list(parts);remaining.remove(foundation)
    if len(remaining)!=2 or remaining[0]!=remaining[1]:raise ValueError('This panel experiment requires two identical covering tiles')
    p,c=foundation;seed=grid_matrix(lib,p,0,0,0,np.eye(3))[0]
    built=[(p,c,seed)];footprint=(info(lib,p).w,info(lib,p).d);reports=[];groups=[]
    camera=None
    for i,panel in enumerate(panels):
        obs=observer(panel)
        if i==0:
            camera,_axes=lattice_camera(obs.studs)
            camera,calibration=align_camera(lib,built,obs,camera,palette)
        else:
            camera,calibration=align_footprint_camera(lib,built,obs,camera)
        additions,fit=solve_additions(lib,built,[remaining[i]],obs,camera,palette,footprint,candidate_ranker=candidate_ranker)
        built.extend(additions);groups.append(([foundation+(seed,)] if i==0 else [])+additions)
        reports.append({'panel':i+1,'camera':calibration,'fit':fit,'detectedStuds':len(obs.studs)})
    return built,groups,reports,panels


def render_preview(lib,palette,pieces,path):
    """Independent CAD preview of recovered poses, not an input to inference."""
    all_vertices=np.concatenate([lib.triangles(p+'.dat')@m[:3,:3].T+m[:3,3] for p,c,m in pieces])
    camera=Camera(35,-35,1)
    xy=projected(camera,all_vertices);span=xy.max(0)-xy.min(0)
    scale=min(540/span[0],390/span[1])
    camera.scale=float(scale);camera.ox=float(30-xy[:,0].min()*scale);camera.oy=float(30-xy[:,1].min()*scale)
    canvas=np.full((450,600,3),245,np.uint8)
    zbuffer=np.full(canvas.shape[:2],-np.inf,float);edges=[]
    for part,colour,m in pieces:
        vertices,offsets=_mesh(lib,part)
        world=vertices@m[:3,:3].T+m[:3,3]
        u,v,depth=camera.project(world)
        for start,end in zip(offsets[:-1],offsets[1:]):
            polygon=world[start:end]
            normal=np.cross(polygon[1]-polygon[0],polygon[2]-polygon[0])
            normal/=max(1e-9,np.linalg.norm(normal))
            shade=.55+.45*abs(normal[1])
            rgb=np.clip(np.array(palette[colour])*shade,0,255).astype(np.uint8)
            xy=np.column_stack([u[start:end],v[start:end]])
            zz=depth[start:end]
            if len(polygon)==4 and abs(cv2.contourArea(xy.astype(np.float32)))>100:
                edges.append((xy,zz))
            for k in range(1,len(polygon)-1):
                tri=xy[[0,k,k+1]];z=zz[[0,k,k+1]]
                lo=np.maximum(np.floor(tri.min(0)).astype(int),[0,0])
                hi=np.minimum(np.ceil(tri.max(0)).astype(int),[599,449])
                if np.any(lo>hi):continue
                x,y=np.meshgrid(np.arange(lo[0],hi[0]+1)+.5,np.arange(lo[1],hi[1]+1)+.5)
                aa,bb,cc=tri
                denominator=(bb[1]-cc[1])*(aa[0]-cc[0])+(cc[0]-bb[0])*(aa[1]-cc[1])
                if abs(denominator)<1e-9:continue
                w0=((bb[1]-cc[1])*(x-cc[0])+(cc[0]-bb[0])*(y-cc[1]))/denominator
                w1=((cc[1]-aa[1])*(x-cc[0])+(aa[0]-cc[0])*(y-cc[1]))/denominator
                w2=1-w0-w1;d=w0*z[0]+w1*z[1]+w2*z[2]
                region=zbuffer[lo[1]:hi[1]+1,lo[0]:hi[0]+1]
                visible=(w0>=-1e-7)&(w1>=-1e-7)&(w2>=-1e-7)&(d>region)
                region[visible]=d[visible]
                canvas[lo[1]:hi[1]+1,lo[0]:hi[0]+1][visible]=rgb
    for xy,zz in edges:
        for k in range(len(xy)):
            a,b=xy[k],xy[(k+1)%len(xy)];za,zb=zz[k],zz[(k+1)%len(xy)]
            t=np.linspace(0,1,max(2,int(np.linalg.norm(b-a)*2)))
            pixels=np.rint(a[None,:]+t[:,None]*(b-a)).astype(int)
            valid=(pixels[:,0]>=0)&(pixels[:,0]<600)&(pixels[:,1]>=0)&(pixels[:,1]<450)
            pixels=pixels[valid];d=(za+t*(zb-za))[valid]
            visible=d>=zbuffer[pixels[:,1],pixels[:,0]]-.8
            pixels=pixels[visible];canvas[pixels[:,1],pixels[:,0]]=(55,55,55)
    cv2.imwrite(str(path),cv2.cvtColor(canvas,cv2.COLOR_RGB2BGR))
