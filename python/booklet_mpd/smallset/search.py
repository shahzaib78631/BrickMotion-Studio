"""Small stud-up models: fit complete camera/placement hypotheses, not the base alone.

Inputs contain RGB step pictures and reviewed new-part identities, never reference poses.
The first step calibrates the booklet's scale; subsequent steps preserve that scale.
"""
from dataclasses import dataclass,field
import time
import cv2,numpy as np
from booklet_mpd.solver.render import View,world_triangles
from booklet_mpd.solver.register import Aligner,register
from booklet_mpd.solver.picture import Picture
from booklet_mpd.solver.edges import ink_distance,NEAR_INK
from booklet_mpd.solver.place import Scene,score_candidates,solve_step,drawn_pose,_size,DELTAS
from booklet_mpd.solver.candidates import candidates


@dataclass
class Hypothesis:
    model:list
    view:View
    scale_points:float
    score:float=0.
    groups:list=field(default_factory=list)
    anchors:tuple=()


_HEIGHTS={}

def upright_candidates(lib,part,model):
    key=(id(lib),part)
    if key not in _HEIGHTS:_HEIGHTS[key]=float(world_triangles(lib,part,np.eye(4)).reshape(-1,3)[:,1].max())
    floor=float(world_triangles(lib,model[0][0],model[0][2]).reshape(-1,3)[:,1].max())
    result=[]
    for c in candidates(lib,part,model)+between_stud_candidates(lib,part,model):
        m=c['matrix']
        if not np.allclose(m[:3,1],[0,1,0]):continue
        # This experiment is explicitly for upright models built above a base plate.
        if _HEIGHTS[key]+m[1,3]>floor+.01:continue
        result.append(c)
    axis=round_axis(lib,model) if COAXIAL_STACK and round_part(lib,part) else None
    if axis is not None:result=[c for c in result if np.linalg.norm(c['matrix'][[0,2],3]-axis)<.01]
    return result


def fit_first(lib,parts,rgb,pts,keep=8,log=print):
    if len(parts)!=2:raise ValueError('Initial calibration currently needs a base and one added part')
    seed=max(parts,key=lambda p:_size(lib,p[0]));other=list(parts);other.remove(seed);other=other[0]
    base=[(*seed,np.eye(4))];cands=upright_candidates(lib,other[0],base)
    picture=Picture.from_rgb(rgb);codes=sorted({c for p,c in parts});classes=image_classes(picture,codes);ink=ink_distance(rgb)
    prior=Aligner(lib,base,classes,codes,on_ink=ink<=NEAR_INK);rows=[];started=time.time()
    for yaw in (25.,35.,45.,55.,65.):
        for pitch in (20.,30.,40.):
            for scale in (.6,.7,.8):
                _,view=prior.evaluate(View(yaw=yaw,pitch=pitch,scale=scale))
                scene=Scene.build(lib,base,view,classes,codes,ink)
                scored=sorted(score_candidates(lib,scene,*other,cands,deltas=(0.,)),key=lambda s:-s.score)
                for s in scored[:4]:
                    model=base+[(*other,s.candidate['matrix'])]
                    fit=Aligner(lib,model,classes,codes,on_ink=ink<=NEAR_INK)
                    value,v=fit.evaluate(view);rows.append((value,v,model))
    rows.sort(key=lambda r:-r[0]);refined=[]
    for _score,view,model in rows[:12]:
        reg=register(lib,model,picture,codes,view.orientation,view.yaw,view.pitch,view.scale,
                     scale_range=(.97,1,1.03),angle_steps=((4.,0),(-4.,0),(0,4.),(0,-4.)),classes=classes,on_ink=ink<=NEAR_INK)
        refined.append(Hypothesis(model,reg.view,reg.view.scale*pts,reg.score,[model]))
    refined.sort(key=lambda h:-h.score)
    log({'initialCandidates':len(cands),'seconds':round(time.time()-started,2),'bestScore':refined[0].score,'view':{'yaw':refined[0].view.yaw,'pitch':refined[0].view.pitch,'scale':refined[0].view.scale}})
    return refined[:keep]


def advance(lib,hyp,parts,rgb,pts,beam=12,keep=3):
    picture=Picture.from_rgb(rgb);codes=sorted({c for p,c,m in hyp.model}|{c for p,c in parts});classes=image_classes(picture,codes);ink=ink_distance(rgb)
    view=hyp.view.replace(scale=hyp.scale_points/pts)
    anchors=[entry for entry in hyp.model if entry[1] in hyp.anchors] or hyp.model
    _,view=Aligner(lib,anchors,classes,codes,on_ink=ink<=NEAR_INK).evaluate(view)
    deltas=DELTAS if picture.arrows.sum()>=15 else (0.,)
    states=solve_unordered(lib,lambda model:Scene.build(lib,model,view,classes,codes,ink),hyp.model,parts,
            lambda p,model:upright_candidates(lib,p,model),beam=beam,per_part=16,deltas=deltas)
    results=[]
    for st in states[:keep]:
        if len(st.placed)!=len(parts):continue
        drawn=hyp.model+[(p,c,drawn_pose(sc)) for (p,c,m),sc in zip(st.placed,st.scores)]
        score=completed_score(lib,drawn,view,picture,codes,classes,ink)
        results.append(Hypothesis(hyp.model+st.placed,view,hyp.scale_points,score,hyp.groups+[st.placed],hyp.anchors))
    return results


def solve_unordered(lib,scene_for,base,parts,candidate_fn,beam=12,per_part=12,deltas=(0.,)):
    """Beam over both part choice and pose; a printed step may add several layers.

    Identical pieces are interchangeable and identical partial assemblies are
    collapsed, preventing factorial growth from repeated pieces.
    """
    from booklet_mpd.solver.place import State
    from .collision import collision_for
    collider=collision_for(lib)
    states=[(State(),tuple(parts))]
    for depth in range(len(parts)):
        expanded=[]
        for st,remaining in states:
            model=base+st.placed
            drawn=base+[(p,c,drawn_pose(sc)) for (p,c,m),sc in zip(st.placed,st.scores)]
            scene=scene_for(drawn)
            for part,colour in sorted(set(remaining)):
                cands=candidate_fn(part,model)
                if not cands:continue
                scored=sorted(score_candidates(lib,scene,part,colour,cands,deltas=deltas),key=lambda s:-s.score)
                kept=[]
                for sc in scored:
                    entry=(part,colour,sc.candidate['matrix'])
                    if collider.overlaps(entry,model):continue
                    if any(pose_key(lib,entry)==pose_key(lib,(part,colour,s.candidate['matrix'])) for s in kept):continue
                    kept.append(sc)
                    if len(kept)>=per_part:break
                rest=list(remaining);rest.remove((part,colour))
                for j,sc in enumerate(kept):
                    sc.margin=sc.score-kept[j+1].score if j+1<len(kept) else 0.
                    expanded.append((State(st.placed+[(part,colour,sc.candidate['matrix'])],st.scores+[sc],st.total+sc.score),tuple(rest)))
        if not expanded:return []
        expanded.sort(key=lambda s:-s[0].total);unique=[];seen=set();buckets={}
        for st,remaining in expanded:
            key=tuple(sorted(pose_key(lib,entry) for entry in st.placed))
            if key in seen:continue
            seen.add(key);bucket=tuple(sorted(remaining));buckets.setdefault(bucket,[]).append((st,remaining))
        # Raw gain favours adding a large piece early. Keep each distinct
        # remaining-parts multiset alive instead of reverting to largest-first.
        quota=max(1,beam//max(1,len(buckets)))
        for options in buckets.values():unique.extend(options[:quota])
        used={id(st) for st,remaining in unique}
        rest=sorted([row for options in buckets.values() for row in options if id(row[0]) not in used],key=lambda s:-s[0].total)
        unique.extend(rest[:max(0,beam-len(unique))]);states=unique
    return [st for st,remaining in states]


_ROUND_SMALL={}
def between_stud_candidates(lib,part,model):
    """Candidate centre contacts for a small round part between four studs.

    The catalog models the four studs, not the possible interstitial contact.
    These proposals still have to pass the real mesh collision checker.
    """
    from brickheadz.connectors import catalog
    cat=catalog();key=(id(lib),part)
    if key not in _ROUND_SMALL:
        v=world_triangles(lib,part,np.eye(4)).reshape(-1,3)
        span=np.ptp(v[:,[0,2]],axis=0);radius=np.linalg.norm(v[:,[0,2]],axis=1).max()
        _ROUND_SMALL[key]=bool(max(span)<=20.01 and radius<=11.)
    if not _ROUND_SMALL[key]:return []
    females=[c for c in cat.connectors(part) or [] if c.sub=='tube']
    if not females:return []
    points=set()
    for p,c,m in model:
        for connector in cat.connectors(p) or []:
            if connector.male:
                w=m@connector.frame
                if np.allclose(-w[:3,1],[0,-1,0]):points.add(tuple(np.round(w[:3,3],3)))
    result=[]
    for x,y,z in points:
        if not all(p in points for p in [(x+20,y,z),(x,y,z+20),(x+20,y,z+20)]):continue
        centre=np.array([x+10,y,z+10])
        for female in females:
            for yaw in (0,90,180,270):
                angle=np.deg2rad(yaw);co,si=np.cos(angle),np.sin(angle);m=np.eye(4);m[:3,:3]=[[co,0,si],[0,1,0],[-si,0,co]];m[:3,3]=centre-m[:3,:3]@female.frame[:3,3]
                result.append({'matrix':m,'axis':np.array([0.,-1.,0.]),'kind':'between-studs'})
    return result


def image_classes(picture,codes):
    classes=picture.classes(codes)
    if 0 in codes:
        rgb=picture.rgb.astype(float)
        dark=(rgb.max(2)<85)&(np.ptp(rgb,axis=2)<45)&picture.foreground&~picture.arrows
        classes[dark]=codes.index(0)
    return classes


def completed_score(lib,model,view,picture,codes,classes,ink):
    """Symmetric coverage: unexplained foreground is penalized, even for black parts."""
    scene=Scene.build(lib,model,view,classes,codes,ink)
    predicted=np.isfinite(scene.depth);target=picture.foreground&~picture.arrows
    iou=np.logical_and(predicted,target).sum()/max(1,np.logical_or(predicted,target).sum())
    known=(classes>=0)&target
    colour=((scene.colour==classes)&known&predicted).sum()/max(1,known.sum())
    edge=np.isfinite(scene.edge_depth);target_ink=(ink<.5)&target
    distance=cv2.distanceTransform((~edge).astype(np.uint8),cv2.DIST_L2,3)
    precision=float((ink[edge]<=NEAR_INK).mean()) if edge.any() else 0.
    recall=float((distance[target_ink]<=NEAR_INK).mean()) if target_ink.any() else 0.
    edge_f1=2*precision*recall/max(1e-9,precision+recall)
    return float(iou+.5*colour+.5*edge_f1)


def infer_compound(lib,spec,view):
    """Infer a small printed subassembly from its own source image and snaps."""
    from pathlib import Path
    root=Path(__file__).resolve().parents[3]
    rgb=cv2.cvtColor(cv2.imread(str(root/spec['image'])),cv2.COLOR_BGR2RGB)
    parts=[tuple(p) for p in spec['parts']];anchor=next(p for p in parts if p[0]==spec['root']);other=parts.copy();other.remove(anchor)
    if len(other)!=1:raise ValueError('Compound seed currently supports one additional part')
    moving=other[0];base=[(*anchor,np.eye(4))];picture=Picture.from_rgb(rgb);codes=sorted({c for p,c in parts});classes=image_classes(picture,codes);ink=ink_distance(rgb)
    _,v=Aligner(lib,base,classes,codes,on_ink=ink<=NEAR_INK).evaluate(view.replace(offset=(0.,0.)))
    scene=Scene.build(lib,base,v,classes,codes,ink)
    scored=score_candidates(lib,scene,*moving,upright_candidates(lib,moving[0],base),deltas=DELTAS)
    if not scored:raise ValueError('No subassembly connection proposals')
    best=max(scored,key=lambda s:s.score)
    return base+[(*moving,best.candidate['matrix'])]


def advance_compound(lib,hyp,spec,rgb,pts,keep=6):
    from .collision import collision_for
    local=infer_compound(lib,spec,hyp.view)
    picture=Picture.from_rgb(rgb);codes=sorted({c for p,c,m in hyp.model+local});classes=image_classes(picture,codes);ink=ink_distance(rgb);view=hyp.view.replace(scale=hyp.scale_points/pts)
    collider=collision_for(lib);result=[];seen=set()
    for p,c,local_m in local:
        for candidate in upright_candidates(lib,p,hyp.model):
            transform=candidate['matrix']@np.linalg.inv(local_m);key=tuple(np.round(transform.ravel(),3))
            if key in seen:continue
            seen.add(key);placed=[(q,k,transform@m) for q,k,m in local];existing=hyp.model.copy();valid=True
            for entry in placed:
                if collider.overlaps(entry,existing):valid=False;break
                existing.append(entry)
            if not valid:continue
            anchors=[entry for entry in hyp.model if entry[1] in hyp.anchors] or hyp.model
            _,v=Aligner(lib,anchors,classes,codes,on_ink=ink<=NEAR_INK).evaluate(view)
            score=completed_score(lib,existing,v,picture,codes,classes,ink)
            result.append(Hypothesis(existing,v,hyp.scale_points,score,hyp.groups+[placed],hyp.anchors))
    result.sort(key=lambda h:-h.score)
    return result[:keep]


_EXACT_SYMMETRIES={}
def pose_key(lib,entry):
    part,colour,m=entry;key=(id(lib),part)
    if key not in _EXACT_SYMMETRIES:
        from booklet_mpd.solver.render import mesh
        vertices=mesh(lib,part).reshape(-1,3)
        def signature(v):
            v=np.round(v,3);v[np.abs(v)<.0005]=0;return np.unique(v,axis=0)
        original=signature(vertices);symmetries=[]
        for yaw in (0,90,180,270):
            a=np.deg2rad(yaw);c,s=np.cos(a),np.sin(a);r=np.array([[c,0,s],[0,1,0],[-s,0,c]])
            v=signature(vertices@r.T)
            if v.shape==original.shape and np.allclose(v,original,atol=.001):symmetries.append(r)
        _EXACT_SYMMETRIES[key]=symmetries or [np.eye(3)]
    rotation=min(tuple(np.round((m[:3,:3]@r).ravel(),3)) for r in _EXACT_SYMMETRIES[key])
    return (part,colour,*tuple(np.round(m[:3,3],2)),*rotation)


def fourfold_units(lib,parts):
    from collections import Counter
    units=[]
    for (p,c),count in Counter(parts).items():
        path=lib.find(p+'.dat');name=open(path,errors='ignore').readline().lower() if path else ''
        if count==4 and 'round' in name and 'corner' in name:units.append(('fourfold',p,c,4))
        else:units.extend([('single',p,c,1)]*count)
    return units


def unit_proposals(lib,unit,model,scene,limit=12):
    from .collision import collision_for
    kind,part,colour,count=unit;collider=collision_for(lib)
    cands=upright_candidates(lib,part,model)
    scored=sorted(score_candidates(lib,scene,part,colour,cands,deltas=(0.,)),key=lambda s:-s.score)
    if kind=='single':
        result=[];seen=set()
        for sc in scored:
            entry=(part,colour,sc.candidate['matrix']);key=pose_key(lib,entry)
            if key in seen or collider.overlaps(entry,model):continue
            seen.add(key);result.append(([entry],[sc],sc.score))
            if len(result)>=limit:break
        return result
    lookup={pose_key(lib,(part,colour,s.candidate['matrix'])):s for s in scored}
    from booklet_mpd.solver.render import mesh
    vertices=mesh(lib,part).reshape(-1,3);lo,hi=vertices.min(0),vertices.max(0)
    result=[];seen=set()
    for x in (lo[0],hi[0]):
        for z in (lo[2],hi[2]):
            pivot=np.array([x,0.,z]);local=[]
            for yaw in (0,90,180,270):
                a=np.deg2rad(yaw);co,si=np.cos(a),np.sin(a);m=np.eye(4);m[:3,:3]=[[co,0,si],[0,1,0],[-si,0,co]];m[:3,3]=-m[:3,:3]@pivot;local.append(m)
            inverse=np.linalg.inv(local[0])
            for first in scored:
                t=first.candidate['matrix']@inverse
                axis=round_axis(lib,model) if COAXIAL_STACK else None
                if axis is not None and np.linalg.norm(t[[0,2],3]-axis)>.01:continue
                placed=[(part,colour,t@m) for m in local];keys=[pose_key(lib,e) for e in placed];group_key=tuple(sorted(keys))
                if group_key in seen or not all(k in lookup for k in keys):continue
                seen.add(group_key);existing=model.copy();valid=True
                for entry in placed:
                    if collider.overlaps(entry,existing):valid=False;break
                    existing.append(entry)
                if valid:
                    scores=[lookup[k] for k in keys];result.append((placed,scores,sum(s.score for s in scores)))
    result.sort(key=lambda row:-row[2]);return result[:limit]


def advance_units(lib,hyp,parts,rgb,pts,beam=8,keep=4):
    from booklet_mpd.solver.place import State
    picture=Picture.from_rgb(rgb);codes=sorted({c for p,c,m in hyp.model}|{c for p,c in parts});classes=image_classes(picture,codes);ink=ink_distance(rgb)
    view=hyp.view.replace(scale=hyp.scale_points/pts);anchors=[e for e in hyp.model if e[1] in hyp.anchors] or hyp.model
    _,view=Aligner(lib,anchors,classes,codes,on_ink=ink<=NEAR_INK).evaluate(view)
    units=fourfold_units(lib,parts)
    heights=[float(world_triangles(lib,u[1],np.eye(4)).reshape(-1,3)[:,1].max()) for u in units]
    order=layer_order(picture,codes,units,view) if max(heights)-min(heights)<.01 else None
    states=[(State(),tuple(units))]
    for depth in range(len(units)):
        expanded=[]
        for st,remaining in states:
            model=hyp.model+st.placed;scene=Scene.build(lib,model,view,classes,codes,ink)
            for unit in sorted(set(remaining)):
                if order and unit[2]!=order[depth]:continue
                rest=list(remaining);rest.remove(unit)
                for placed,scores,value in unit_proposals(lib,unit,model,scene):
                    new=State(st.placed+placed,st.scores+scores,st.total+value)
                    if depth==len(units)-1:new.total=completed_score(lib,hyp.model+new.placed,view,picture,codes,classes,ink)
                    expanded.append((new,tuple(rest)))
        if not expanded:return []
        expanded.sort(key=lambda row:-row[0].total);buckets={};seen=set()
        for st,remaining in expanded:
            key=tuple(sorted(pose_key(lib,e) for e in st.placed))
            if key in seen:continue
            seen.add(key);buckets.setdefault(tuple(sorted(remaining)),[]).append((st,remaining))
        quota=max(1,beam//len(buckets));states=[row for options in buckets.values() for row in options[:quota]]
    result=[]
    for st,remaining in states:
        model=hyp.model+st.placed;score=completed_score(lib,model,view,picture,codes,classes,ink)
        result.append(Hypothesis(model,view,hyp.scale_points,score,hyp.groups+[st.placed],hyp.anchors))
    result.sort(key=lambda h:-h.score);return result[:keep]


def layer_order(picture,codes,units,view):
    """Read equal-height circular layers from the centre-strip colour bands.

    This is enabled only for the repeated round-corner-layer grammar. An
    inconsistent colour count abstains, leaving the unconstrained search.
    """
    from collections import Counter
    if len(units)<2 or len(set(u[2] for u in units))!=2:return None
    target=Counter(u[2] for u in units);labels=image_classes(picture,codes)
    x=int(round(view.offset[0]));half=max(4,picture.rgb.shape[1]//9);strip=labels[:,max(0,x-half):min(labels.shape[1],x+half+1)]
    sequence=[]
    for row in strip:
        counts=[int((row==codes.index(c)).sum()) for c in target]
        best=int(np.argmax(counts))
        if counts[best]<3:continue
        colour=list(target)[best]
        if sequence and sequence[-1][0]==colour:sequence[-1][1]+=1
        else:sequence.append([colour,1])
    bands=[c for c,count in sequence if count>=3][:len(units)]
    if Counter(bands)!=target:return None
    return list(reversed(bands))


COAXIAL_STACK=False
_ROUND_PART={}
def round_part(lib,part):
    key=(id(lib),part)
    if key not in _ROUND_PART:
        path=lib.find(part+'.dat');name=open(path,errors='ignore').readline().lower() if path else ''
        _ROUND_PART[key]='round' in name and 'corner' not in name
    return _ROUND_PART[key]

def round_axis(lib,model):
    from booklet_mpd.solver.render import mesh
    options=[]
    for part,colour,m in model:
        if not round_part(lib,part):continue
        v=mesh(lib,part).reshape(-1,3)
        if max(np.ptp(v[:,[0,2]],axis=0))<=20.01:continue
        options.append((m[1,3],m[[0,2],3]))
    return min(options,key=lambda x:x[0])[1] if options else None
