"""Read-only solver audit, with answer keys used only in this diagnostic.

Writes separate snapshots/reports. Never rewrites benchmark outputs or solver code.
"""
from pathlib import Path
import argparse,hashlib,json,sys,shutil,time
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
import numpy as np,cv2
from assembly_model.ldraw import load_library
from booklet_mpd.diagnostic_audit import seed_frame_transforms,transform_parts,completion_evidence
from booklet_mpd.solver.dataset import cases,extract_of,pairs
from booklet_mpd.solver.mepnet import parse_mpd
from booklet_mpd.solver.evaluate import canonical
from booklet_mpd.score import exact_flags,calibration


def serial(value):
    if isinstance(value,np.ndarray):return value.tolist()
    if isinstance(value,np.generic):return value.item()
    raise TypeError(type(value).__name__)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--set',default='41488');p.add_argument('--replay-step',action='store_true')
    p.add_argument('--refresh-snapshot',action='store_true',help='Explicitly replace the saved benchmark snapshot with current results')
    args=p.parse_args();out=ROOT/'.cache/booklet-mpd/independent-diagnostics'/args.set;out.mkdir(parents=True,exist_ok=True)
    original=ROOT/'.cache/booklet-mpd/solver/freerun';snap=out/'snapshots';snap.mkdir(exist_ok=True)
    if args.refresh_snapshot or not all((snap/f'{args.set}.{s}').exists() for s in ('json','mpd')):
        for suffix in ('json','mpd'):shutil.copyfile(original/f'{args.set}.{suffix}',snap/f'{args.set}.{suffix}')
    raw=json.loads((snap/f'{args.set}.json').read_text());files=parse_mpd((snap/f'{args.set}.mpd').read_text());assert len(files)==1,'Only flat solver output supported'
    groups=[[(p.removesuffix('.dat'),c,m) for p,c,m in group] for group in next(iter(files.values()))]
    lib=load_library(str(ROOT/'public/ldraw'));cs=cases(args.set,with_images=False);by_index={c.booklet_step:c for c in cs};first=by_index[0]
    frames=seed_frame_transforms(lib,groups[0][0],first.added[0]);frames=[t for t in frames if all(exact_flags(lib,canonical(lib,transform_parts(groups[0],t),first.added),first.added))]
    assert frames,'First step not fully correct in any seed-symmetric frame; inspect it directly'
    expected=[];predicted=[];prefixes=[];first_bad=None
    for index,group in enumerate(groups):
        case=by_index.get(index)
        if case is None or case.file!=first.file:break
        expected+=case.added;predicted+=group;options=[]
        for t in frames:
            moved=canonical(lib,transform_parts(predicted,t),expected);flags=exact_flags(lib,moved,expected);options.append((sum(flags),flags,t))
        n,flags,t=max(options,key=lambda x:x[0]);row={'index':index,'printedStep':case.step_number,'page':case.page,'expectedPrefixParts':len(expected),'predictedPrefixParts':len(predicted),'exactPrefix':n,'newExact':sum(flags[-len(group):]) if group else 0,'newParts':len(group),'transform':t}
        prefixes.append(row)
        if first_bad is None and (n<len(expected) or len(predicted)!=len(expected)):first_bad=case
    report={'set':args.set,'snapshotSHA256':{s:hashlib.sha256((snap/f'{args.set}.{s}').read_bytes()).hexdigest() for s in ('json','mpd')},
            'sourceCodeSHA256':{s:hashlib.sha256((ROOT/'python/booklet_mpd'/s).read_bytes()).hexdigest() for s in ('solver/pipeline.py','solver/step.py','solver/evaluate.py','solver/candidates.py')},
            'productionSummary':raw['summary'],'firstStepEquivalentFrameCount':len(frames),'prefixAudit':prefixes,
            'completionAudit':completion_evidence(raw['rows']),'productionIncompleteFrom':raw['incomplete_from'],
            'calibrationAtWrittenThreshold':None,'caveat':'Evaluation only. Prefixes use frames consistent with every part of the first step; evaluation stops at a scope/alignment gap. Reference poses never enter production inference.'}
    from booklet_mpd.solver.confidence import MODEL_PATH
    report['currentConfidenceModel']={'path':str(MODEL_PATH),'exists':MODEL_PATH.exists(),
            'caveat':'Current loader state only; the old benchmark did not record a confidence-model hash.'}
    # Read the actual written FLAG markers instead of assuming the current threshold matches an old run.
    confidence=raw['confidence'];flags=[];pending=False
    for line in (snap/f'{args.set}.mpd').read_text().splitlines():
        if line.startswith('0 // BRICKMOTION FLAG'):pending=True
        elif line.startswith('1 '):flags.append(pending);pending=False
    if len(flags)==len(confidence):
        unflagged=[e for marked,(_c,e) in zip(flags,confidence) if not marked];report['writtenFlagAudit']={'flagged':sum(flags),'unflagged':len(unflagged),'unflaggedExactUnderProductionScoring':sum(unflagged),'unflaggedExactFractionUnderProductionScoring':sum(unflagged)/len(unflagged) if unflagged else None,'invalidConfidenceCount':sum(not np.isfinite(c) or not 0<=c<=1 for c,_e in confidence)}
    if first_bad:
        case=first_bad;report['firstDivergentStep']={'index':case.booklet_step,'printedStep':case.step_number,'page':case.page,'file':case.file}
        from booklet_mpd.solver.candidates import candidates
        coverage=[]
        for part,colour,m in case.added:
            cands=candidates(lib,part,case.visible or case.context);hits=[i for i,c in enumerate(cands) if exact_flags(lib,[(part,colour,c['matrix'])],[(part,colour,m)])[0]]
            coverage.append({'part':part,'colour':colour,'expectedMatrix':m,'candidates':len(cands),'exactCandidateIndices':hits})
        report['truePreviousAssemblyCandidateCoverage']=coverage
        import pymupdf
        from booklet_mpd.rawimages import main_model_image_info
        data,_=extract_of(args.set);step=data['steps'][case.booklet_step]
        with pymupdf.open(pairs()[args.set].pdf) as doc:rgb,pts=main_model_image_info(doc[case.page-1],pymupdf.Rect(step['pictureBox']))
        cv2.imwrite(str(out/'first-divergent-source.png'),cv2.cvtColor(rgb,cv2.COLOR_RGB2BGR))
        report['sourceImage']={'path':str((out/'first-divergent-source.png').relative_to(ROOT)),
                'pixelSHA256':hashlib.sha256(rgb.tobytes()).hexdigest(),'ptsPerPixel':pts,
                'base':[(p,c,m) for p,c,m in case.visible or case.context],
                'added':[(p,c,m) for p,c,m in case.added]}
        if args.replay_step:
            from booklet_mpd.solver.step import solve
            from booklet_mpd.solver.collide import Collider
            collider=Collider(lib);start=time.time()
            try:
                result=solve(lib,case.visible or case.context,[(p,c) for p,c,_m in case.added],rgb,pts,collider=collider)
                report['oraclePreviousAndIdentityReplay']={'seconds':time.time()-start,'collisionOracleExact':collider.exact,'status':result.status,'registration':result.registration,'reportedFitIoU':result.fit_iou,'exact':sum(exact_flags(lib,canonical(lib,result.placed,case.added),case.added)),'placed':[(p,c,m) for p,c,m in result.placed],'view':vars(result.view) if result.view else None}
                (out/'audit-replay-progress.json').write_text(json.dumps(report,indent=2,default=serial))
                print('Reference-previous/identity replay complete; fitting diagnostic reference camera',flush=True)
                from booklet_mpd.solver.register import rank_views,search
                from booklet_mpd.solver.step import UPRIGHT
                from booklet_mpd.solver.picture import Picture
                from booklet_mpd.solver.edges import ink_distance,NEAR_INK
                from booklet_mpd.solver.place import Scene,score_candidates,DELTAS,_size
                from booklet_mpd.viewfit import BOOKLET_SCALE
                base=case.visible or case.context;full=base+case.added
                picture=Picture.from_rgb(rgb,pts,BOOKLET_SCALE/pts if pts else None)
                codes=sorted({c for _p,c,_m in full});classes=picture.classes(codes);ink=ink_distance(picture.rgb)
                ranked=rank_views(lib,full,rgb,pts,BOOKLET_SCALE,top=4)
                orientations=list(dict.fromkeys([v[1] for v in ranked]+UPRIGHT))
                reference_camera=search(lib,full,picture,codes,orientations,BOOKLET_SCALE/picture.pts_per_px,classes=classes,on_ink=ink<=NEAR_INK)[0]
                report['referenceCompletedModelCamera']={'registration':reference_camera.score,'view':vars(reference_camera.view),'diagnosticOnly':True}
                part,colour,target=max(case.added,key=lambda x:_size(lib,x[0]));cands=candidates(lib,part,base)
                targets=set(i for i,c in enumerate(cands) if exact_flags(lib,[(part,colour,c['matrix'])],[(part,colour,target)])[0])
                deltas=DELTAS if int(picture.arrows.sum())>=25 else (0.,)
                ranking={}
                for name,view in [('estimated',result.view),('referenceCompleted',reference_camera.view)]:
                    scene=Scene.build(lib,base,view,classes,codes,ink)
                    scored=score_candidates(lib,scene,part,colour,cands,deltas=deltas)
                    indexed=sorted(enumerate(scored),key=lambda x:-x[1].score)
                    rank=min(i+1 for i,(k,s) in enumerate(indexed) if k in targets)
                    expected_score=max(s.score for k,s in indexed if k in targets)
                    ranking[name]={'part':part,'correctCandidateRank':rank,'correctScore':expected_score,'bestScore':indexed[0][1].score,'bestMatrix':indexed[0][1].candidate['matrix'],'correctCandidateCollides':any(collider.hits(part,cands[k]['matrix']) for k in targets),'view':vars(view)}
                report['firstPlacedPartCameraAblation']=ranking
                from booklet_mpd.solver.place import solve_step
                start_fixed=time.time()
                fixed_states=solve_step(lib,lambda model:Scene.build(lib,model,reference_camera.view,classes,codes,ink),
                        base,[(p,c) for p,c,_m in case.added],lambda p,model:candidates(lib,p,model),
                        collides=lambda p,m,_model:collider.hits(p,m),deltas=deltas)
                if fixed_states:
                    best_fixed=fixed_states[0]
                    flags_fixed=exact_flags(lib,canonical(lib,best_fixed.placed,case.added),case.added)
                    report['oraclePreviousIdentityAndCameraReplay']={'exact':sum(flags_fixed),'parts':len(case.added),
                            'predicted':len(best_fixed.placed),'perPartExact':flags_fixed,'seconds':time.time()-start_fixed,
                            'collisionOracleExact':collider.exact,'placed':[(p,c,m) for p,c,m in best_fixed.placed],
                            'diagnosticOnly':True}
                report['sourceCodeUnchangedDuringReplay']={s:hashlib.sha256((ROOT/'python/booklet_mpd'/s).read_bytes()).hexdigest()==h for s,h in report['sourceCodeSHA256'].items()}
            finally:collider.close()
    path=out/'audit.json';path.write_text(json.dumps(report,indent=2,default=serial));print(json.dumps(report,indent=2,default=serial),flush=True)

if __name__=='__main__':main()
