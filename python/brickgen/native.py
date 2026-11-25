"""Python ctypes wrapper around BrickGen's native C++ libbmcore bridge (_brickgen_native.dylib)."""
from __future__ import annotations

import ctypes
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DYLIB = Path(__file__).resolve().parent / "_brickgen_native.dylib"
BUILD_SCRIPT = Path(__file__).resolve().parent / "build_native.sh"
KIND_NAMES = ("stud", "clip", "hinge", "technic", "generic")
MAX_CANDS = 8192


class _BgCand(ctypes.Structure):
    _fields_ = [
        ("matrix", ctypes.c_double * 16),
        ("bbox", ctypes.c_double * 6),
        ("grip", ctypes.c_double),
        ("host", ctypes.c_int32),
        ("host_conn", ctypes.c_int32),
        ("conn", ctypes.c_int32),
        ("kind", ctypes.c_int32),
        ("mate_count", ctypes.c_int32),
    ]


class _BgCheck(ctypes.Structure):
    _fields_ = [
        ("pieces", ctypes.c_int32),
        ("overlaps", ctypes.c_int32),
        ("groups", ctypes.c_int32),
        ("largest_group", ctypes.c_int32),
        ("attached", ctypes.c_int32),
        ("stands", ctypes.c_int32),
        ("unsupported", ctypes.c_int32),
        ("tipping", ctypes.c_int32),
        ("margin", ctypes.c_double),
        ("mass", ctypes.c_double),
    ]


class _BgPartInfo(ctypes.Structure):
    _fields_ = [
        ("bbox", ctypes.c_double * 6),
        ("has_mesh", ctypes.c_int32),
        ("num_conns", ctypes.c_int32),
    ]


@dataclass
class CheckResult:
    pieces: int
    overlaps: int
    groups: int
    largest_group: int
    attached: int
    stands: bool
    unsupported: int
    tipping: int
    margin: float
    mass: float

    @property
    def certified(self) -> bool:
        return self.pieces > 0 and self.overlaps == 0 and self.groups == 1 and self.stands


def ensure_built() -> Path:
    if not DYLIB.exists():
        subprocess.run(["bash", str(BUILD_SCRIPT)], check=True)
    return DYLIB


class BrickGenNative:
    """High-speed native C++ LEGO geometry, connector, collision & stability engine."""

    def __init__(self, use_studio: bool = True):
        dylib = ensure_built()
        lib = ctypes.CDLL(str(dylib))

        lib.bg_ctx_create.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
        lib.bg_ctx_create.restype = ctypes.c_void_p
        lib.bg_ctx_destroy.argtypes = [ctypes.c_void_p]
        lib.bg_ctx_destroy.restype = None

        lib.bg_part_info.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.POINTER(_BgPartInfo)]
        lib.bg_part_info.restype = ctypes.c_int

        lib.bg_world_reset.argtypes = [ctypes.c_void_p]
        lib.bg_world_reset.restype = None
        lib.bg_world_add.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.POINTER(ctypes.c_double)]
        lib.bg_world_add.restype = ctypes.c_int
        lib.bg_world_pop.argtypes = [ctypes.c_void_p]
        lib.bg_world_pop.restype = ctypes.c_int
        lib.bg_world_size.argtypes = [ctypes.c_void_p]
        lib.bg_world_size.restype = ctypes.c_int
        lib.bg_world_hits.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.POINTER(ctypes.c_double)]
        lib.bg_world_hits.restype = ctypes.c_int

        lib.bg_world_candidates.argtypes = [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.POINTER(ctypes.c_int32),
            ctypes.c_int,
            ctypes.POINTER(_BgCand),
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
        ]
        lib.bg_world_candidates.restype = ctypes.c_int

        lib.bg_world_check.argtypes = [ctypes.c_void_p, ctypes.POINTER(_BgCheck)]
        lib.bg_world_check.restype = ctypes.c_int

        lib.bg_load_model_json.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_int]
        lib.bg_load_model_json.restype = ctypes.c_char_p

        self._lib = lib
        ldraw = str(ROOT / "public/ldraw").encode()
        shadow = str(ROOT / "vendor/LDCadShadowLibrary").encode()
        data = str(ROOT / "native/data").encode()
        self._ctx = lib.bg_ctx_create(ldraw, shadow, data, 1 if use_studio else 0)
        if not self._ctx:
            raise RuntimeError("bg_ctx_create failed")
        self._buf = (_BgCand * MAX_CANDS)()
        self._part_cache: dict[str, tuple[np.ndarray, bool, int]] = {}

    def close(self) -> None:
        if getattr(self, "_ctx", None):
            self._lib.bg_ctx_destroy(self._ctx)
            self._ctx = None

    def __del__(self):
        self.close()

    def part_info(self, part: str) -> tuple[np.ndarray, bool, int]:
        """Returns (local_bbox[6], has_mesh, num_conns) in LDraw LDU."""
        res = self._part_cache.get(part)
        if res is not None:
            return res
        info = _BgPartInfo()
        self._lib.bg_part_info(self._ctx, part.encode(), ctypes.byref(info))
        out = (np.array(info.bbox, dtype=np.float32), bool(info.has_mesh), int(info.num_conns))
        self._part_cache[part] = out
        return out

    def load_model(self, path: str | Path, check_overlaps: bool = False, check_stability: bool = False) -> dict:
        raw = self._lib.bg_load_model_json(
            self._ctx, str(path).encode(), 1 if check_overlaps else 0, 1 if check_stability else 0
        )
        if not raw:
            return {"ok": False, "error": "null response"}
        return json.loads(raw.decode("utf-8"))

    # ---- Incremental GenWorld API ----

    def reset(self) -> None:
        self._lib.bg_world_reset(self._ctx)

    def add(self, part: str, color: int, matrix: np.ndarray) -> int:
        m = np.ascontiguousarray(np.asarray(matrix, dtype=np.float64).reshape(16))
        return int(self._lib.bg_world_add(self._ctx, part.encode(), int(color), m.ctypes.data_as(ctypes.POINTER(ctypes.c_double))))

    def pop(self) -> bool:
        return bool(self._lib.bg_world_pop(self._ctx))

    def size(self) -> int:
        return int(self._lib.bg_world_size(self._ctx))

    def hits(self, part: str, matrix: np.ndarray) -> bool:
        m = np.ascontiguousarray(np.asarray(matrix, dtype=np.float64).reshape(16))
        return bool(self._lib.bg_world_hits(self._ctx, part.encode(), m.ctypes.data_as(ctypes.POINTER(ctypes.c_double))))

    def candidates(
        self,
        part: str,
        hosts: list[int] | np.ndarray | None = None,
        max_out: int = 2048,
        fine_angles: bool = False,
        filter_collisions: bool = True,
    ) -> dict[str, np.ndarray]:
        """Enumerate exact mated (and optionally collision-free) poses for `part`.

        Returns vectorized numpy arrays for fast scoring:
          matrices: (M, 4, 4) float64
          bboxes:   (M, 6) float32  [min_x, min_y, min_z, max_x, max_y, max_z] in LDraw LDU
          hosts:    (M,) int32
          kinds:    (M,) int32
          grips:    (M,) float32
          mates:    (M,) int32
        """
        cap = min(max_out, MAX_CANDS)
        if hosts is not None and len(hosts) > 0:
            h_arr = np.ascontiguousarray(np.asarray(hosts, dtype=np.int32))
            h_ptr = h_arr.ctypes.data_as(ctypes.POINTER(ctypes.c_int32))
            n_h = len(h_arr)
        else:
            h_ptr = ctypes.POINTER(ctypes.c_int32)()
            n_h = 0

        n = int(
            self._lib.bg_world_candidates(
                self._ctx,
                part.encode(),
                h_ptr,
                n_h,
                self._buf,
                cap,
                1 if fine_angles else 0,
                1 if filter_collisions else 0,
            )
        )
        if n == 0:
            return {
                "matrices": np.zeros((0, 4, 4), dtype=np.float64),
                "bboxes": np.zeros((0, 6), dtype=np.float32),
                "hosts": np.zeros((0,), dtype=np.int32),
                "kinds": np.zeros((0,), dtype=np.int32),
                "grips": np.zeros((0,), dtype=np.float32),
                "mates": np.zeros((0,), dtype=np.int32),
            }
        # Bulk view directly into ctypes struct array
        mats = np.empty((n, 4, 4), dtype=np.float64)
        bboxes = np.empty((n, 6), dtype=np.float32)
        h_out = np.empty(n, dtype=np.int32)
        k_out = np.empty(n, dtype=np.int32)
        g_out = np.empty(n, dtype=np.float32)
        m_out = np.empty(n, dtype=np.int32)
        buf = self._buf
        for i in range(n):
            c = buf[i]
            mats[i] = np.frombuffer(c.matrix, dtype=np.float64).reshape(4, 4)
            bboxes[i] = np.frombuffer(c.bbox, dtype=np.float64)
            h_out[i] = c.host
            k_out[i] = c.kind
            g_out[i] = c.grip
            m_out[i] = c.mate_count
        return {
            "matrices": mats,
            "bboxes": bboxes,
            "hosts": h_out,
            "kinds": k_out,
            "grips": g_out,
            "mates": m_out,
        }

    def check(self) -> CheckResult:
        chk = _BgCheck()
        self._lib.bg_world_check(self._ctx, ctypes.byref(chk))
        return CheckResult(
            pieces=int(chk.pieces),
            overlaps=int(chk.overlaps),
            groups=int(chk.groups),
            largest_group=int(chk.largest_group),
            attached=int(chk.attached),
            stands=bool(chk.stands),
            unsupported=int(chk.unsupported),
            tipping=int(chk.tipping),
            margin=float(chk.margin),
            mass=float(chk.mass),
        )
