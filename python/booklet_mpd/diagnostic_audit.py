"""Independent, evaluation-only checks; never import answer keys into inference.

Kept separate from the active solver so diagnostics cannot change its outputs.
"""
from __future__ import annotations
import numpy as np
from .score import exact_flags
from .solver.evaluate import canonical
from .viewfit import ORIENTATIONS


def seed_frame_transforms(lib, predicted_seed, expected_seed):
    """Enumerate cube turns that preserve the anchor's actual geometry.

    A square plate can anchor several physically equivalent frames. Inferring
    only expected_matrix @ inverse(predicted_matrix) misses those alternatives.
    """
    predicted_seed=canonical(lib,[predicted_seed],[expected_seed])[0]
    p,c,m=predicted_seed;tp,tc,tm=expected_seed
    if p!=tp or c!=tc:return []
    out=[]
    for symmetry in ORIENTATIONS:
        transform=np.eye(4)
        transform[:3,:3]=tm[:3,:3]@symmetry@np.linalg.inv(m[:3,:3])
        transform[:3,3]=tm[:3,3]-transform[:3,:3]@m[:3,3]
        if exact_flags(lib,[(p,c,transform@m)],[expected_seed])[0]:out.append(transform)
    return out


def transform_parts(parts, transform):
    return [(p.removesuffix('.dat'),c,transform@np.asarray(m)) for p,c,m in parts]


def completion_evidence(rows, threshold=.35):
    """Source-only structural omissions, separate from unverified pose accuracy.

    This is an audit, not a claim that passing the checks proves correctness.
    Repeat handling follows the current pipeline contract: only one copy placed.
    """
    issues=[]
    for ordinal,row in enumerate(rows,1):
        reasons=[]
        if row.get('unresolved',0)>0:reasons.append('unresolved-parts')
        if row.get('repeat',1)>1:reasons.append('unsupported-repeat')
        if row.get('status')!='ok':reasons.append('non-ok-status')
        read=row.get('read',0);placed=row.get('placed',0)
        if read>placed:reasons.append('missing-placements')
        if read and (not np.isfinite(row.get('fit_iou',float('nan'))) or row.get('fit_iou',0)<threshold):reasons.append('low-or-missing-fit')
        if not read:reasons.append('no-parts-read')
        if reasons:issues.append({'ordinal':ordinal,'printedStep':row.get('number'),'page':row.get('page'),'reasons':reasons})
    return {'structurallyIncompleteFrom':issues[0]['ordinal'] if issues else None,'issues':issues,
            'poseCorrectness':'not-established','caveat':'A high fit value is not proof of placement correctness. The current solver reports a pre-placement silhouette fit.'}
