"""Evaluate direction models with explicit training/development roles per booklet."""
from pathlib import Path
import argparse,hashlib,json,sys
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
import torch
from brickheadz.keypoint_data import load_reviewed
from brickheadz.arrow_annotations import validate_instances
from brickheadz.arrow_direction import load,predict_maps,evaluate


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--checkpoint',type=Path,default=ROOT/'.cache/instructions/arrow-direction/expanded-real/best.pt')
    p.add_argument('--labels',type=Path,default=ROOT/'benchmarks/instructions/arrow-direction-expanded-labels.json')
    p.add_argument('--out',type=Path,default=ROOT/'.cache/instructions/arrow-direction/evaluation')
    args=p.parse_args();args.out.mkdir(parents=True,exist_ok=True);torch.set_num_threads(4)
    device='mps' if torch.backends.mps.is_available() else 'cpu';model,thresholds,metadata=load(args.checkpoint,device)
    rows=load_reviewed(args.labels,ROOT)
    for row in rows:validate_instances(row)
    report={'checkpoint':str(args.checkpoint.resolve()),'checkpointSHA256':hashlib.sha256(args.checkpoint.read_bytes()).hexdigest(),
            'labelsSHA256':hashlib.sha256(args.labels.read_bytes()).hexdigest(),'modelMetadata':metadata,
            'weightsOrThresholdsSelected':False,'automaticPipelineEnabled':False,
            'caveat':json.loads(args.labels.read_text())['limitations'],'byBooklet':{}}
    for book in sorted({r['booklet'] for r in rows}):
        subset=[r for r in rows if r['booklet']==book]
        if len({r['split'] for r in subset})!=1:raise ValueError('Ambiguous evaluation role')
        role='training diagnostic' if subset[0]['split']=='train' else 'development check; excluded from training'
        measured=evaluate(subset,predict_maps(model,subset,device),thresholds,hybrid=True)
        report['byBooklet'][book]={'role':role,**measured}
    (args.out/'report.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({b:{'role':v['role'],'metrics':v['metrics']} for b,v in report['byBooklet'].items()},indent=2))

if __name__=='__main__':main()
