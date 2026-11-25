"""3D LEGO geometry utilities for BrickGen.

Coordinate convention inside BrickGen canonical space:
  - Right-handed, Y-UP (y_up = -y_ldraw), in LDraw units (LDU):
      1 stud horizontally = 20 LDU (X and Z)
      1 plate vertically  =  8 LDU (Y_up)
      1 brick vertically  = 24 LDU (Y_up)
  - Ground plane at y_up = 0 (lowest part bottom sits on y_up = 0).
  - Horizontal center near (x=0, z=0), aligned to the 20-LDU stud grid.
  - Conversion to/from LDraw Y-down coordinates:
      ldraw_to_canonical(M_ldraw): negate row 1 and col 1 of R (so det=+1? Wait: reflection!).
      CAREFUL: Let's keep poses in native LDraw Y-down right-handed SO(3) matrices R (det=+1)
      and store canonical position `pos = (x, y_up, z)` where `y_up = -t_y`!
      That way R is ALWAYS a proper right-handed rotation matrix in SO(3) (det(R) = +1)
      and converting back to a 4x4 LDraw matrix is literally:
          M[:3, :3] = R
          M[:3,  3] = [x, -y_up, z]
      ZERO handedness bugs, ZERO determinant sign flips!
"""
from __future__ import annotations

import heapq
import itertools

import numpy as np

# ---- Exact 24 right-angle rotation group SO(3) (cubic symmetry group) ----


def _build_rot24() -> np.ndarray:
    mats = []
    for perm in itertools.permutations(range(3)):
        for signs in itertools.product((1.0, -1.0), repeat=3):
            r = np.zeros((3, 3), dtype=np.float64)
            for i, (j, sg) in enumerate(zip(perm, signs)):
                r[i, j] = sg
            if np.linalg.det(r) > 0.5:
                mats.append(r)
    # Put identity at index 0, then pure Y-yaw rotations (90, 180, 270) at indices 1, 2, 3
    def _rank(r: np.ndarray):
        if np.allclose(r, np.eye(3)):
            return (0, 0)
        if r[1, 1] > 0.99:
            # Pure yaw about Y
            ang = int(round(np.degrees(np.arctan2(r[0, 2], r[0, 0])))) % 360
            return (1, ang)
        return (2, 0)

    mats.sort(key=_rank)
    return np.stack(mats, axis=0)  # (24, 3, 3)


ROT24: np.ndarray = _build_rot24()  # (24, 3, 3) float64
ROT24_FLAT: np.ndarray = ROT24.reshape(24, 9)

# Exact 4 yaw-90 rotations about LDraw Y axis (indices 0, 1, 2, 3 in ROT24!)
YAW90: np.ndarray = ROT24[:4]  # 0, 90, 180, 270 deg about Y
# Precomputed multiplication table: YAW_MUL[k, r_idx] = nearest_rot24(YAW90[k] @ ROT24[r_idx])
YAW_MUL: np.ndarray = np.zeros((4, 24), dtype=np.int32)
for _k in range(4):
    for _r in range(24):
        _m = YAW90[_k] @ ROT24[_r]
        YAW_MUL[_k, _r] = int(np.argmax(ROT24_FLAT @ _m.reshape(9)))

# Exact X-reflection table in SO(3): R' = S @ R @ S where S = diag(-1, 1, 1) (det(R') = +1!)
MIRROR_X_S: np.ndarray = np.diag([-1.0, 1.0, 1.0])
MIRROR_X_ROT24: np.ndarray = np.zeros(24, dtype=np.int32)
for _r in range(24):
    _m = MIRROR_X_S @ ROT24[_r] @ MIRROR_X_S
    MIRROR_X_ROT24[_r] = int(np.argmax(ROT24_FLAT @ _m.reshape(9)))
MIRROR_X_R6_SIGNS: np.ndarray = np.array([1.0, -1.0, -1.0, -1.0, 1.0, 1.0], dtype=np.float32)


def mirror_matrix_x(mat: np.ndarray, plane_x: float = 0.0) -> np.ndarray:
    """Reflect a 4x4 LDraw pose across X = plane_x while preserving right-handedness (R' = S R S)."""
    out = np.asarray(mat, dtype=np.float64).copy()
    out[:3, :3] = MIRROR_X_S @ out[:3, :3] @ MIRROR_X_S
    out[0, 3] = 2.0 * plane_x - out[0, 3]
    return out


def nearest_rot24(R: np.ndarray) -> np.ndarray | int:
    """Find closest index in [0..23] for one (3, 3) or batch (..., 3, 3) rotation matrix."""
    arr = np.asarray(R, dtype=np.float64)
    if arr.ndim == 2:
        return int(np.argmax(ROT24_FLAT @ arr.reshape(9)))
    orig = arr.shape[:-2]
    dots = arr.reshape(-1, 9) @ ROT24_FLAT.T
    return np.argmax(dots, axis=-1).reshape(orig).astype(np.int32)


def rotmat_to_6d(R: np.ndarray) -> np.ndarray:
    """Continuous 6D rotation representation (first two columns of R, Zhou et al. CVPR 2019).
    Input: (..., 3, 3) -> Output: (..., 6) float32."""
    arr = np.asarray(R, dtype=np.float32)
    return np.concatenate([arr[..., :, 0], arr[..., :, 1]], axis=-1)


def rot6d_to_rotmat(r6: np.ndarray) -> np.ndarray:
    """Recover orthonormal (..., 3, 3) rotation matrix from 6D representation via Gram-Schmidt."""
    arr = np.asarray(r6, dtype=np.float64)
    a1 = arr[..., :3]
    a2 = arr[..., 3:6]
    b1 = a1 / np.maximum(np.linalg.norm(a1, axis=-1, keepdims=True), 1e-8)
    b2 = a2 - np.sum(b1 * a2, axis=-1, keepdims=True) * b1
    b2 = b2 / np.maximum(np.linalg.norm(b2, axis=-1, keepdims=True), 1e-8)
    b3 = np.cross(b1, b2)
    return np.stack([b1, b2, b3], axis=-1)


# ---- Quantization grids for 3D target pose prediction ----
# Relative offset from parent brick center: 4 LDU step (half-plate / 1/5-stud), [-160, +160] -> 81 bins
REL_STEP = 4.0
REL_MAX = 160.0
REL_HALF = int(REL_MAX / REL_STEP)  # 40
REL_BINS = 2 * REL_HALF + 1  # 81

# Absolute X, Z: 10 LDU step (half-stud), [-400, +400] -> 81 bins
ABS_XZ_STEP = 10.0
ABS_XZ_MAX = 400.0
ABS_XZ_HALF = int(ABS_XZ_MAX / ABS_XZ_STEP)  # 40
ABS_XZ_BINS = 2 * ABS_XZ_HALF + 1  # 81

# Absolute Y_up: 4 LDU step (half-plate), [-16, +464] -> 121 bins (handles parts extending slightly below y=0 origin)
ABS_Y_STEP = 4.0
ABS_Y_MIN = -16.0
ABS_Y_MAX = 464.0
ABS_Y_BINS = int((ABS_Y_MAX - ABS_Y_MIN) / ABS_Y_STEP) + 1  # 121


def quantize_rel(dxyz: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """dxyz: (..., 3) in LDU (x, y_up, z) -> integer bin indices in [0, REL_BINS-1]."""
    q = np.clip(np.rint(dxyz / REL_STEP).astype(np.int64) + REL_HALF, 0, REL_BINS - 1)
    return q[..., 0], q[..., 1], q[..., 2]


def quantize_abs(xyz: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """xyz: (..., 3) in LDU (x, y_up, z) -> integer bin indices for (x, y_up, z)."""
    qx = np.clip(np.rint(xyz[..., 0] / ABS_XZ_STEP).astype(np.int64) + ABS_XZ_HALF, 0, ABS_XZ_BINS - 1)
    qy = np.clip(np.rint((xyz[..., 1] - ABS_Y_MIN) / ABS_Y_STEP).astype(np.int64), 0, ABS_Y_BINS - 1)
    qz = np.clip(np.rint(xyz[..., 2] / ABS_XZ_STEP).astype(np.int64) + ABS_XZ_HALF, 0, ABS_XZ_BINS - 1)
    return qx, qy, qz


def dequantize_abs(qx: int, qy: int, qz: int) -> np.ndarray:
    """Convert absolute bin indices back to canonical (x, y_up, z) in LDU."""
    return np.array(
        [
            (qx - ABS_XZ_HALF) * ABS_XZ_STEP,
            qy * ABS_Y_STEP + ABS_Y_MIN,
            (qz - ABS_XZ_HALF) * ABS_XZ_STEP,
        ],
        dtype=np.float64,
    )


def world_bbox_from_local(local_bbox: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    """Transform axis-aligned local bbox [min_x, min_y, min_z, max_x, max_y, max_z] by 4x4 matrix."""
    lo = local_bbox[:3]
    hi = local_bbox[3:6]
    corners = np.array(
        [
            [lo[0], lo[1], lo[2]],
            [hi[0], lo[1], lo[2]],
            [lo[0], hi[1], lo[2]],
            [hi[0], hi[1], lo[2]],
            [lo[0], lo[1], hi[2]],
            [hi[0], lo[1], hi[2]],
            [lo[0], hi[1], hi[2]],
            [hi[0], hi[1], hi[2]],
        ],
        dtype=np.float64,
    )
    w = corners @ matrix[:3, :3].T + matrix[:3, 3]
    return np.concatenate([w.min(0), w.max(0)]).astype(np.float32)


def ldraw_bbox_to_yup(bbox_ldraw: np.ndarray) -> np.ndarray:
    """Convert LDraw Y-down bbox [minx, miny, minz, maxx, maxy, maxz] -> Y-up [minx, min_yup, minz, maxx, max_yup, maxz]."""
    out = np.empty_like(bbox_ldraw)
    out[..., 0] = bbox_ldraw[..., 0]
    out[..., 1] = -bbox_ldraw[..., 4]  # min_yup = -max_y_ldraw (bottom of brick)
    out[..., 2] = bbox_ldraw[..., 2]
    out[..., 3] = bbox_ldraw[..., 3]
    out[..., 4] = -bbox_ldraw[..., 1]  # max_yup = -min_y_ldraw (top of brick)
    out[..., 5] = bbox_ldraw[..., 5]
    return out


def canonicalize_poses(
    matrices: np.ndarray,
    local_bboxes: np.ndarray,
    force_upright: bool = True,
) -> tuple[np.ndarray, np.ndarray]:
    """Put a model into canonical LDraw Y-down right-handed frame:
      1. Upright (if force_upright): pick right-angle rotation maximizing parts with local +Y down.
      2. Longest horizontal axis along Z (0° or 90° yaw) for consistent front-back alignment.
      3. Grounded: lowest world vertex sits at y_ldraw = 0 (y_up = 0).
      4. Centered in X/Z snapped to 20-LDU stud grid (preserves exact stud alignment!).

    Returns (canonical_matrices[N, 4, 4] float64, world_bboxes_ldraw[N, 6] float32).
    """
    n = len(matrices)
    if n == 0:
        return matrices.copy(), np.zeros((0, 6), dtype=np.float32)

    mats = np.asarray(matrices, dtype=np.float64).copy()

    # 1. Upright alignment
    if force_upright:
        best_r = ROT24[0]
        best_score = -1
        for r in ROT24:
            # Count parts whose transformed local +Y aligns with world +Y (LDraw down)
            ry = np.einsum("ij,nj->ni", r, mats[:, :3, 1])  # (N, 3)
            score = int(np.sum(ry[:, 1] > 0.99))
            if score > best_score:
                best_score = score
                best_r = r
        if not np.allclose(best_r, np.eye(3)):
            R4 = np.eye(4)
            R4[:3, :3] = best_r
            mats = R4[None] @ mats

    # Compute world bboxes to find extents
    wb = np.stack([world_bbox_from_local(local_bboxes[i], mats[i]) for i in range(n)], axis=0)

    # 2. Align longest horizontal span along Z (rotate 90° about Y if span_x > span_z + 10)
    span_x = float(wb[:, 3].max() - wb[:, 0].min())
    span_z = float(wb[:, 5].max() - wb[:, 2].min())
    if span_x > span_z + 10.0:
        R90 = np.eye(4)
        R90[:3, :3] = YAW90[1]
        mats = R90[None] @ mats
        wb = np.stack([world_bbox_from_local(local_bboxes[i], mats[i]) for i in range(n)], axis=0)

    # 3 & 4. Ground at y_ldraw = 0 (max_y -> 0) and center X/Z on nearest 20-LDU stud multiple
    cx = 0.5 * (float(wb[:, 0].min()) + float(wb[:, 3].max()))
    cz = 0.5 * (float(wb[:, 2].min()) + float(wb[:, 5].max()))
    shift_x = round(cx / 20.0) * 20.0
    shift_z = round(cz / 20.0) * 20.0
    shift_y = float(wb[:, 4].max())  # max y_ldraw is bottom -> becomes 0

    mats[:, 0, 3] -= shift_x
    mats[:, 1, 3] -= shift_y
    mats[:, 2, 3] -= shift_z

    wb[:, [0, 3]] -= shift_x
    wb[:, [1, 4]] -= shift_y
    wb[:, [2, 5]] -= shift_z
    return mats, wb.astype(np.float32)


def connected_bottom_up_order(
    n: int,
    edges: list[tuple[int, int, float]],
    world_bboxes_yup: np.ndarray,
    positions_yup: np.ndarray,
) -> tuple[list[int], list[int]]:
    """Order the largest connected component in Prim-style Connected Bottom-to-Top Canonical Order.

    Every piece `k >= 1` in the returned order is GUARANTEED to share a real connector edge
    with at least one earlier piece `parent[k] < k`, while growing monotonically upward from
    the ground plane (lowest bottom `y_up`, then `z`, then `x`).

    Args:
        n: total pieces
        edges: list of (u, v, grip_weight) undirected edges
        world_bboxes_yup: (N, 6) [min_x, min_yup, min_z, max_x, max_yup, max_z]
        positions_yup: (N, 3) [x, y_up, z]

    Returns:
        order: list of original piece indices (length <= n)
        parents: list of parent step indices in the new order (-1 for root step 0, else 0..k-1)
    """
    if n == 0:
        return [], []
    adj: list[list[tuple[int, float]]] = [[] for _ in range(n)]
    for u, v, w in edges:
        if 0 <= u < n and 0 <= v < n and u != v:
            adj[u].append((v, float(w)))
            adj[v].append((u, float(w)))

    # Find largest connected component
    seen = [False] * n
    best_comp: list[int] = []
    for s in range(n):
        if seen[s]:
            continue
        comp = []
        stk = [s]
        seen[s] = True
        while stk:
            u = stk.pop()
            comp.append(u)
            for v, _ in adj[u]:
                if not seen[v]:
                    seen[v] = True
                    stk.append(v)
        if len(comp) > len(best_comp):
            best_comp = comp

    if not best_comp:
        return [0], [-1]

    # Pick canonical root: lowest bottom plate layer, closest to center (x=0, z=0), largest footprint
    def _root_key(i: int):
        bot = round(float(world_bboxes_yup[i, 1]) / 8.0)
        area = -float((world_bboxes_yup[i, 3] - world_bboxes_yup[i, 0]) * (world_bboxes_yup[i, 5] - world_bboxes_yup[i, 2]))
        dist2 = float(positions_yup[i, 0] ** 2 + positions_yup[i, 2] ** 2)
        return (bot, round(dist2 / 400.0), area, i)

    root = min(best_comp, key=_root_key)

    # Spatial priority key for frontier nodes: bottom layer (8 LDU plate), then Z (20 LDU stud), then X
    def _node_key(i: int):
        bot = int(round(float(world_bboxes_yup[i, 1]) / 8.0))
        z_s = int(round(float(positions_yup[i, 2]) / 20.0))
        x_s = int(round(float(positions_yup[i, 0]) / 20.0))
        return (bot, z_s, x_s, i)

    placed_pos: dict[int, int] = {}
    order: list[int] = []
    parents: list[int] = []
    # Track best already-placed neighbor (highest grip, then lowest placed index) for each frontier node
    best_parent: dict[int, tuple[float, int]] = {}  # orig_node -> (grip, -placed_step)
    in_heap: set[int] = set()
    heap: list[tuple[int, int, int, int]] = []

    def _place(u: int, par_step: int) -> None:
        step_idx = len(order)
        placed_pos[u] = step_idx
        order.append(u)
        parents.append(par_step)
        for v, w in adj[u]:
            if v in placed_pos:
                continue
            cand = (w, -step_idx)
            prev = best_parent.get(v)
            if prev is None or cand > prev:
                best_parent[v] = cand
            if v not in in_heap:
                in_heap.add(v)
                heapq.heappush(heap, _node_key(v))

    _place(root, -1)
    while heap:
        _, _, _, v = heapq.heappop(heap)
        if v in placed_pos:
            continue
        _, neg_par = best_parent[v]
        _place(v, -neg_par)

    return order, parents


def augment_yaw90_arrays(
    xyz: np.ndarray,
    rot24: np.ndarray,
    rot6d: np.ndarray,
    bbox_yup: np.ndarray,
    k: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Exact 90° * k rotation around Y axis in canonical space (k in {0, 1, 2, 3}).

    In LDraw Y-down: R_new = YAW90[k] @ R_old, t_xz_new = YAW90[k] @ [x, 0, z], y_up unchanged!
    """
    k = k % 4
    if k == 0:
        return xyz, rot24, rot6d, bbox_yup

    R = YAW90[k].astype(np.float32)  # (3, 3), R[1,1] = 1, R[0,1]=R[1,0]=R[1,2]=R[2,1]=0
    # Transform positions (x, y_up, z): since R only mixes X and Z and keeps Y fixed with +1!
    xyz_new = xyz @ R.T

    # Transform rot24 via exact group table
    rot24_new = YAW_MUL[k, rot24]

    # Transform rot6d (columns 0 and 1 of R_old): col_new = R @ col_old
    c0 = rot6d[..., 0:3] @ R.T
    c1 = rot6d[..., 3:6] @ R.T
    rot6d_new = np.concatenate([c0, c1], axis=-1)

    # Transform axis-aligned bbox_yup [minx, miny, minz, maxx, maxy, maxz]:
    # Under 90° Y rotation, corners map exactly to axis-aligned box!
    x0, y0, z0 = bbox_yup[..., 0], bbox_yup[..., 1], bbox_yup[..., 2]
    x1, y1, z1 = bbox_yup[..., 3], bbox_yup[..., 4], bbox_yup[..., 5]
    # Rotate the 4 horizontal corners (x0,z0), (x1,z0), (x0,z1), (x1,z1)
    cx = np.stack([x0, x1, x0, x1], axis=-1)
    cz = np.stack([z0, z0, z1, z1], axis=-1)
    nx = R[0, 0] * cx + R[0, 2] * cz
    nz = R[2, 0] * cx + R[2, 2] * cz
    bbox_new = np.stack(
        [nx.min(-1), y0, nz.min(-1), nx.max(-1), y1, nz.max(-1)],
        axis=-1,
    ).astype(np.float32)
    return xyz_new.astype(np.float32), rot24_new.astype(np.int16), rot6d_new.astype(np.float32), bbox_new


def augment_mirror_x_arrays(
    part_idx: np.ndarray,
    xyz: np.ndarray,
    rot24: np.ndarray,
    rot6d: np.ndarray,
    bbox_yup: np.ndarray,
    mirror_part_table: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Exact left-right reflection across X = 0 in canonical space.

    Maps: x -> -x, R -> S R S (det=+1), bbox [x0, y0, z0, x1, y1, z1] -> [-x1, y0, z0, -x0, y1, z1],
    and swaps chiral L/R part IDs via `mirror_part_table`.
    """
    p_new = mirror_part_table[part_idx] if mirror_part_table is not None else part_idx.copy()
    xyz_new = xyz.astype(np.float32).copy()
    xyz_new[..., 0] = -xyz_new[..., 0]
    rot24_new = MIRROR_X_ROT24[rot24].astype(np.int16)
    rot6d_new = (rot6d.astype(np.float32) * MIRROR_X_R6_SIGNS).astype(np.float32)
    bbox_new = bbox_yup.astype(np.float32).copy()
    x0 = bbox_yup[..., 0].copy()
    x1 = bbox_yup[..., 3].copy()
    bbox_new[..., 0] = -x1
    bbox_new[..., 3] = -x0
    return p_new, xyz_new, rot24_new, rot6d_new, bbox_new
