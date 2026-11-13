"""Train joint location/direction on reviewed real arrows, selecting by unseen books."""
from pathlib import Path
import argparse,collections,hashlib,json,sys,time
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
import cv2,numpy as np,torch
from brickheadz.keypoint_data import load_reviewed,augment
from brickheadz.arrow_annotations import validate_instances,transform_instances
from brickheadz.keypoint_model import tensor_images
from brickheadz.arrow_direction import load as load_parent,raw_tensor_images,predict_maps,evaluate
from brickheadz.joint_arrows import JointArrowNet,joint_loss,save,load
from train_arrow_direction import rotate_sample
from train_booklet_keypoints import dataset


def scores(result):
    m=result['metrics'];tp=m['matchedTips'];fp=m['falsePositives'];fn=m['missedTips'];correct=m['directedCorrect']
    result={'locationF1':2*tp/max(1,2*tp+fp+fn),'directedF1':2*correct/max(1,m['labels']+tp+fp),
            'precision':tp/max(1,tp+fp),'recall':tp/max(1,m['labels']),**m}
    if m['partialRegions']:
        for key in ('locationF1','directedF1','precision'):result[key]=None
        if not m['completeRegions']:result['falsePositives']=None
        result['partialLabelCaveat']='Recall concerns known labelled heads only. Unlabelled heads are unknown; precision and F1 are unavailable.'
    return result


def translated(sample,rng):
    """Move complete source patches to varied locations without inventing labels."""
    matrix=np.array([[1.,0.,rng.uniform(-65,65)],[0.,1.,rng.uniform(-65,65)]])
    result={**sample};result['rgb']=cv2.warpAffine(sample['rgb'],matrix,(256,256),borderValue=tuple(map(int,sample['rgb'][0,0])))
    for key in ('studs','arrow_tips'):
        values=sample[key];result[key]=[q.tolist() for q in np.column_stack([values,np.ones(len(values))])@matrix.T if np.all(q>=2) and np.all(q<254)] if values else []
    result['arrow_instances']=transform_instances(sample.get('arrow_instances',[]),matrix,(256,256));return result


def choose(model,rows,device,stud_threshold):
    maps=predict_maps(model,rows,device);best=None
    for threshold in (.08,.12,.18,.25,.35,.45,.55,.65,.75):
        result=evaluate(rows,maps,[stud_threshold,threshold],hybrid=False);metric=scores(result)
        candidate=(metric['directedF1'],metric['locationF1'],-metric['falsePositives'])
        if best is None or candidate>best[0]:best=(candidate,threshold,metric)
    return best[1:]


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--labels',type=Path,default=ROOT/'benchmarks/instructions/arrow-catalog-100-labels.json')
    p.add_argument('--parent',type=Path,default=ROOT/'.cache/instructions/arrow-direction/multi-booklet/best.pt')
    p.add_argument('--out',type=Path,default=ROOT/'.cache/instructions/joint-arrows/catalog-100')
    p.add_argument('--steps',type=int,default=2400);p.add_argument('--batch',type=int,default=16);p.add_argument('--every',type=int,default=200);p.add_argument('--seed',type=int,default=79)
    args=p.parse_args();args.out.mkdir(parents=True,exist_ok=True);torch.set_num_threads(4);cv2.setNumThreads(1);torch.manual_seed(args.seed);rng=np.random.default_rng(args.seed)
    device='mps' if torch.backends.mps.is_available() else 'cpu';rows=load_reviewed(args.labels,ROOT)
    for row in rows:validate_instances(row)
    train=[r for r in rows if r['split']=='train'];validation=[r for r in rows if r['split']=='validation' and r['complete'][1]]
    test=[r for r in rows if r['split']=='test'];complete_test=[r for r in test if r['complete'][1]]
    groups=collections.defaultdict(list)
    for row in train:groups[row['booklet']].append(row)
    books=sorted(groups);exposure=collections.Counter();queue=[]
    # Reuse fixed, geometry-labelled synthetic TRAIN scenes (never test artwork).
    synthetic=dataset(ROOT/'.cache/instructions/arrow-direction/multi-booklet',1000,False,4100123,4)
    parent,thresholds,_=load_parent(args.parent,device);model=JointArrowNet(parent).to(device)
    frozen={k:v.detach().cpu().clone() for k,v in model.detector.state_dict().items()}
    initial_heads={k:v.detach().cpu().clone() for k,v in model.state_dict().items() if k.startswith(('arrow_heat','arrow_offset','direction'))}
    meta={'labelsSHA256':hashlib.sha256(args.labels.read_bytes()).hexdigest(),'parentSHA256':hashlib.sha256(args.parent.read_bytes()).hexdigest(),
          'seed':args.seed,'device':device,'trainingBooklets':books,'validationBooklets':sorted({r['booklet'] for r in validation}),
          'testBooklets':sorted({r['booklet'] for r in test}),'realTrainingHeads':sum(len(r['arrow_instances']) for r in train),
          'trainableParameters':sum(p.numel() for p in model.parameters() if p.requires_grad),'steps':args.steps,'batch':args.batch,
          'selection':'Maximum directed F1, then location F1, on complete validation crops; threshold tuned on validation only',
          'syntheticFraction':.2,'wholeBookletSplit':True,'geometricFallback':False,'studDetectorFrozen':True,
          'annotationLimitations':json.loads(args.labels.read_text())['limitations']}
    (args.out/'dataset.json').write_text(json.dumps(meta,indent=2));print(json.dumps(meta),flush=True)
    new=list(model.arrow_heat.parameters())+list(model.arrow_offset.parameters());new_ids={id(p) for p in new}
    old=[p for p in model.parameters() if p.requires_grad and id(p) not in new_ids];parameters=new+old
    optimizer=torch.optim.AdamW([{'params':old,'lr':3e-4},{'params':new,'lr':1e-3}],weight_decay=1e-4)
    history=[];best=(-1.,-1.);start=time.time();acc=collections.Counter()
    for step in range(1,args.steps+1):
        model.train();batch=[]
        for _ in range(args.batch):
            if rng.random()<.8:
                if not queue:queue=list(rng.permutation(books))
                book=queue.pop();pool=groups[book];sample=pool[int(rng.integers(len(pool)))];exposure[book]+=1
            else:sample=synthetic[int(rng.integers(len(synthetic)))]
            sample=rotate_sample(sample,int(rng.integers(4)));sample=translated(augment(sample,rng,focus_probability=0),rng);batch.append(sample)
        images=[s['rgb'] for s in batch];outputs=model(tensor_images(images).to(device),raw_tensor_images(images).to(device))
        value,terms=joint_loss(outputs,batch);optimizer.zero_grad();value.backward();torch.nn.utils.clip_grad_norm_(parameters,5);optimizer.step()
        for k,v in terms.items():acc[k]+=float(v.cpu())
        if step%50==0:print(json.dumps({'progressStep':step,'seconds':round(time.time()-start,1)}),flush=True)
        if step%args.every==0 or step==args.steps:
            threshold,metric=choose(model,validation,device,thresholds[0]);thresholds=[thresholds[0],threshold]
            record={'step':step,'seconds':round(time.time()-start,1),'loss':{k:v/min(step,args.every) for k,v in acc.items()},'threshold':threshold,'validation':metric};acc.clear();history.append(record);print(json.dumps(record),flush=True)
            score=(metric['directedF1'],metric['locationF1'])
            if score>best:best=score;save(args.out/'best.pt',model,thresholds,{**meta,'step':step,'validation':metric})
            save(args.out/'latest.pt',model,thresholds,{**meta,'step':step});(args.out/'history.json').write_text(json.dumps(history,indent=2))
    unchanged=all(torch.equal(v,model.detector.state_dict()[k].cpu()) for k,v in frozen.items())
    changes={k:float((model.state_dict()[k].cpu()-v).abs().max()) for k,v in initial_heads.items()}
    assert unchanged and min(exposure.values())>0 and any(v>0 for k,v in changes.items() if k.startswith('arrow_heat')) and any(v>0 for k,v in changes.items() if k.startswith('direction'))
    selected,chosen_thresholds,chosen_meta=load(args.out/'best.pt',device)
    # Test is first evaluated after all checkpoint/threshold selection has finished.
    learned=evaluate(complete_test,predict_maps(selected,complete_test,device),chosen_thresholds,hybrid=False)
    parent,parent_thresholds,_=load_parent(args.parent,device);baseline=evaluate(complete_test,predict_maps(parent,complete_test,device),parent_thresholds,hybrid=False)
    partial=[r for r in test if not r['complete'][1]];partial_result=evaluate(partial,predict_maps(selected,partial,device),chosen_thresholds,hybrid=False)
    by_book={}
    for book in sorted({r['booklet'] for r in complete_test}):
        subset=[r for r in complete_test if r['booklet']==book];by_book[book]=scores(evaluate(subset,predict_maps(selected,subset,device),chosen_thresholds,hybrid=False))
    report={'selectedCheckpoint':chosen_meta,'thresholds':chosen_thresholds,'frozenStudDetectorUnchanged':unchanged,'headMaxWeightChanges':changes,'trainingExposureByBooklet':dict(exposure),
            'completeTest':scores(learned),'baselineCompleteTest':scores(baseline),'partialTestDiagnostic':scores(partial_result),'byBooklet':by_book,
            'testDetails':learned['samples'],'history':history,'automaticPipelineEnabled':False,'fullSetReconstructionValidated':False}
    (args.out/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps({k:report[k] for k in ['completeTest','baselineCompleteTest','frozenStudDetectorUnchanged']},indent=2),flush=True)

if __name__=='__main__':main()
