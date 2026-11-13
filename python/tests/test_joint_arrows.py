from pathlib import Path
import numpy as np
import pytest
pytest.importorskip('torch');pytest.importorskip('cv2');pytest.importorskip('scipy')
import torch
from brickheadz.arrow_direction import ArrowDirectionNet
from brickheadz.joint_arrows import JointArrowNet,location_targets,joint_loss,save,load


def row(complete=True):
    return {'rgb':np.full((256,256,3),220,np.uint8),'studs':[],'arrow_tips':[[60.5,80.5]],'complete':[False,complete],
            'arrow_instances':[{'id':'a','tip':[60.5,80.5],'head_base':[60.5,60.5],'direction_reviewed':True,'shaft':None}]}


def test_partial_labels_supervise_known_location_without_inventing_background():
    target,offset,centres,valid=location_targets([row(False)])
    assert centres.sum()==1 and valid.sum()==1
    assert valid[0,0,0,0]==0
    expected=(np.array([30,40])+offset[0,:,40,30].numpy())*2
    assert np.allclose(expected,[60.5,80.5])
    heat=torch.zeros(1,2,128,128,requires_grad=True);offsets=torch.zeros(1,4,128,128,requires_grad=True)
    direction=torch.zeros(1,3,128,128,requires_grad=True)
    value,_=joint_loss((heat,offsets,direction),[row(False)]);value.backward()
    assert heat.grad[0,1,40,30]!=0 and heat.grad[0,1,0,0]==0
    assert heat.grad[0,0].abs().sum()==0


def test_complete_negative_regions_penalize_false_detections():
    s=row();s['arrow_tips']=[];s['arrow_instances']=[]
    heat=torch.zeros(1,2,128,128,requires_grad=True);offset=torch.zeros(1,4,128,128);direction=torch.zeros(1,3,128,128)
    value,_=joint_loss((heat,offset,direction),[s]);value.backward()
    assert heat.grad[0,1,20,20]>0
    assert heat.grad[0,0].abs().sum()==0


def test_location_and_direction_both_train_while_stud_detector_stays_frozen():
    torch.manual_seed(4);parent=ArrowDirectionNet();model=JointArrowNet(parent).train();x=torch.rand(1,3,256,256)
    with torch.no_grad():old_heat,old_offset=parent.detector(x)
    heat,offset,direction=model(x,x)
    assert torch.equal(heat[:,:1],old_heat[:,:1]) and torch.equal(offset[:,:2],old_offset[:,:2])
    value,_=joint_loss((heat,offset,direction),[row()]);value.backward()
    assert model.arrow_heat.weight.grad.abs().sum()>0 and model.direction.weight.grad.abs().sum()>0
    assert all(p.grad is None for p in model.detector.parameters())
    assert not model.detector.training


def test_joint_checkpoint_roundtrip_and_type_guard(tmp_path):
    model=JointArrowNet();p=tmp_path/'joint.pt';save(p,model,[.3,.4],{'jointTraining':True})
    other,thresholds,metadata=load(p)
    assert metadata['jointTraining'] and thresholds==[.3,.4]
    assert all(torch.equal(v,other.state_dict()[k]) for k,v in model.state_dict().items())
    torch.save({'format':'brickmotion-arrow-direction','version':3},p)
    with pytest.raises(ValueError,match='Unsupported'):load(p)


def test_native_tiles_restore_coordinates_and_deduplicate_overlap(monkeypatch):
    import brickheadz.joint_arrows as module
    def maps(_model,samples,_device,batch):
        assert len(samples)==2
        result=[]
        for x,score in [(105,.8),(9,.9)]:
            heat=np.zeros((2,128,128),np.float32);heat[1,50,x]=score
            offset=np.zeros((4,128,128),np.float32)
            field=np.zeros((3,128,128),np.float32);field[1]=1
            result.append((heat,offset,field))
        return result
    monkeypatch.setattr(module,'predict_maps',maps)
    result=module.detect_arrows(None,np.full((256,448,3),255,np.uint8),[.5,.5])
    assert len(result)==1
    assert result[0]['tip']==[210.,100.]
    assert result[0]['headBase']==[210.,84.]
    assert np.allclose(result[0]['direction'],[0,1])
    assert result[0]['score']==pytest.approx(.9)


def test_native_tiles_reject_invalid_parameters():
    from brickheadz.joint_arrows import detect_arrows
    with pytest.raises(ValueError):detect_arrows(None,np.zeros((2,2,3),np.uint8),[.5,.5],overlap=256)
    with pytest.raises(ValueError):detect_arrows(None,np.zeros((0,2,3),np.uint8),[.5,.5])


def test_existing_observer_accepts_joint_checkpoint_and_uses_native_arrows(tmp_path,monkeypatch):
    import brickheadz.booklet_vision as vision
    import brickheadz.joint_arrows as joint
    from brickheadz.arrow_direction import DirectionObserver
    model=JointArrowNet();path=tmp_path/'joint.pt';save(path,model,[.99,.99],{'joint':True})
    rgb=np.full((80,96,3),220,np.uint8)
    monkeypatch.setattr(vision,'observe',lambda image:vision.Observation(image,np.zeros(image.shape[:2],bool),np.empty((0,4)),np.empty((0,2))))
    called=[]
    def native(model,image,thresholds,device):
        called.append(image.shape)
        return [{'tip':[8.,10.],'direction':[1.,0.]}]
    monkeypatch.setattr(joint,'detect_arrows',native)
    observer=DirectionObserver(path);result=observer(rgb)
    assert observer.joint and isinstance(observer.model,JointArrowNet)
    assert called==[(80,96,3)]
    assert result.arrows.tolist()==[[8.,10.]]
    assert result.arrow_directions.tolist()==[[1.,0.]]
