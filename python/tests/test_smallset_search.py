"""A printed step can require a smaller supporting piece before a larger piece."""
import numpy as np
from booklet_mpd.smallset import search
from booklet_mpd.solver.place import Scored


def test_assembly_order_is_searched_instead_of_always_placing_the_largest_first(monkeypatch):
    class Clear:
        def overlaps(self,entry,model):return False
    import booklet_mpd.smallset.collision as collision
    monkeypatch.setattr(collision,'collision_for',lambda lib:Clear())
    def proposed(part,model):
        if part=='top' and not any(p=='support' for p,c,m in model):return []
        m=np.eye(4);m[1,3]=-8 if part=='support' else -32
        return [{'matrix':m,'kind':'stud'}]
    def scored(lib,scene,part,colour,cands,deltas):
        return [Scored(1.,0.,1.,c) for c in cands]
    monkeypatch.setattr(search,'score_candidates',scored)
    monkeypatch.setattr(search,'pose_key',lambda lib,e:(e[0],e[1],*tuple(e[2].ravel())))
    states=search.solve_unordered(None,lambda model:None,[],[('top',1),('support',2)],proposed)
    assert len(states)==1
    assert [p for p,c,m in states[0].placed]==['support','top']
    assert [m[1,3] for p,c,m in states[0].placed]==[-8,-32]


def test_unplaceable_piece_cannot_disappear_from_a_successful_step(monkeypatch):
    class Clear:
        def overlaps(self,entry,model):return False
    import booklet_mpd.smallset.collision as collision
    monkeypatch.setattr(collision,'collision_for',lambda lib:Clear())
    def proposed(part,model):return []
    assert search.solve_unordered(None,lambda model:None,[],[('unsupported',1)],proposed)==[]


def test_round_plate_gets_a_between_four_studs_contact_but_square_slope_does_not():
    from pathlib import Path
    from assembly_model.ldraw import load_library
    lib=load_library(str(Path(__file__).resolve().parents[2]/'public/ldraw'))
    model=[('3941',46,np.eye(4))]
    proposals=search.between_stud_candidates(lib,'6141',model)
    assert any(np.allclose(p['matrix'][:3,3],[0,-8,0]) for p in proposals)
    assert search.between_stud_candidates(lib,'54200',model)==[]


def test_external_equivalence_preserves_connectors_and_rejects_a_real_shape_change():
    from pathlib import Path
    from assembly_model.ldraw import load_library
    from booklet_mpd.smallset.equivalence import externally_equivalent
    lib=load_library(str(Path(__file__).resolve().parents[2]/'public/ldraw'))
    a=np.eye(4);b=np.eye(4);b[:3,:3]=[[0,0,1],[0,1,0],[-1,0,0]]
    assert externally_equivalent(lib,'87081',a,b)
    assert not externally_equivalent(lib,'3039',a,b)
    b[0,3]=1
    assert not externally_equivalent(lib,'87081',a,b)
