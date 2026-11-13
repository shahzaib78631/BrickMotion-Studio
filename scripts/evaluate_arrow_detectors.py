"""Compare saved arrow detectors by booklet without selecting weights or thresholds."""
from pathlib import Path
import argparse,json,sys,hashlib
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
import cv2
import numpy as np
import torch
from brickheadz.keypoint_data import load_reviewed
from brickheadz.keypoint_model import load,predict_maps,evaluate
from brickheadz.arrow_geometry import fuse_arrow_tips


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--labels',type=Path,default=ROOT/'benchmarks/instructions/arrow-learning-labels.json')
    parser.add_argument('--before',type=Path,default=ROOT/'.cache/instructions/keypoint-learning/pilot/best.pt')
    parser.add_argument('--after',type=Path,default=ROOT/'.cache/instructions/keypoint-learning/arrows-v3/best.pt')
    parser.add_argument('--out',type=Path,default=ROOT/'.cache/instructions/keypoint-learning/arrow-comparison')
    args=parser.parse_args();args.out.mkdir(parents=True,exist_ok=True)
    torch.set_num_threads(4);device='mps' if torch.backends.mps.is_available() else 'cpu'
    rows=[r for r in load_reviewed(args.labels,ROOT) if r['split']=='test'];definition=json.loads(args.labels.read_text())
    report={'labels':str(args.labels),'labelsSHA256':hashlib.sha256(args.labels.read_bytes()).hexdigest(),
            'developmentBooklets':definition['developmentBooklets'],'transferTestBooklets':definition['transferTestBooklets'],
            'caveat':definition['limitations'],'annotationCorrection':definition.get('annotationCorrection'),'thresholdsChosenBy':'Each saved checkpoint, selected on synthetic validation only',
            'hybridCaveat':'Geometry follow-up examined Batman and Aquaman failure cases; these are development diagnostics for the hybrid, not a new blind test.',
            'geometrySourceSHA256':hashlib.sha256((ROOT/'python/brickheadz/arrow_geometry.py').read_bytes()).hexdigest(),'models':{}}
    predictions={}
    for name,path in [('before',args.before),('after',args.after),('hybrid',args.after)]:
        model,thresholds,metadata=load(path,device);maps=predict_maps(model,rows,device)
        postprocess=fuse_arrow_tips if name=='hybrid' else None
        measured=evaluate(rows,maps,thresholds,arrow_postprocess=postprocess);predictions[name]=measured['samples']
        by_booklet={}
        for booklet in sorted({r['booklet'] for r in rows}):
            indices=[i for i,r in enumerate(rows) if r['booklet']==booklet]
            by_booklet[booklet]=evaluate([rows[i] for i in indices],[maps[i] for i in indices],thresholds,arrow_postprocess=postprocess)
        report['models'][name]={'checkpoint':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
                                'thresholds':thresholds,'metadata':metadata,'byBooklet':by_booklet,
                                'inference':'learned + red shaft/head geometry' if name=='hybrid' else 'learned only'}
    (args.out/'report.json').write_text(json.dumps(report,indent=2))
    for index,row in enumerate(rows):
        if not row['arrow_tips']:continue
        pictures=[]
        for name in ('before','after','hybrid'):
            rgb=row['rgb'].copy()
            for x,y in row['arrow_tips']:cv2.circle(rgb,(round(x),round(y)),5,(0,180,0),1)
            for x,y,score in predictions[name][index]['predictions']['arrow_tips']:
                cv2.drawMarker(rgb,(round(x),round(y)),(200,0,200),cv2.MARKER_CROSS,9,1)
            picture=cv2.cvtColor(rgb,cv2.COLOR_RGB2BGR);picture=cv2.copyMakeBorder(picture,24,0,0,0,cv2.BORDER_CONSTANT,value=(255,255,255))
            cv2.putText(picture,name,(5,17),cv2.FONT_HERSHEY_SIMPLEX,.5,(0,0,0),1);pictures.append(picture)
        cv2.imwrite(str(args.out/f'{row["id"]}-comparison.png'),np.concatenate(pictures,axis=1))
    print(json.dumps({name:{book:r['metrics'] for book,r in value['byBooklet'].items()} for name,value in report['models'].items()},indent=2))

if __name__=='__main__':main()
