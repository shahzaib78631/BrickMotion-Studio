"""Compare saved joint arrows with a validation-calibrated frozen baseline."""
from pathlib import Path
import argparse,json,sys
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
import cv2,numpy as np,torch
from brickheadz.keypoint_data import load_reviewed
from brickheadz.joint_arrows import load,detect_arrows
from brickheadz.arrow_direction import load as load_parent,predict_maps,evaluate
from train_joint_arrows import choose,scores


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--run',type=Path,default=ROOT/'.cache/instructions/joint-arrows/catalog-100');args=p.parse_args()
    torch.set_num_threads(4);cv2.setNumThreads(1);device='mps' if torch.backends.mps.is_available() else 'cpu'
    model,thresholds,meta=load(args.run/'best.pt',device)
    rows=load_reviewed(ROOT/'benchmarks/instructions/arrow-catalog-100-labels.json',ROOT)
    validation=[r for r in rows if r['split']=='validation' and r['complete'][1]];test=[r for r in rows if r['split']=='test' and r['complete'][1]]
    parent,parent_thresholds,_=load_parent(ROOT/'.cache/instructions/arrow-direction/multi-booklet/best.pt',device)
    original_parent_thresholds=list(parent_thresholds)
    threshold,baseline_validation=choose(parent,validation,device,parent_thresholds[0]);parent_thresholds=[parent_thresholds[0],threshold]
    baseline=evaluate(test,predict_maps(parent,test,device),parent_thresholds,hybrid=False)
    old_rows=load_reviewed(ROOT/'benchmarks/instructions/arrow-direction-corpus-labels.json',ROOT);transfer={}
    for book in sorted({r['booklet'] for r in old_rows if r['split']=='test'}):
        subset=[r for r in old_rows if r['booklet']==book and r['split']=='test']
        assert book not in meta['trainingBooklets'] and book not in meta['validationBooklets']
        transfer[book]={'joint':scores(evaluate(subset,predict_maps(model,subset,device),thresholds,hybrid=False)),
                        'previous':scores(evaluate(subset,predict_maps(parent,subset,device),parent_thresholds,hybrid=False)),
                        'previousSavedHybrid':scores(evaluate(subset,predict_maps(parent,subset,device),original_parent_thresholds,hybrid=True))}
    # Visual predictions use no labels; green truth is drawn only afterward.
    patches=[]
    for row in test:
        im=cv2.cvtColor(row['rgb'],cv2.COLOR_RGB2BGR)
        predictions=detect_arrows(model,row['rgb'],thresholds,device)
        for a in row['arrow_instances']:
            cv2.arrowedLine(im,tuple(np.rint(a['head_base']).astype(int)),tuple(np.rint(a['tip']).astype(int)),(0,170,0),1,tipLength=.2)
        for a in predictions:
            if a['headBase'] is not None:cv2.arrowedLine(im,tuple(np.rint(a['headBase']).astype(int)),tuple(np.rint(a['tip']).astype(int)),(220,0,220),1,tipLength=.2)
        path=args.run/(row['id']+'-prediction.png');cv2.imwrite(str(path),im)
        canvas=np.full((216,192,3),255,np.uint8);canvas[:192]=cv2.resize(im,(192,192),interpolation=cv2.INTER_NEAREST);cv2.putText(canvas,row['id'],(2,207),0,.35,(0,0,0),1);patches.append(canvas)
    for start in range(0,len(patches),24):
        subset=patches[start:start+24];canvas=np.full((int(np.ceil(len(subset)/6))*216,6*192,3),255,np.uint8)
        for i,im in enumerate(subset):canvas[i//6*216:(i//6+1)*216,i%6*192:(i%6+1)*192]=im
        cv2.imwrite(str(args.run/f'test-predictions-{start//24+1}.jpg'),canvas)
    result={'baselineThresholdCalibratedOnValidation':parent_thresholds,'baselineValidation':baseline_validation,'baselineCompleteTest':scores(baseline),
            'previousSavedHybridCompleteTest':scores(evaluate(test,predict_maps(parent,test,device),original_parent_thresholds,hybrid=True)),
            'earlierLargerRegions':transfer,'selectedStep':meta['step'],'jointThreshold':thresholds,
            'caveat':'New catalog test uses selected 96x96 crops, dominated by red/green arrows; earlier larger regions assess a different distribution. No model or threshold selected using these tests. Agent-reviewed annotations, not independent human ground truth.'}
    # Also sanitize reports produced by an earlier running trainer version:
    # partial labels cannot establish precision or F1.
    run_report=args.run/'report.json'
    if run_report.exists():
        report=json.loads(run_report.read_text());partial=report.get('partialTestDiagnostic',{})
        if partial.get('partialRegions'):
            for key in ('locationF1','directedF1','precision'):partial[key]=None
            if not partial.get('completeRegions'):partial['falsePositives']=None
            partial['partialLabelCaveat']='Recall concerns known labelled heads only; unlabelled heads are unknown. Precision and F1 are unavailable.'
        run_report.write_text(json.dumps(report,indent=2))
    (args.run/'transfer-report.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))

if __name__=='__main__':main()
