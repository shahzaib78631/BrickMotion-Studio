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


def available() -> bool:
    return os.environ.get("BOOKLET_SOLVER_NATIVE", "1") != "0" and DYLIB.exists()


def engine() -> NativeEngine | None:
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
