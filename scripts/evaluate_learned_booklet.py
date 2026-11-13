"""Compare baseline/raw/refined/fused observations on the frozen real milestone."""
from pathlib import Path
import argparse,json,sys
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
import torch
from assembly_model.ldraw import load_library
from brickheadz.image_spec import ldconfig_rgb
from brickheadz.booklet_vision import reconstruct_sequence,reconstruct_panel_build
from brickheadz.keypoint_model import LearnedObserver
from brickheadz.pose_ranker import PoseRanker
from brickheadz.parts import info
from brickheadz.reconstruct import steps_from_omr
from reconstruct_real_sequence import read_image,evaluate_groups,write_mpd


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--checkpoint',type=Path,default=ROOT/'.cache/instructions/keypoint-learning/pilot/best.pt')
    p.add_argument('--direction-checkpoint',type=Path,help='Optional direction model; adds a metadata-only direction rollout')
    p.add_argument('--pose-checkpoint',type=Path,default=ROOT/'.cache/instructions/pose-learning/pilot/best.pt')
    p.add_argument('--job',type=Path,default=ROOT/'.cache/instructions/heroes-complete-regression/placement-job.json')
    p.add_argument('--out',type=Path,default=ROOT/'.cache/instructions/keypoint-learning/assembly-evaluation')
    args=p.parse_args();args.out.mkdir(parents=True,exist_ok=True)
    lib=load_library(str(ROOT/'public/ldraw'));palette=ldconfig_rgb(str(ROOT/'public/ldraw/LDConfig.ldr'))
    job=json.loads(args.job.read_text());device='mps' if torch.backends.mps.is_available() else 'cpu';cases=[]
    for index,last,label in [(0,4,'superman-opening'),(1,2,'batman-opening')]:
        inputs=[]
        for i,s in enumerate(job['models'][index]['steps'][:last]):
            parts=[(v['part'],v['color']) for v in s['parts'] for _ in range(v['count'])]
            if i==0:
                if len(parts)>1:
                    seed=max(parts,key=lambda pc:info(lib,pc[0]).w*info(lib,pc[0]).d);parts.remove(seed)
                else:
                    r=job['unassignedInventory'][0];seed=(r['part'],r['color'])
            inputs.append({'number':s['number'],'rgb':read_image(s['image']),'parts':parts})
        cases.append((label,inputs,seed))
    result={'checkpoint':str(args.checkpoint),'directionCheckpoint':str(args.direction_checkpoint) if args.direction_checkpoint else None,'truthUsedForInference':False,'cases':{}}
    modes=['baseline','raw','refined','fused','learned-and-ranker','hybrid-and-ranker']
    if args.direction_checkpoint:modes.append('direction-and-ranker')
    for mode in modes:
        if mode=='direction-and-ranker':
            from brickheadz.arrow_direction import DirectionObserver
            observer=DirectionObserver(args.direction_checkpoint,device)
        else:observer=None if mode=='baseline' else LearnedObserver(args.checkpoint,'raw' if mode in ('learned-and-ranker','hybrid-and-ranker') else mode,device,arrow_geometry=mode=='hybrid-and-ranker')
        ranker=PoseRanker(args.pose_checkpoint,device) if mode in ('learned-and-ranker','hybrid-and-ranker','direction-and-ranker') else None
        reports={}
        for label,inputs,seed in cases:
            try:
                built,groups,details=reconstruct_sequence(lib,palette,inputs,seed,observer=observer,candidate_ranker=ranker)
                write_mpd(args.out/f'{label}-{mode}.mpd',groups)
                # The reference is evaluated only after reconstruction is complete.
                expected=steps_from_omr(str(ROOT/f'benchmarks/instructions/{label}-reference.ldr'),preserve_empty=True)
                reports[label]={'evaluation':evaluate_groups(lib,groups,expected),'steps':details}
            except ValueError as error:reports[label]={'failed':str(error),'allExact':False}
        step=job['models'][0]['steps'][33]
        parts=[(v['part'],v['color']) for v in step['parts'] for _ in range(v['count'])]
        try:
            built,groups,details,_=reconstruct_panel_build(lib,palette,read_image(step['image']),parts,observer=observer,candidate_ranker=ranker)
            write_mpd(args.out/f'subbuild-{mode}.mpd',groups)
            expected=steps_from_omr(str(ROOT/'benchmarks/instructions/superman-34-audited.ldr'),preserve_empty=True)
            reports['subbuild']={'evaluation':evaluate_groups(lib,groups,expected),'panels':details}
        except ValueError as error:reports['subbuild']={'failed':str(error),'allExact':False}
        result['cases'][mode]=reports
        print(json.dumps({'mode':mode,'cases':{key:value.get('evaluation',value) for key,value in reports.items()}},indent=2),flush=True)
    (args.out/'report.json').write_text(json.dumps(result,indent=2))

if __name__=='__main__':main()
