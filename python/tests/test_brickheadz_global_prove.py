"""The global prover: optimality, support, and a brute-force cross-check."""
from __future__ import annotations

import itertools
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from brickheadz.global_prove import SCALE, pose_score, solve_step
from brickheadz.pose_domain import Pose


def P(part, x, y, z, *, on_new=1.0, iou=1.0, w=1):
    """A 1×1×1 part on grid (x,y,z); `w` widens the footprint to w studs in x."""
    cells = tuple((x + k, z, y) for k in range(w))
    return Pose(part, x, y, z, tuple(np.eye(3).ravel()), np.eye(4), cells, iou, on_new)


def _foot(p):
    return {(cx, cz) for cx, cz, _cy in p.cells}


def _top(p):
    return max(cy for _cx, _cz, cy in p.cells) + 1


def _valid(poses, pre_tops):
    seen = set()
    for p in poses:
        for c in p.cells:
            if c in seen:
                return False
            seen.add(c)
    for i, p in enumerate(poses):
        if p.y == 0 or any(pre_tops.get(c, 0) == p.y for c in _foot(p)):
            continue
        ok = False
        for j, q in enumerate(poses):
            if i != j and _top(q) == p.y and _foot(q) & _foot(p):
                ok = True
                break
        if not ok:
            return False
    return True


def _brute(cand_lists, pre_tops):
    best = None
    for combo in itertools.product(*[range(len(cl)) for cl in cand_lists]):
        poses = [cand_lists[i][combo[i]] for i in range(len(cand_lists))]
        if not _valid(poses, pre_tops):
            continue
        score = sum(pose_score(p) for p in poses)
        if best is None or score > best:
            best = score
    return best


def test_conflicting_candidates_never_share_a_cell():
    lists = [
        [P("3001", 0, 0, 0, on_new=0.9), P("3001", 5, 0, 0, on_new=0.3)],
        [P("3001", 0, 0, 0, on_new=0.8), P("3001", 6, 0, 0, on_new=0.2)],
    ]
    res = solve_step([("3001", 4), ("3001", 4)], lists, {})
    assert res.status == "optimal"
    assert res.objective == _brute(lists, {})
    chosen = [p.cells[0][:2] for p in res.assignment]
    assert len(set(chosen)) == 2  # not both on cell (0,0)
    assert not res.unique  # .9+.2 and .3+.8 are equally good; both are feasible


def test_duplicate_optimum_is_not_unique():
    lists = [
        [P("3001", 0, 0, 0), P("3001", 5, 0, 0)],
        [P("3001", 0, 0, 1), P("3001", 5, 0, 1)],
    ]
    res = solve_step([("3001", 4), ("3001", 4)], lists, {})
    assert res.status == "optimal"
    assert not res.unique  # several assignments reach the same objective


def test_support_pins_the_height():
    lists = [
        [P("3001", 0, 0, 0, on_new=0.5)],  # grounded base
        [P("3001", 0, 2, 0, on_new=1.0), P("3001", 0, 1, 0, on_new=0.2)],  # high (unsupported) vs on top
    ]
    res = solve_step([("3001", 4), ("3001", 4)], lists, {})
    assert res.status == "optimal"
    assert res.assignment[1].y == 1  # the higher pose cannot float
    assert res.objective == _brute(lists, {})


def test_unsupported_only_is_infeasible():
    lists = [[P("3001", 0, 0, 0)], [P("3001", 0, 3, 0)]]  # part 1 has nothing under it
    res = solve_step([("3001", 4), ("3001", 4)], lists, {})
    assert res.status == "unsat"


def test_brute_force_cross_check_random_instances():
    rng = np.random.default_rng(11)
    for _case in range(12):
        n = int(rng.integers(2, 4))
        lists = []
        for _i in range(n):
            k = int(rng.integers(1, 4))
            cl = []
            for _c in range(k):
                cl.append(P("3001", int(rng.integers(0, 3)), int(rng.integers(0, 2)),
                            int(rng.integers(0, 3)), on_new=float(rng.random()), iou=float(rng.random())))
            lists.append(cl)
        want = _brute(lists, {})
        res = solve_step([("3001", 4)] * n, lists, {}, timeout_ms=20_000)
        if want is None:
            assert res.status == "unsat"
        else:
            assert res.status == "optimal"
            assert res.objective == want


def test_score_scaling():
    assert pose_score(P("3001", 0, 0, 0, on_new=1.0, iou=1.0)) == SCALE
    assert pose_score(P("3001", 0, 0, 0, on_new=0.0, iou=0.0)) == 0


def test_face_contact_excludes_volume_overlap_and_accepts_touching():
    from brickheadz.global_prove import contact
    a=((0,-8,0),(20,0,20))
    assert contact(a,((20,-8,0),(40,0,20)))
    assert not contact(a,((5,-8,0),(25,0,20)))
    assert not contact(a,((23,-8,0),(43,0,20)))


def test_contact_support_does_not_ground_floating_or_buried_parts():
    from brickheadz.global_prove import support_from_aabb
    boxes=[[((0,-24,0),(20,-16,20)),((0,-8,0),(20,0,20)),((0,8,0),(20,16,20))]]
    grounded,_=support_from_aabb(boxes,[])
    assert grounded == [[False,True,False]]


def test_mutual_support_in_midair_is_unsat():
    from brickheadz.global_prove import solve_core
    cells=[[((0,0,3),)],[((1,0,3),)]]
    support=([[False],[False]],[[[(1,0)]],[[(0,0)]]])
    assert solve_core(2,cells,[[100],[100]],support=support).status == 'unsat'


def test_lateral_chain_reaches_grounded_part():
    from brickheadz.global_prove import solve_core
    cells=[[((0,0,3),)],[((1,0,3),)],[((2,0,3),)]]
    support=([[True],[False],[False]],[[[]],[[(0,0),(2,0)]],[[(1,0)]]])
    assert solve_core(3,cells,[[100]]*3,support=support).status == 'optimal'


def test_nonidentical_candidate_tables_are_not_symmetry_broken():
    lists=[[P('3001',0,0,0,on_new=.1),P('3001',1,0,0)],
           [P('3001',2,0,0),P('3001',3,0,0,on_new=.1)]]
    result=solve_step([('3001',4)]*2,lists,{})
    assert result.picks == [1,0]
    assert result.objective == _brute(lists,{})


def test_union_coverage_prefers_explaining_different_pixels():
    from brickheadz.global_prove import solve_core
    cells=[[((0,0,0),)],[((1,0,0),),((2,0,0),)]]
    coverage=[[[10,11]], [[10,11],[12,13]]]
    res=solve_core(2,cells,[[100],[100,99]],coverage=coverage,coverage_weight=10)
    assert res.picks==[0,1] and res.objective==239
    assert res.status=='optimal' and res.unique


def test_contact_does_not_allow_floor_penetration():
    from brickheadz.global_prove import support_from_aabb
    buried=((0,0,0),(20,8,20))
    prior=((20,0,0),(40,8,20))
    grounded,supporters=support_from_aabb([[buried]],[prior])
    assert grounded==[[False]] and supporters==[[[]]]
