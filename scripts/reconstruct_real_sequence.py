"""Reconstruct and independently evaluate selected real booklet images.

cd python && uv run --extra vision python ../scripts/reconstruct_real_sequence.py \
  --job ../.cache/instructions/heroes-complete-regression/placement-job.json \
  --reference ../40859-superman.mpd \
  --subbuild-reference ../benchmarks/instructions/superman-34-audited.ldr

References are opened only after inference and MPD export have finished. They
are optional evaluation inputs and are never supplied to the vision solver.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import sys

import numpy as np
import pymupdf

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'python'))
from assembly_model.ldraw import load_library
from brickheadz.booklet_vision import reconstruct_sequence,reconstruct_panel_build,render_preview
from brickheadz.image_spec import ldconfig_rgb
from brickheadz.parts import info
from brickheadz.reconstruct import steps_from_omr


def read_image(path):
    pix=pymupdf.Pixmap(str(path))
    if pix.alpha:pix=pymupdf.Pixmap(pix,0)
    if pix.n!=3:pix=pymupdf.Pixmap(pymupdf.csRGB,pix)
    return np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width,3).copy()


def write_mpd(path,groups):
    lines=[f'0 FILE {path.stem}.ldr','0 Reconstructed from real instruction images; experimental']
    for group in groups:
        for part,colour,m in group:
            values=(*m[:3,3],*m[:3,:3].ravel())
            lines.append(f'1 {colour} '+ ' '.join(f'{v:.6g}' for v in values)+f' {part}.dat')
        lines.append('0 STEP')
    lines.append('0 NOFILE');path.write_text('\n'.join(lines)+'\n')


def evaluate(lib,predicted,expected):
    def signature(part,m):
        points=lib.triangles(part+'.dat')@m[:3,:3].T+m[:3,3]
        points=np.round(points,3);points[np.abs(points)<.0005]=0
        return np.unique(points,axis=0)
    used=set();results=[]
    for part,colour,m in predicted:
        found=None
        for i,(p,c,truth) in enumerate(expected):
            if i in used or p!=part or c!=colour:continue
            if not np.allclose(m[:3,3],truth[:3,3],atol=.001):continue
            a,b=signature(part,m),signature(p,truth)
            if a.shape==b.shape and np.allclose(a,b,atol=.001):found=i;break
        if found is not None:used.add(found)
        results.append({'part':part,'color':colour,'exactGeometry':found is not None})
    return {'exact':len(used),'expected':len(expected),'predicted':len(predicted),
            'allExact':len(used)==len(expected)==len(predicted),'pieces':results,
            'metric':'part + colour + translation + rotation-equivalent full vertex geometry; 0.001 LDU tolerance'}


def evaluate_groups(lib,predicted_groups,expected_groups):
    total=evaluate(lib,[p for group in predicted_groups for p in group],
                   [p for group in expected_groups for p in group])
    steps=[evaluate(lib,a,b) for a,b in zip(predicted_groups,expected_groups)]
    total['perStep']=steps
    total['allExact']=total['allExact'] and len(predicted_groups)==len(expected_groups) and all(s['allExact'] for s in steps)
    total['stepCountMatches']=len(predicted_groups)==len(expected_groups)
    return total


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job',type=Path,required=True)
    parser.add_argument('--model',type=int,default=0)
    parser.add_argument('--first-step',type=int,default=1)
    parser.add_argument('--last-step',type=int,default=4)
    parser.add_argument('--subbuild-step',type=int,default=34)
    parser.add_argument('--reference',type=Path)
    parser.add_argument('--subbuild-reference',type=Path)
    parser.add_argument('--out',type=Path,default=ROOT/'.cache/instructions/real-sequence/milestone')
    args=parser.parse_args()
    job=json.loads(args.job.read_text())
    if job.get('format')!='brickmotion-placement-job':raise ValueError('Expected a placement-job.json')
    model=job['models'][args.model]
    lib=load_library(str(ROOT/'public/ldraw'));palette=ldconfig_rgb(str(ROOT/'public/ldraw/LDConfig.ldr'))
    selected=[s for s in model['steps'] if args.first_step<=s['number']<=args.last_step]
    if [s['number'] for s in selected]!=list(range(args.first_step,args.last_step+1)):
        raise ValueError('Requested sequence has missing or duplicate steps')
    def parts(step):
        if step.get('issues'):raise ValueError(f'Unreviewed extraction issues in {step["id"]}')
        if any(not p['part'] or p['color'] is None or not p['countVerified'] for p in step['parts']):
            raise ValueError(f'Unresolved parts or quantities in {step["id"]}')
        return [(p['part'],p['color']) for p in step['parts'] for _ in range(p['count'])]
    inputs=[{'number':s['number'],'rgb':read_image(s['image']),'parts':parts(s)} for s in selected]
    if len(inputs[0]['parts'])>1:
        candidates=[pc for pc in inputs[0]['parts'] if info(lib,pc[0]).top_studs and info(lib,pc[0]).h==1]
        candidates.sort(key=lambda pc:info(lib,pc[0]).w*info(lib,pc[0]).d,reverse=True)
        if not candidates or (len(candidates)>1 and info(lib,candidates[0][0]).w*info(lib,candidates[0][0]).d==info(lib,candidates[1][0]).w*info(lib,candidates[1][0]).d):
            raise ValueError('First-step foundation identity is ambiguous')
        root_part,root_colour=candidates[0]
        inputs[0]['parts'].remove((root_part,root_colour))
        seed={'part':root_part,'color':root_colour};seed_source='largest unique studded plate in first-step callouts'
    else:
        candidates=[p for p in job['unassignedInventory'] if p['left']==1 and p['part'] and p['color'] is not None]
        if len(candidates)!=1:raise ValueError('This experiment requires one unassigned foundation candidate')
        seed=candidates[0];seed_source='unique unassigned inventory candidate'
    built,groups,reports=reconstruct_sequence(lib,palette,inputs,(seed['part'],seed['color']))
    out=args.out.resolve();out.mkdir(parents=True,exist_ok=True)
    write_mpd(out/'sequence.mpd',groups)
    sub=[];sub_section=None;sub_built=None
    if args.subbuild_step>0:
        sub=[s for s in model['steps'] if s['number']==args.subbuild_step]
        if len(sub)!=1:raise ValueError('Sub-build step must be unique')
        sub_rgb=read_image(sub[0]['image'])
        sub_built,sub_groups,sub_reports,panels=reconstruct_panel_build(lib,palette,sub_rgb,parts(sub[0]))
        write_mpd(out/'subbuild.mpd',sub_groups)
        render_preview(lib,palette,sub_built,out/'subbuild-preview.png')
        sub_section={'bookletStep':args.subbuild_step,'panels':sub_reports,'pieces':len(sub_built)}
    render_preview(lib,palette,built,out/'sequence-preview.png')
    sources=[{'step':s['number'],'page':s['page'],'image':s['image'],
              'sha256':hashlib.sha256(Path(s['image']).read_bytes()).hexdigest()} for s in selected+sub]
    report={'evidence':'actual PDF-derived images','groundTruthUsedForInference':False,
            'manualPixelAnnotations':False,'cameraFromReference':False,'priorTruthInjection':False,
            'foundation':{'part':seed['part'],'color':seed['color'],'source':seed_source,
                          'poseConvention':'origin chosen at footprint minimum, bottom on local ground; studs upright'},
            'scope':'small studs-up plate/tile sequences; one addition or two identical additions; two-panel covering-tile build',
            'notDemonstrated':['arbitrary booklets','complete sets','sub-build attachment to the full model','SNOT or off-grid placements'],
            'sources':sources,'sequence':{'steps':reports,'pieces':len(built)},
            'subbuild':sub_section}
    # Evaluation deliberately starts only here, after inference and output.
    if args.reference:
        reference_steps=steps_from_omr(str(args.reference),preserve_empty=True)
        expected=reference_steps[args.first_step-1:args.last_step]
        report['sequence']['evaluation']=evaluate_groups(lib,groups,expected)
        report['sequence']['evaluation']['reference']=str(args.reference.resolve())
    if args.subbuild_reference and sub_built is not None:
        expected=steps_from_omr(str(args.subbuild_reference),preserve_empty=True)
        report['subbuild']['evaluation']=evaluate_groups(lib,sub_groups,expected)
        report['subbuild']['evaluation']['reference']=str(args.subbuild_reference.resolve())
    (out/'report.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({'out':str(out),'sequence':report['sequence'].get('evaluation'),
                      'subbuild':(report['subbuild'] or {}).get('evaluation')},indent=2))
    if any(section and section.get('evaluation',{}).get('allExact') is False for section in (report['sequence'],report['subbuild'])):
        return 2
    return 0

if __name__=='__main__':raise SystemExit(main())
