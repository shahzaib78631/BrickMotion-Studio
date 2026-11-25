"""Python ctypes bridge to BrickMotion's native C++ connector & collision engine (_bmbridge.dylib).

Uses native/core's full ConnectorDb (LDCad Shadow + BrickLink Studio .conn + BrickNet joints +
wheel seats + extra-connectors) and exact triangle-triangle + mate-zone collision world
(bm::collide::World + bm::connect::mate).
"""
from __future__ import annotations

import ctypes
import os
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
DYLIB = Path(__file__).resolve().parent / "_bmbridge.dylib"
KIND_NAMES = ("stud", "clip", "hinge", "technic", "generic")
MAX_CANDS = 16384


class _BmCand(ctypes.Structure):
    _fields_ = [
        ("matrix", ctypes.c_double * 16),
        ("axis", ctypes.c_double * 3),
        ("grip", ctypes.c_double),
        ("host", ctypes.c_int32),
        ("host_conn", ctypes.c_int32),
        ("conn", ctypes.c_int32),
        ("kind", ctypes.c_int32),
        ("bidirectional", ctypes.c_int32),
    ]


class NativeEngine:
    def __init__(self, use_studio: bool = True):
        if not DYLIB.exists():
            raise FileNotFoundError(f"Native bridge not built: {DYLIB}")
        lib = ctypes.CDLL(str(DYLIB))
        lib.bm_ctx_create.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
        lib.bm_ctx_create.restype = ctypes.c_void_p
        lib.bm_ctx_destroy.argtypes = [ctypes.c_void_p]
        lib.bm_ctx_destroy.restype = None
        lib.bm_set_model.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_char_p),
            ctypes.POINTER(ctypes.c_double),
        ]
        lib.bm_set_model.restype = None
        lib.bm_hits.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.POINTER(ctypes.c_double)]
        lib.bm_hits.restype = ctypes.c_int
        lib.bm_mates.argtypes = [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.POINTER(ctypes.c_double),
            ctypes.POINTER(ctypes.c_double),
        ]
        lib.bm_mates.restype = ctypes.c_int
        lib.bm_candidates.argtypes = [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.POINTER(_BmCand),
            ctypes.c_int,
            ctypes.c_int,
        ]
        lib.bm_candidates.restype = ctypes.c_int
        lib.bm_hits_extra.argtypes = [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.POINTER(ctypes.c_double),
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_char_p),
            ctypes.POINTER(ctypes.c_double),
        ]
        lib.bm_hits_extra.restype = ctypes.c_int
        lib.bm_layout_check.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_char_p),
            ctypes.POINTER(ctypes.c_double),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_double),
        ]
        lib.bm_layout_check.restype = None

        self._lib = lib
        ldraw = str(ROOT / "public/ldraw").encode()
        shadow = str(ROOT / "vendor/LDCadShadowLibrary").encode()
        data = str(ROOT / "native/data").encode()
        self._ctx = lib.bm_ctx_create(ldraw, shadow, data, 1 if use_studio else 0)
        if not self._ctx:
            raise RuntimeError("bm_ctx_create failed")
        self._model_key = None
        self._hits_cache: dict = {}
        self._mates_cache: dict = {}
        self._buf = (_BmCand * MAX_CANDS)()

    def close(self) -> None:
        if getattr(self, "_ctx", None):
            self._lib.bm_ctx_destroy(self._ctx)
            self._ctx = None

    def __del__(self):
        self.close()

    def set_model(self, parts: list) -> None:
        key = tuple((p, tuple(np.round(np.asarray(m, float).ravel(), 3))) for p, _c, m in parts)
        if key == self._model_key:
            return
        self._model_key = key
        self._hits_cache.clear()
        self._mates_cache.clear()
        n = len(parts)
        names = (ctypes.c_char_p * n)(*(p.encode() for p, _c, _m in parts))
        if n:
            mats = np.ascontiguousarray(
                np.stack([np.asarray(m, dtype=np.float64).reshape(16) for _p, _c, m in parts]),
                dtype=np.float64,
            )
            mats_ptr = mats.ctypes.data_as(ctypes.POINTER(ctypes.c_double))
        else:
            mats_ptr = ctypes.POINTER(ctypes.c_double)()
        self._lib.bm_set_model(self._ctx, n, names, mats_ptr)

    def hits(self, part: str, matrix: np.ndarray) -> bool:
        m = np.ascontiguousarray(np.asarray(matrix, dtype=np.float64).reshape(16))
        k = (part, tuple(np.round(m, 3)))
        res = self._hits_cache.get(k)
        if res is None:
            res = bool(self._lib.bm_hits(self._ctx, part.encode(), m.ctypes.data_as(ctypes.POINTER(ctypes.c_double))))
            self._hits_cache[k] = res
        return res

    def mates(self, part: str, matrix: np.ndarray) -> tuple[int, float]:
        """Returns (mate_count, total_grip) against the current model."""
        m = np.ascontiguousarray(np.asarray(matrix, dtype=np.float64).reshape(16))
        k = (part, tuple(np.round(m, 3)))
        res = self._mates_cache.get(k)
        if res is None:
            grip = ctypes.c_double(0.0)
            cnt = int(self._lib.bm_mates(
                self._ctx, part.encode(), m.ctypes.data_as(ctypes.POINTER(ctypes.c_double)), ctypes.byref(grip)
            ))
            res = (cnt, float(grip.value))
            self._mates_cache[k] = res
        return res

    def hits_extra(self, part: str, matrix: np.ndarray, extras: list) -> bool:
        """Check collision of (part, matrix) against base (loaded via set_model) + `extras` without rebuilding BVH."""
        if not extras:
            return self.hits(part, matrix)
        m = np.ascontiguousarray(np.asarray(matrix, dtype=np.float64).reshape(16))
        n = len(extras)
        enames = (ctypes.c_char_p * n)(*(p.encode() for p, _c, _m in extras))
        emats = np.ascontiguousarray(
            np.stack([np.asarray(em, dtype=np.float64).reshape(16) for _p, _c, em in extras]),
            dtype=np.float64,
        )
        return bool(self._lib.bm_hits_extra(
            self._ctx, part.encode(), m.ctypes.data_as(ctypes.POINTER(ctypes.c_double)),
            n, enames, emats.ctypes.data_as(ctypes.POINTER(ctypes.c_double)),
        ))

    def layout_check(self, added: list) -> tuple[bool, int, int, float]:
        """Validate `added` on top of base (loaded via set_model) in one C++ call:
        returns (collides, connected_to_base_count, capped_mate_count, total_grip)."""
        n = len(added)
        if not n:
            return (False, 0, 0, 0.0)
        names = (ctypes.c_char_p * n)(*(p.encode() for p, _c, _m in added))
        mats = np.ascontiguousarray(
            np.stack([np.asarray(m, dtype=np.float64).reshape(16) for _p, _c, m in added]),
            dtype=np.float64,
        )
        collides = ctypes.c_int(0)
        connected = ctypes.c_int(0)
        mates = ctypes.c_int(0)
        grip = ctypes.c_double(0.0)
        self._lib.bm_layout_check(
            self._ctx, n, names, mats.ctypes.data_as(ctypes.POINTER(ctypes.c_double)),
            ctypes.byref(collides), ctypes.byref(connected), ctypes.byref(mates), ctypes.byref(grip),
        )
        return (bool(collides.value), int(connected.value), int(mates.value), float(grip.value))

    def candidates(self, part: str, base: list, fine_angles: bool = True) -> list[dict]:
        if not base:
            return []
        self.set_model(base)
        n = self._lib.bm_candidates(self._ctx, part.encode(), self._buf, MAX_CANDS, 1 if fine_angles else 0)
        out = []
        for i in range(n):
            c = self._buf[i]
            mat = np.array(c.matrix, dtype=np.float64).reshape(4, 4)
            axis = np.array(c.axis, dtype=np.float64)
            kind = KIND_NAMES[c.kind] if 0 <= c.kind < len(KIND_NAMES) else "generic"
            entry = {
                "matrix": mat,
                "host": int(c.host),
                "host_conn": int(c.host_conn),
                "conn": int(c.conn),
                "kind": kind,
                "axis": axis,
                "grip": float(c.grip),
            }
            if c.bidirectional:
                entry["bidirectional"] = True
            out.append(entry)
        return out


_ENGINE: NativeEngine | None = None
_TRIED = False
_COLLIDE_ENGINE: NativeEngine | None = None
_COLLIDE_TRIED = False
_RAST_LIB = None
_RAST_TRIED = False


def available() -> bool:
    return os.environ.get("BOOKLET_SOLVER_NATIVE", "1") != "0" and DYLIB.exists()


def _rast_lib():
    global _RAST_LIB, _RAST_TRIED
    if not available():
        return None
    if not _RAST_TRIED:
        _RAST_TRIED = True
        try:
            lib = ctypes.CDLL(str(DYLIB))
            lib.bm_rasterize_tris.argtypes = [
                ctypes.c_int,
                ctypes.POINTER(ctypes.c_double),
                ctypes.POINTER(ctypes.c_int64),
                ctypes.c_int,
                ctypes.c_int,
                ctypes.POINTER(ctypes.c_double),
                ctypes.POINTER(ctypes.c_int64),
            ]
            lib.bm_rasterize_tris.restype = None
            lib.bm_rasterize_edges.argtypes = [
                ctypes.c_int,
                ctypes.POINTER(ctypes.c_double),
                ctypes.POINTER(ctypes.c_double),
                ctypes.c_int,
                ctypes.c_int,
                ctypes.c_double,
                ctypes.c_double,
                ctypes.POINTER(ctypes.c_uint8),
                ctypes.POINTER(ctypes.c_double),
            ]
            lib.bm_rasterize_edges.restype = None
            lib.bm_score_sprites.argtypes = [
                ctypes.c_int, ctypes.c_int,
                ctypes.POINTER(ctypes.c_float),
                ctypes.POINTER(ctypes.c_float),
                ctypes.POINTER(ctypes.c_double),
                ctypes.POINTER(ctypes.c_uint8),
                ctypes.POINTER(ctypes.c_float),
                ctypes.POINTER(ctypes.c_float),
                ctypes.c_float, ctypes.c_float,
                ctypes.c_int, ctypes.c_int,
                ctypes.POINTER(ctypes.c_uint8),
                ctypes.POINTER(ctypes.c_double),
                ctypes.POINTER(ctypes.c_uint8),
                ctypes.c_int,
                ctypes.c_int,
                ctypes.POINTER(ctypes.c_int32),
                ctypes.POINTER(ctypes.c_int32),
                ctypes.POINTER(ctypes.c_double),
                ctypes.POINTER(ctypes.c_double),
                ctypes.POINTER(ctypes.c_double),
                ctypes.POINTER(ctypes.c_double),
                ctypes.POINTER(ctypes.c_int32),
            ]
            lib.bm_score_sprites.restype = None
            _RAST_LIB = lib
        except Exception:
            _RAST_LIB = None
    return _RAST_LIB


def rasterize_tris(tris: np.ndarray, labels: np.ndarray, shape: tuple[int, int],
                   depth_io: np.ndarray | None = None, label_io: np.ndarray | None = None):
    lib = _rast_lib()
    if lib is None:
        return None
    h, w = shape
    if depth_io is None:
        depth_io = np.full((h, w), np.inf, dtype=np.float64)
    if label_io is None:
        label_io = np.full((h, w), -1, dtype=np.int64)
    if len(tris):
        t = np.ascontiguousarray(tris, dtype=np.float64)
        l = np.ascontiguousarray(labels, dtype=np.int64)
        lib.bm_rasterize_tris(
            len(t),
            t.ctypes.data_as(ctypes.POINTER(ctypes.c_double)),
            l.ctypes.data_as(ctypes.POINTER(ctypes.c_int64)),
            h, w,
            depth_io.ctypes.data_as(ctypes.POINTER(ctypes.c_double)),
            label_io.ctypes.data_as(ctypes.POINTER(ctypes.c_int64)),
        )
    return depth_io, label_io


def rasterize_edges(segs_uvd: np.ndarray, depth: np.ndarray, depth_tol: float, spacing: float = 0.7,
                    want_mask: bool = True, want_depth: bool = False):
    lib = _rast_lib()
    if lib is None:
        return None
    h, w = depth.shape
    d_c = np.ascontiguousarray(depth, dtype=np.float64)
    mask_out = np.zeros((h, w), dtype=np.uint8) if want_mask else None
    ed_out = np.full((h, w), np.inf, dtype=np.float64) if want_depth else None
    if len(segs_uvd):
        s = np.ascontiguousarray(segs_uvd, dtype=np.float64)
        lib.bm_rasterize_edges(
            len(s),
            s.ctypes.data_as(ctypes.POINTER(ctypes.c_double)),
            d_c.ctypes.data_as(ctypes.POINTER(ctypes.c_double)),
            h, w,
            float(depth_tol), float(spacing),
            mask_out.ctypes.data_as(ctypes.POINTER(ctypes.c_uint8)) if mask_out is not None else ctypes.POINTER(ctypes.c_uint8)(),
            ed_out.ctypes.data_as(ctypes.POINTER(ctypes.c_double)) if ed_out is not None else ctypes.POINTER(ctypes.c_double)(),
        )
    return (mask_out.astype(bool) if mask_out is not None else None), ed_out


def score_sprites(col_plane: np.ndarray | None, old_score: np.ndarray, cur_depth: np.ndarray,
                  base_edge: np.ndarray, edge_prec_map: np.ndarray, chg_plane: np.ndarray | None,
                  paper_penalty: float, edge_prec_weight: float,
                  sp_mask: np.ndarray, sp_depth: np.ndarray, sp_edge: np.ndarray, sp_total: int,
                  rows0: np.ndarray, cols0: np.ndarray, dds: np.ndarray):
    """Batch-score K placements of one sprite in C++ (~1000x faster than Python)."""
    lib = _rast_lib()
    if lib is None:
        return None
    K = len(rows0)
    H, W = cur_depth.shape
    sh, sw = sp_mask.shape
    out_val = np.empty(K, dtype=np.float64)
    out_col = np.empty(K, dtype=np.float64)
    out_edge = np.empty(K, dtype=np.float64)
    out_changed = np.empty(K, dtype=np.int32)
    if K == 0:
        return out_val, out_col, out_edge, out_changed
    cp = np.ascontiguousarray(col_plane, dtype=np.float32) if col_plane is not None else None
    os_c = np.ascontiguousarray(old_score, dtype=np.float32)
    cd = np.ascontiguousarray(cur_depth, dtype=np.float64)
    be = np.ascontiguousarray(base_edge, dtype=np.uint8)
    ep = np.ascontiguousarray(edge_prec_map, dtype=np.float32)
    ch = np.ascontiguousarray(chg_plane, dtype=np.float32) if chg_plane is not None else None
    sm = np.ascontiguousarray(sp_mask, dtype=np.uint8)
    sd = np.ascontiguousarray(sp_depth, dtype=np.float64)
    se = np.ascontiguousarray(sp_edge, dtype=np.uint8)
    r0 = np.ascontiguousarray(rows0, dtype=np.int32)
    c0 = np.ascontiguousarray(cols0, dtype=np.int32)
    dd = np.ascontiguousarray(dds, dtype=np.float64)
    lib.bm_score_sprites(
        H, W,
        cp.ctypes.data_as(ctypes.POINTER(ctypes.c_float)) if cp is not None else ctypes.POINTER(ctypes.c_float)(),
        os_c.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
        cd.ctypes.data_as(ctypes.POINTER(ctypes.c_double)),
        be.ctypes.data_as(ctypes.POINTER(ctypes.c_uint8)),
        ep.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
        ch.ctypes.data_as(ctypes.POINTER(ctypes.c_float)) if ch is not None else ctypes.POINTER(ctypes.c_float)(),
        ctypes.c_float(paper_penalty), ctypes.c_float(edge_prec_weight),
        sh, sw,
        sm.ctypes.data_as(ctypes.POINTER(ctypes.c_uint8)),
        sd.ctypes.data_as(ctypes.POINTER(ctypes.c_double)),
        se.ctypes.data_as(ctypes.POINTER(ctypes.c_uint8)),
        int(sp_total), int(K),
        r0.ctypes.data_as(ctypes.POINTER(ctypes.c_int32)),
        c0.ctypes.data_as(ctypes.POINTER(ctypes.c_int32)),
        dd.ctypes.data_as(ctypes.POINTER(ctypes.c_double)),
        out_val.ctypes.data_as(ctypes.POINTER(ctypes.c_double)),
        out_col.ctypes.data_as(ctypes.POINTER(ctypes.c_double)),
        out_edge.ctypes.data_as(ctypes.POINTER(ctypes.c_double)),
        out_changed.ctypes.data_as(ctypes.POINTER(ctypes.c_int32)),
    )
    return out_val, out_col, out_edge, out_changed


def engine() -> NativeEngine | None:
    """Native engine for candidate generation (`candidates.py`). Kept strictly separate from
    `collider_engine()` so `candidates(part, extra)` can never overwrite `Collider`'s loaded base BVH."""
    global _ENGINE, _TRIED
    if not available():
        return None
    if not _TRIED:
        _TRIED = True
        try:
            _ENGINE = NativeEngine(use_studio=True)
        except Exception:
            _ENGINE = None
    return _ENGINE


def collider_engine() -> NativeEngine | None:
    """Dedicated native engine for `Collider` (collision & layout-check BVH)."""
    global _COLLIDE_ENGINE, _COLLIDE_TRIED
    if not available():
        return None
    if not _COLLIDE_TRIED:
        _COLLIDE_TRIED = True
        try:
            _COLLIDE_ENGINE = NativeEngine(use_studio=True)
        except Exception:
            _COLLIDE_ENGINE = None
    return _COLLIDE_ENGINE
