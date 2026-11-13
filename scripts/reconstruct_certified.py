"""Certified geometric reconstruction, benchmarked against the Aquaman 41600 OMR.

Runs the whole chain — closed-form camera recovery → segmentation → finite pose
domain → z3 global solve with an optimality proof → independent verification —
against a known model (the OMR), so every number is measured, not assumed:

    cd python && uv run python ../scripts/reconstruct_certified.py [n_steps]

Steps whose pieces are not studs-up (true SNOT, held by side studs rather than a
face stack) are outside this release's support model: they are taken from the OMR
so the build state stays correct and are reported as skipped, not counted. The
exact-reconstruction rate is therefore measured on the studs-up subset, up to a
global translation (the honest metric from GEOMETRIC_SOLVER.md).
"""
from __future__ import annotations

import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python"))

from assembly_model.ldraw import load_library  # noqa: E402
from brickheadz.axonometric import recover_camera  # noqa: E402
from brickheadz.certificate import Certificate, StepCertificate, write_cert, verify  # noqa: E402
from brickheadz.geometric_solver import STUDS_UP_ROTS, heights_update, score_against_truth  # noqa: E402
from brickheadz.global_prove import pose_score, solve_step  # noqa: E402
from brickheadz.instruction_place import cells_of, fit_camera, grid_matrix, render_pieces, world_points  # noqa: E402
from brickheadz.new_segment import segment  # noqa: E402
from brickheadz.parts import info  # noqa: E402
from brickheadz.pose_domain import candidates, grid_pose, silhouette, stack_offsets  # noqa: E402
from brickheadz.reconstruct import steps_from_omr  # noqa: E402
from brickheadz.image_spec import ldconfig_rgb  # noqa: E402

SIZE = 256
LDRAW = os.path.join(os.path.dirname(HERE), "public", "ldraw")
MAX_CANDIDATES = 24


def _is_studs_up(rot) -> bool:
    return any(np.allclose(rot, r) for r in STUDS_UP_ROTS)


def _normalise(lib, truth):
    """Snap an OMR model onto the solver's grid and shift its lowest piece to y=0."""
    parsed = []
    for s in truth:
        row = []
        for p, c, m in s:
            gp = grid_pose(lib, p, m)
            if gp is None:
                return None
            row.append((p, c, gp))
        parsed.append(row)
    tx = -min(gp[0] for s in parsed for _p, _c, gp in s)
    ty = -min(gp[1] for s in parsed for _p, _c, gp in s)
    tz = -min(gp[2] for s in parsed for _p, _c, gp in s)
    out = []
    for s in parsed:
        row = []
        for p, c, (x, y, z, rot) in s:
            x, y, z = x + tx, y + ty, z + tz
            m, _fw, _fd = grid_matrix(lib, p, x, y, z, rot)
            row.append((p, c, m, (x, y, z, rot)))
        out.append(row)
    return out


def main(n_steps: int = 12, out: str = ".cache/aquaman/certified", *, coverage_objective: bool = False, teacher_forced: bool = False) -> None:
    lib = load_library(LDRAW)
    palette = ldconfig_rgb(os.path.join(LDRAW, "LDConfig.ldr"))
    truth = _normalise(lib, steps_from_omr(os.path.join(HERE, "..", ".cache", "aquaman", "omr", "aquaman-assembled.mpd"))[:n_steps])

    all_pts = np.concatenate([world_points(lib, p, m) for s in truth for p, _c, m, _g in s])
    cam0 = fit_camera(all_pts, 30, 25, SIZE)
    u, v, _ = cam0.project(all_pts)
    cam, cam_cert = recover_camera(all_pts, np.stack([u, v], 1))

    built: list = []
    occupied: set = set()
    H: dict = {}
    cert = Certificate(name="aquaman-41600", camera_cert=cam_cert.__dict__, steps=[])
    solved = skipped = hits = attempts = 0
    step_metrics = []
    truth_in_domain = truth_after_cap = 0
    injected_steps = []
    t0 = time.time()

    for si, step in enumerate(truth, 1):
        if teacher_forced:
            # Isolate this step's errors from previous misplacements. This mode
            # is evaluation-only and must never be described as PDF reconstruction.
            built, occupied, H = [], set(), {}
            for prior_step in truth[:si-1]:
                for p,c,m,(x,y,z,rot) in prior_step:
                    built.append((p,c,m))
                    cells=cells_of(lib,p,x,y,z,rot)[1]
                    occupied.update(cells)
                    heights_update(H,cells)
        parts = [(p, c) for p, c, _m, _g in step]
        studs_up = all(_is_studs_up(g[3]) for _p, _c, _m, g in step)
        pre = dict(H)

        if not studs_up:
            skipped += 1
            injected_steps.append(si)
            step_metrics.append({"step":si,"status":"skipped-snot","parts":len(parts),"truthInjected":True})
            for p, c, m, (x, y, z, rot) in step:
                built.append((p, c, m))
                cells = cells_of(lib, p, x, y, z, rot)[1]
                occupied.update(cells)
                heights_update(H, cells)
            print(f"step {si:2d}: {len(parts)} part(s)  skipped (SNOT)  ({time.time()-t0:4.0f}s)")
            continue

        colours = sorted({c for _p, c, _m, _g in step})
        prior_rgb, _pm = render_pieces(lib, [(p, palette.get(c, (150, 150, 150)), m, False) for p, c, m in built], cam, SIZE)
        entries = [(p, palette.get(c, (150, 150, 150)), m, False) for p, c, m in built]
        entries += [(p, palette.get(c, (150, 150, 150)), m, True) for p, c, m, _g in step]
        rgb, _mask = render_pieces(lib, entries, cam, SIZE)
        seg = segment(rgb, palette, colours, prior=prior_rgb)

        hx = stack_offsets(lib, parts)
        cand_lists = [candidates(lib, p, c, seg, cam, SIZE, occupied, H, y_extra=hx, spread=2, min_on_new=0.4)
                      for p, c in parts]
        from brickheadz.parts import body_aabb
        def contains_truth(row, part, matrix):
            lo,hi=body_aabb(lib,part,matrix)
            return any(q.aabb and np.allclose(q.aabb[0],lo,atol=1.5) and
                       np.allclose(q.aabb[1],hi,atol=1.5) for q in row)
        before=[contains_truth(row,p,m) for row,(p,_c,m,_g) in zip(cand_lists,step)]
        cand_lists = [cl[:MAX_CANDIDATES] for cl in cand_lists]
        after=[contains_truth(row,p,m) for row,(p,_c,m,_g) in zip(cand_lists,step)]
        truth_in_domain += sum(before)
        truth_after_cap += sum(after)
        pre_aabbs = [_box(lib, p, m) for p, c, m in built]
        coverage = [[np.flatnonzero(silhouette(lib,p,q.matrix,cam,SIZE) & seg.new_mask & (seg.labels==c)).tolist()
                     for q in row] for (p,c),row in zip(parts,cand_lists)] if coverage_objective else None
        coverage_weight = max(1,round(len(parts)*1_000_000/max(1,int(seg.new_mask.sum()))))
        res = solve_step(parts, cand_lists, pre, pre_aabbs=pre_aabbs, coverage=coverage,
                         coverage_weight=coverage_weight, timeout_ms=20_000)
        solved += 1

        picks = list(res.picks)
        attempted = True
        if res.status == "optimal" and all(p is not None for p in picks):
            for i, (p, c) in enumerate(parts):
                pose = res.assignment[i]
                built.append((p, c, pose.matrix))
                occupied.update(pose.cells)
                heights_update(H, pose.cells)
                attempts += 1
                if _same_pose(lib, p, pose.matrix, step[i][2]):
                    hits += 1
        else:
            attempted = False
            injected_steps.append(si)
            attempts += len(parts)
            for p, c, m, (x, y, z, rot) in step:  # keep the build state correct
                built.append((p, c, m))
                cells = cells_of(lib, p, x, y, z, rot)[1]
                occupied.update(cells)
                heights_update(H, cells)

        step_metrics.append({"step":si,"parts":len(parts),"status":res.status,
                             "unique":res.unique,"truthInjected":not attempted,
                             "trueBodyPoseInDomain":before,"trueBodyPoseAfterCap":after,
                             "candidateCounts":[len(row) for row in cand_lists]})
        from brickheadz.certificate import Candidate

        cert.steps.append(StepCertificate(
            step=si, parts=[{"part": p, "color": c} for p, c in parts],
            candidates=[[Candidate(q.x, q.y, q.z, list(q.R), [list(cc) for cc in q.cells],
                                   pose_score(q), float(q.on_new), float(q.iou),
                                   [list(q.aabb[0]), list(q.aabb[1])] if q.aabb else None,
                                   int(getattr(q, "blob", -1))) for q in cl] for cl in cand_lists],
            pick=picks, objective=res.objective, status=res.status, core=res.core, unique=res.unique,
            pre_tops=pre, pre_aabbs=[[list(lo), list(hi)] for lo, hi in pre_aabbs],
            camera={"yaw": cam.yaw, "pitch": cam.pitch, "scale": cam.scale, "ox": cam.ox, "oy": cam.oy},
            segmentation={"residual": seg.residual, "blobs": len(seg.blobs)},
            coverage=coverage, coverage_weight=coverage_weight,
        ))
        print(f"step {si:2d}: {len(parts)} part(s)  {res.status:8s} cands={sum(len(c) for c in cand_lists):3d} "
              f"gap={res.objective/1e6:.3f} uniq={int(res.unique)}  ({time.time()-t0:4.0f}s)")

    os.makedirs(os.path.join(HERE, "..", out), exist_ok=True)
    path = os.path.join(HERE, "..", out, "aquaman.cert.json")
    write_cert(cert, path)

    print(f"\ncamera certificate: residual={cam_cert.residual:.3g}px ortho={cam_cert.orthonormality:.3g} "
          f"scale={cam.scale:.3f} (yaw {cam.yaw:.1f}, pitch {cam.pitch:.1f}) ok={cam_cert.ok}")
    print(f"steps: {solved} attempted, {skipped} skipped (SNOT)")
    print(f"exact reconstruction (symmetry-invariant, in the solver frame): {hits}/{attempts}")
    if cert.steps:
        report = verify(cert)
        print(f"certificate verified: {report['ok']}  ({sum(s['ok'] for s in report['steps'])}/{len(report['steps'])} steps)")
    summary={"evidence":"synthetic images rendered from known OMR geometry",
             "completeModel":False,"coverageObjective":coverage_objective,"teacherForcedPrior":teacher_forced,
             "attemptedSteps":solved,"skippedSteps":skipped,"exactPieces":hits,"attemptedPieces":attempts,
             "trueBodyPoseInDomain":truth_in_domain,"trueBodyPoseAfterCandidateCap":truth_after_cap,
             "candidateCap":MAX_CANDIDATES,"groundTruthInjectedSteps":injected_steps,
             "seconds":round(time.time()-t0,3),"steps":step_metrics}
    summary_path=os.path.join(os.path.dirname(path),'summary.json')
    with open(summary_path,'w') as target:
        json.dump(summary,target,indent=1)
    print(f"true body pose in domain: {truth_in_domain}/{attempts}; after cap: {truth_after_cap}/{attempts}")
    print(f"wrote {path}")
    print(f"summary: {summary_path}")


def _same_pose(lib, part, m, truth) -> bool:
    """Exact up to the part's symmetry: same world AABB (symmetry-invariant)."""
    a = world_points(lib, part, m)
    b = world_points(lib, part, truth)
    return bool(np.abs(a.min(0) - b.min(0)).max() <= 1.5 and np.abs(a.max(0) - b.max(0)).max() <= 1.5)


def _box(lib, part, m):
    from brickheadz.parts import body_aabb
    return body_aabb(lib, part, m)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('steps',type=int,nargs='?',default=12)
    parser.add_argument('--out',default='.cache/aquaman/certified')
    parser.add_argument('--coverage',action='store_true',help='experimental union-of-image-pixels objective')
    parser.add_argument('--teacher-forced',action='store_true',help='evaluation only: use truth for every prior state to isolate step errors')
    args = parser.parse_args()
    main(args.steps,args.out,coverage_objective=args.coverage,teacher_forced=args.teacher_forced)
