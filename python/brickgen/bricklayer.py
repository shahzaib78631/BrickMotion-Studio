"""BrickLayer-Studio: Ergonomic Hierarchical LEGO Assembly SDK backed by Native C++ libbmcore & Metal bmshot.

Inspired by BrickWright / BrickLayer (Pun et al., Oct 2026) and BrickBench (Kulits et al., Oct 2026),
but powered directly by BrickMotion Studio's millisecond C++ geometry/connector/collision/stability
engine (`libbmcore`) and photorealistic Metal renderer (`bmshot`).

Coordinate Convention (Human-Friendly Y-Up Stud/Plate Frame):
  - x, z in STUDS   (1 stud  = 20 LDU; X = right, Z = front/forward)
  - y    in PLATES  (1 plate =  8 LDU; 1 brick = 3 plates = 24 LDU; y = 0 is the ground plane!)
  - `ground="bottom"` (default): automatically places the part's exact rotated bottom at `y` plates,
    eliminating LDraw Y-down origin quirks (e.g. bricks with origin at top studs vs center).
  - `place_sym(...)`: automatically mirrors across X = 0 using verified chiral L/R part pairs + `R' = S R S`.
  - `snap(...)`: queries `libbmcore` for exact typed connector mating (studs, axles, pins, wheel hubs, clips).
  - `validate()` & `render_sheet()`: hard C++ physical certification + 4-view Metal sheet (+ optional ref image comparison).
"""
from __future__ import annotations

import json
import math
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from .geometry import (
    ROT24,
    ldraw_bbox_to_yup,
    mirror_matrix_x,
    nearest_rot24,
    world_bbox_from_local,
)
from .native import ROOT, BrickGenNative, CheckResult

BMSHOT = ROOT / "native/build/render/bmshot"
CATALOG_PATH = ROOT / "public/data/catalog.json"
PART_FUNCS_PATH = ROOT / "public/data/part-functions.json"
LDCONFIG_PATH = ROOT / "public/ldraw/LDConfig.ldr"

# Standard LDraw color shortcuts for readable human/agent scripts
COLORS: dict[str, int] = {
    "black": 0,
    "blue": 1,
    "green": 2,
    "dark_turquoise": 3,
    "red": 4,
    "dark_pink": 5,
    "brown": 6,
    "light_gray": 7,
    "dark_gray": 8,
    "light_blue": 9,
    "bright_green": 10,
    "yellow": 14,
    "white": 15,
    "gray": 16,
    "tan": 19,
    "purple": 22,
    "orange": 25,
    "magenta": 26,
    "lime": 27,
    "dark_tan": 28,
    "trans_dark_blue": 33,
    "trans_green": 34,
    "trans_red": 36,
    "trans_black": 40,
    "trans_light_blue": 41,
    "trans_neon_green": 42,
    "trans_yellow": 46,
    "trans_clear": 47,
    "clear": 47,
    "trans_orange": 57,
    "reddish_brown": 70,
    "light_bluish_gray": 71,
    "lbg": 71,
    "dark_bluish_gray": 72,
    "dbg": 72,
    "medium_blue": 73,
    "medium_nougat": 84,
    "dark_purple": 85,
    "flat_silver": 179,
    "silver": 179,
    "pearl_dark_gray": 148,
    "bright_light_orange": 191,
    "dark_blue": 272,
    "dark_green": 288,
    "pearl_gold": 297,
    "gold": 297,
    "dark_brown": 308,
    "dark_red": 320,
    "dark_azure": 321,
    "medium_azure": 322,
    "olive_green": 330,
    "sand_green": 378,
    "sand_blue": 379,
    "dark_orange": 484,
    "nougat": 92,
    "light_nougat": 78,
}


def resolve_color(color: int | str) -> int:
    if isinstance(color, int):
        return color
    key = color.strip().lower().replace(" ", "_").replace("-", "_")
    if key in COLORS:
        return COLORS[key]
    raise ValueError(f"Unknown color '{color}'. Use an LDraw code or one of: {sorted(COLORS.keys())[:20]}...")


def rot_y(deg: float) -> np.ndarray:
    """Right-handed rotation about Y axis (compatible with LDraw matrix R)."""
    rad = math.radians(deg)
    c, s = math.cos(rad), math.sin(rad)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]], dtype=np.float64)


def rot_x(deg: float) -> np.ndarray:
    rad = math.radians(deg)
    c, s = math.cos(rad), math.sin(rad)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]], dtype=np.float64)


def rot_z(deg: float) -> np.ndarray:
    rad = math.radians(deg)
    c, s = math.cos(rad), math.sin(rad)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)


def make_rotation(yaw: float = 0.0, pitch: float = 0.0, roll: float = 0.0, studs_dir: str | None = None) -> np.ndarray:
    """Build an exact 3x3 right-handed LDraw rotation matrix.

    Args:
        yaw:       rotation about Y axis in degrees (0, 90, 180, 270)
        pitch:     rotation about X axis in degrees (e.g. +90 tilts top studs toward -Z/+Z)
        roll:      rotation about Z axis in degrees (e.g. +90 tilts top studs toward +X/-X)
        studs_dir: ergonomic SNOT shorthand: 'up', 'down', '+z' (front), '-z' (back), '+x' (right), '-x' (left).
                   In LDraw, a part's top studs point along local -Y (world Y-up).
    """
    if studs_dir is not None:
        sd = studs_dir.strip().lower()
        # Local top-stud vector in LDraw is (0, -1, 0). Map it to desired world direction:
        if sd in ("up", "+y"):
            R = rot_y(yaw)
        elif sd in ("down", "-y"):
            R = rot_y(yaw) @ rot_x(180.0)
        elif sd in ("+z", "front"):
            # rot_x(-90) maps (0,-1,0) -> (0,0,+1)
            R = rot_x(-90.0) @ rot_y(yaw)
        elif sd in ("-z", "back"):
            # rot_x(+90) maps (0,-1,0) -> (0,0,-1)
            R = rot_x(90.0) @ rot_y(yaw)
        elif sd in ("+x", "right"):
            # rot_z(+90) maps (0,-1,0) -> (+1,0,0)
            R = rot_z(90.0) @ rot_y(yaw)
        elif sd in ("-x", "left"):
            # rot_z(-90) maps (0,-1,0) -> (-1,0,0)
            R = rot_z(-90.0) @ rot_y(yaw)
        else:
            raise ValueError(f"Unknown studs_dir='{studs_dir}'. Use up/down/+z/-z/+x/-x.")
    else:
        R = rot_y(yaw) @ rot_x(pitch) @ rot_z(roll)
    # Snap near-0/±1 entries cleanly so LDraw files stay crisp
    R = np.where(np.abs(R) < 1e-10, 0.0, R)
    R = np.where(np.abs(R - 1.0) < 1e-10, 1.0, R)
    R = np.where(np.abs(R + 1.0) < 1e-10, -1.0, R)
    return R


def _load_catalog_and_mirrors() -> tuple[list[dict], dict[str, dict], dict[str, str]]:
    cat_list: list[dict] = []
    cat_by_id: dict[str, dict] = {}
    mirror_map: dict[str, str] = {}
    if CATALOG_PATH.exists():
        cat_list = json.loads(CATALOG_PATH.read_text())
        by_norm: dict[str, dict[str, str]] = {}
        for item in cat_list:
            pid = str(item.get("id", "")).lower()
            if not pid:
                continue
            cat_by_id[pid] = item
            nl = str(item.get("name", "")).lower()
            if " left" in nl or " right" in nl:
                key = re.sub(r"\b(left|right)\b", "<SIDE>", nl)
                side = "L" if " left" in nl else "R"
                by_norm.setdefault(key, {})[side] = pid
        for pair in by_norm.values():
            if "L" in pair and "R" in pair:
                mirror_map[pair["L"]] = pair["R"]
                mirror_map[pair["R"]] = pair["L"]
    for a, b in [
        ("24299", "24307"), ("43723", "43722"), ("43723a", "43722a"),
        ("41770", "41769"), ("41770a", "41769a"), ("54384", "54383"),
        ("48208", "48205"), ("47397", "47398"), ("5091", "5092"),
        ("30355", "30356"), ("43710", "43711"), ("41748", "41747"),
        ("41764", "41765"), ("6564", "6565"), ("29119", "29120"),
    ]:
        mirror_map.setdefault(a, b)
        mirror_map.setdefault(b, a)
    return cat_list, cat_by_id, mirror_map


@dataclass
class BrickEntry:
    idx: int
    part: str
    color: int
    matrix: np.ndarray
    bbox_yup: np.ndarray
    tag: str
    step_name: str


@dataclass
class ValidationReport:
    check: CheckResult
    span_studs: tuple[float, float, float]  # (width_x_studs, height_plates, depth_z_studs)
    symmetry_score: float
    palette: dict[int, int]
    step_counts: dict[str, int]
    issues: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.check.certified and not self.issues

    def summary(self) -> str:
        c = self.check
        wx, hp, dz = self.span_studs
        status = "CERTIFIED" if c.certified else "NEEDS_FIX"
        lines = [
            f"[{status}] pieces={c.pieces} | overlaps={c.overlaps} | groups={c.groups} (largest={c.largest_group}) | "
            f"stands={c.stands} (margin={c.margin:.1f} LDU, mass={c.mass:.1f}g)",
            f"  size: {wx:.1f} studs wide (X) x {hp:.1f} plates tall ({hp/3:.1f} bricks Y) x {dz:.1f} studs long (Z) | "
            f"bilateral_sym={self.symmetry_score*100:.0f}%",
        ]
        if self.issues:
            lines.append("  issues: " + "; ".join(self.issues))
        return "\n".join(lines)


class BrickBuild:
    """Interactive, physically-verified hierarchical LEGO MOC builder backed by C++ libbmcore."""

    def __init__(self, title: str = "BrickLayer MOC", prompt: str = "", use_studio: bool = True):
        self.title = title
        self.prompt = prompt
        self.native = BrickGenNative(use_studio=use_studio)
        self.native.reset()
        self._cat_list, self._cat_by_id, self.mirror_map = _load_catalog_and_mirrors()
        self.bricks: list[BrickEntry] = []
        self._tags: dict[str, list[int]] = {}
        self._current_step: str = "base"

    def close(self) -> None:
        self.native.close()

    def __enter__(self) -> "BrickBuild":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    # ---- Catalog & Part Geometry Inspection ----

    def part_dims(self, part: str) -> dict:
        """Return exact native dimensions of `part` in LDU and studs/plates, plus connector count."""
        stem = part.strip().lower().removesuffix(".dat")
        bb, has_mesh, n_conns = self.native.part_info(stem)
        span = bb[3:6] - bb[0:3]
        cat = self._cat_by_id.get(stem, {})
        return {
            "id": stem,
            "name": cat.get("name", ""),
            "category": cat.get("category", ""),
            "has_mesh": has_mesh,
            "conns": n_conns,
            "studs_x": round(float(span[0]) / 20.0, 2),
            "plates_y": round(float(span[1]) / 8.0, 2),
            "studs_z": round(float(span[2]) / 20.0, 2),
            "local_bbox_ldraw": [round(float(v), 2) for v in bb.tolist()],
        }

    def search_parts(self, query: str, category: str | None = None, limit: int = 15) -> list[dict]:
        """Search 30k LDraw catalog entries, returning only verified mesh+connector parts with exact dimensions."""
        tokens = [t for t in re.split(r"[\s,/]+", query.lower().strip()) if t]
        cat_q = category.lower().strip() if category else None
        hits: list[dict] = []
        for item in self._cat_list:
            pid = str(item.get("id", "")).lower()
            if pid.startswith("_") or "p" in pid[3:]:  # prefer clean base molds over printed variants
                continue
            name = str(item.get("name", ""))
            cat_s = str(item.get("category", ""))
            hay = f"{pid} {name} {cat_s}".lower()
            if cat_q and cat_q not in cat_s.lower():
                continue
            if not all(t in hay for t in tokens):
                continue
            info = self.part_dims(pid)
            if info["has_mesh"] and info["conns"] > 0:
                hits.append(info)
                if len(hits) >= limit:
                    break
        return hits

    # ---- Step & Checkpoint Management (Anti-Mirage Rollback!) ----

    def step(self, name: str) -> None:
        """Start a named sub-assembly / build step (emits `0 STEP` in exported LDraw)."""
        self._current_step = name

    def checkpoint(self) -> int:
        """Return current piece count so `rollback(ckpt)` can undo any failed sub-assembly."""
        return len(self.bricks)

    def rollback(self, count: int) -> None:
        """Roll back the native C++ world and brick list to a previous checkpoint."""
        while len(self.bricks) > count:
            self.pop()

    def pop(self) -> BrickEntry | None:
        if not self.bricks:
            return None
        self.native.pop()
        ent = self.bricks.pop()
        if ent.tag in self._tags and ent.idx in self._tags[ent.tag]:
            self._tags[ent.tag].remove(ent.idx)
        return ent

    # ---- Ergonomic Placement & Snapping Primitives ----

    def _commit(self, stem: str, col_id: int, mat: np.ndarray, tag: str, check_collision: bool) -> BrickEntry:
        bb_loc, has_mesh, _ = self.native.part_info(stem)
        if not has_mesh:
            raise ValueError(f"Part '{stem}' has no mesh in local LDraw/Studio library.")
        if check_collision and self.native.hits(stem, mat):
            wb_ld = world_bbox_from_local(bb_loc, mat)
            wb_yup = ldraw_bbox_to_yup(wb_ld)
            # Identify overlapping existing bricks by bbox proximity for crisp error reporting
            near = []
            for b in self.bricks:
                if (
                    b.bbox_yup[0] < wb_yup[3] - 0.5 and b.bbox_yup[3] > wb_yup[0] + 0.5
                    and b.bbox_yup[1] < wb_yup[4] - 0.5 and b.bbox_yup[4] > wb_yup[1] + 0.5
                    and b.bbox_yup[2] < wb_yup[5] - 0.5 and b.bbox_yup[5] > wb_yup[2] + 0.5
                ):
                    near.append(f"#{b.idx}:{b.part}({b.tag})")
            raise ValueError(
                f"Collision placing '{stem}' (tag='{tag}') at y_up=[{wb_yup[1]/8:.2f}..{wb_yup[4]/8:.2f}p] "
                f"x=[{wb_yup[0]/20:.2f}..{wb_yup[3]/20:.2f}s] z=[{wb_yup[2]/20:.2f}..{wb_yup[5]/20:.2f}s]; "
                f"overlaps near: {', '.join(near[:5]) or 'mesh contact'}"
            )
        idx = self.native.add(stem, col_id, mat)
        wb_ld = world_bbox_from_local(bb_loc, mat)
        wb_yup = ldraw_bbox_to_yup(wb_ld)
        ent = BrickEntry(
            idx=idx,
            part=stem,
            color=col_id,
            matrix=mat.copy(),
            bbox_yup=wb_yup,
            tag=tag,
            step_name=self._current_step,
        )
        self.bricks.append(ent)
        if tag:
            self._tags.setdefault(tag, []).append(idx)
        return ent

    def place(
        self,
        part: str,
        color: int | str,
        x: float = 0.0,
        y: float = 0.0,
        z: float = 0.0,
        yaw: float = 0.0,
        pitch: float = 0.0,
        roll: float = 0.0,
        studs_dir: str | None = None,
        ground: str = "bottom",  # "bottom" | "top" | "center" | "origin"
        center_xz: bool = True,
        tag: str = "",
        check_collision: bool = True,
    ) -> BrickEntry:
        """Place one part in intuitive stud (X, Z) / plate (Y_up) coordinates with exact libbmcore collision checking.

        When `ground="bottom"` (default), the part's rotated lowest bottom sits EXACTLY at `y` plates (y*8 LDU).
        When `center_xz=True` (default), the part's rotated horizontal X/Z center sits EXACTLY at `(x, z)` studs.
        """
        stem = part.strip().lower().removesuffix(".dat")
        col_id = resolve_color(color)
        bb_loc, has_mesh, _ = self.native.part_info(stem)
        if not has_mesh:
            raise ValueError(f"Part '{stem}' not found in local LDraw library.")

        R = make_rotation(yaw=yaw, pitch=pitch, roll=roll, studs_dir=studs_dir)
        mat = np.eye(4, dtype=np.float64)
        mat[:3, :3] = R

        # Compute rotated local bbox at origin to align bottom/top/center cleanly onto the 10-LDU half-stud grid
        # (snapping X/Z center offset to 10 LDU prevents 4-LDU side studs on SNOT bricks like 22885/87087 from shifting off-grid!)
        rb_ld = world_bbox_from_local(bb_loc, mat)
        tx = x * 20.0
        tz = z * 20.0
        if center_xz:
            cx_off = round((0.5 * float(rb_ld[0] + rb_ld[3])) / 10.0) * 10.0
            cz_off = round((0.5 * float(rb_ld[2] + rb_ld[5])) / 10.0) * 10.0
            tx -= cx_off
            tz -= cz_off

        if ground == "bottom":
            # In LDraw Y-down, bottom is max_y = rb_ld[4]; we want bottom_ldraw = -y*8 -> ty = -y*8 - rb_ld[4]
            ty = -y * 8.0 - float(rb_ld[4])
        elif ground == "top":
            # Top is min_y = rb_ld[1]; we want top_ldraw = -y*8 -> ty = -y*8 - rb_ld[1]
            ty = -y * 8.0 - float(rb_ld[1])
        elif ground == "center":
            ty = -y * 8.0 - 0.5 * float(rb_ld[1] + rb_ld[4])
        elif ground == "origin":
            ty = -y * 8.0
        else:
            raise ValueError(f"Invalid ground='{ground}'. Use bottom/top/center/origin.")

        mat[:3, 3] = [tx, ty, tz]
        return self._commit(stem, col_id, mat, tag=tag or self._current_step, check_collision=check_collision)

    def place_sym(
        self,
        part: str,
        color: int | str,
        x: float,
        y: float,
        z: float,
        yaw: float = 0.0,
        pitch: float = 0.0,
        roll: float = 0.0,
        studs_dir: str | None = None,
        ground: str = "bottom",
        center_xz: bool = True,
        tag: str = "",
        check_collision: bool = True,
    ) -> tuple[BrickEntry, BrickEntry]:
        """Place a part at `(+x, y, z)` AND its exact chiral/geometric mirror across X = 0 at `(-x, y, z)`."""
        if abs(x) < 1e-4:
            raise ValueError("place_sym requires non-zero x (otherwise both copies overlap on X=0); use place().")
        e1 = self.place(
            part,
            color,
            x=x,
            y=y,
            z=z,
            yaw=yaw,
            pitch=pitch,
            roll=roll,
            studs_dir=studs_dir,
            ground=ground,
            center_xz=center_xz,
            tag=tag,
            check_collision=check_collision,
        )
        stem_m = self.mirror_map.get(e1.part, e1.part)
        mat_m = mirror_matrix_x(e1.matrix, plane_x=0.0)
        e2 = self._commit(stem_m, e1.color, mat_m, tag=tag or self._current_step, check_collision=check_collision)
        return e1, e2

    def snap(
        self,
        part: str,
        color: int | str,
        on: int | str | BrickEntry | list[int | BrickEntry] | None = None,
        near: tuple[float, float, float] | None = None,  # (x_studs, y_plates, z_studs)
        studs_dir: str | None = None,
        yaw: float | None = None,
        kind: str | None = None,  # None | "stud" | "clip" | "hinge" | "technic" | "non_stud"
        ortho_only: bool = True,
        fine_angles: bool = False,
        tag: str = "",
        mirror_x: bool = False,
    ) -> BrickEntry | tuple[BrickEntry, BrickEntry]:
        """Snap `part` onto `on` using libbmcore's exact typed connector solver (zero collisions guaranteed!)."""
        stem = part.strip().lower().removesuffix(".dat")
        col_id = resolve_color(color)

        hosts: list[int] | None = None
        if on is not None:
            if isinstance(on, BrickEntry):
                hosts = [on.idx]
            elif isinstance(on, int):
                hosts = [on]
            elif isinstance(on, str):
                hosts = list(self._tags.get(on, []))
                if not hosts:
                    raise ValueError(f"No bricks found with tag '{on}'.")
            else:
                hosts = [h.idx if isinstance(h, BrickEntry) else int(h) for h in on]

        cands = self.native.candidates(stem, hosts=hosts, max_out=2048, fine_angles=fine_angles, filter_collisions=True)
        mats = cands["matrices"]
        if len(mats) == 0:
            raise ValueError(f"No collision-free mated snap found for '{stem}' on hosts={hosts}.")

        if kind is not None:
            k_map = {"stud": 0, "clip": 1, "hinge": 2, "technic": 3, "generic": 4}
            if kind == "non_stud":
                kmask = cands["kinds"] != 0
            elif kind in k_map:
                kmask = cands["kinds"] == k_map[kind]
            else:
                raise ValueError(f"Unknown kind='{kind}'")
            if kmask.any():
                cands = {k: v[kmask] for k, v in cands.items()}
                mats = cands["matrices"]

        # Score candidates by orthogonal alignment, desired orientation, proximity to `near`, and multi-mate grip
        r24_c = nearest_rot24(mats[:, :3, :3])
        r_dot = np.einsum("nij,nij->n", mats[:, :3, :3], ROT24[r24_c])
        score = 0.25 * cands["mates"].astype(np.float64)
        if ortho_only:
            ortho = r_dot >= 2.98
            if ortho.any():
                score = np.where(ortho, score, score - 50.0)

        if studs_dir is not None or yaw is not None:
            R_tgt = make_rotation(yaw=yaw or 0.0, studs_dir=studs_dir)
            if studs_dir is not None and yaw is None:
                # Match local top-stud direction (col 1 of R) only
                col_dot = np.einsum("ni,i->n", mats[:, :3, 1], R_tgt[:, 1])
                score += 6.0 * col_dot
            else:
                frob = np.einsum("nij,ij->n", mats[:, :3, :3], R_tgt)
                score += 4.0 * frob

        if near is not None:
            tgt_yup = np.array([near[0] * 20.0, near[1] * 8.0, near[2] * 20.0], dtype=np.float64)
            bb_yup = ldraw_bbox_to_yup(cands["bboxes"])
            centers = 0.5 * (bb_yup[:, :3] + bb_yup[:, 3:6])
            dists = np.linalg.norm(centers - tgt_yup[None], axis=-1)
            score -= dists / 10.0

        best_i = int(np.argmax(score))
        e1 = self._commit(stem, col_id, mats[best_i], tag=tag or self._current_step, check_collision=False)
        if not mirror_x:
            return e1

        # Also snap/commit mirrored partner across X = 0
        stem_m = self.mirror_map.get(stem, stem)
        mat_m = mirror_matrix_x(e1.matrix, plane_x=0.0)
        e2 = self._commit(stem_m, col_id, mat_m, tag=tag or self._current_step, check_collision=True)
        return e1, e2

    # ---- Validation, Rendering & Export ----

    def validate(self) -> ValidationReport:
        """Run full native C++ collision, connectivity, stability, and symmetry audit."""
        chk = self.native.check()
        if not self.bricks:
            return ValidationReport(chk, (0.0, 0.0, 0.0), 1.0, {}, {}, ["Empty build"])

        bbs = np.stack([b.bbox_yup for b in self.bricks], axis=0)
        lo = bbs[:, :3].min(0)
        hi = bbs[:, 3:6].max(0)
        span_studs = (
            round(float(hi[0] - lo[0]) / 20.0, 2),
            round(float(hi[1] - lo[1]) / 8.0, 2),
            round(float(hi[2] - lo[2]) / 20.0, 2),
        )

        # Compute exact bilateral X-symmetry score across off-center bricks
        centers = 0.5 * (bbs[:, :3] + bbs[:, 3:6])
        off_idx = [i for i in range(len(self.bricks)) if abs(centers[i, 0]) >= 10.0]
        matched = 0
        for i in off_idx:
            c_m = np.array([-centers[i, 0], centers[i, 1], centers[i, 2]])
            dists = np.linalg.norm(centers - c_m[None], axis=-1)
            j = int(np.argmin(dists))
            if dists[j] <= 4.0 and self.bricks[j].color == self.bricks[i].color:
                matched += 1
        sym_score = (matched / len(off_idx)) if off_idx else 1.0

        palette: dict[int, int] = {}
        step_counts: dict[str, int] = {}
        for b in self.bricks:
            palette[b.color] = palette.get(b.color, 0) + 1
            step_counts[b.step_name] = step_counts.get(b.step_name, 0) + 1

        issues: list[str] = []
        if chk.overlaps > 0:
            issues.append(f"{chk.overlaps} mesh overlaps detected")
        if chk.groups > 1:
            issues.append(f"{chk.groups} disconnected components (largest={chk.largest_group}/{chk.pieces})")
        if not chk.stands:
            issues.append(f"unstable under gravity (unsupported={chk.unsupported}, tipping={chk.tipping}, margin={chk.margin:.1f})")
        if float(lo[1]) < -4.0:
            issues.append(f"extends below ground plane (min_y={lo[1]/8:.2f} plates)")
        return ValidationReport(chk, span_studs, round(sym_score, 3), palette, step_counts, issues)

    def to_ldr(self) -> str:
        chk = self.native.check()
        lines = [
            f"0 {self.title}",
            f"0 Name: {self.title}.ldr",
            "0 Author: BrickLayer-Studio (BrickMotion Studio native libbmcore certified)",
        ]
        if self.prompt:
            lines.append(f"0 // Prompt: {self.prompt}")
        lines.append(
            f"0 // Verified by libbmcore: pieces={chk.pieces} overlaps={chk.overlaps} "
            f"groups={chk.groups} stands={chk.stands} margin={chk.margin:.1f}"
        )
        prev_step: str | None = None
        for b in self.bricks:
            if prev_step is not None and b.step_name != prev_step:
                lines.append("0 STEP")
            if b.step_name != prev_step:
                lines.append(f"0 // Sub-assembly: {b.step_name}")
            prev_step = b.step_name
            m = b.matrix
            nums = " ".join(f"{round(float(v), 4) + 0.0:g}" for v in [*m[:3, 3], *m[:3, :3].flat])
            lines.append(f"1 {int(b.color)} {nums} {b.part}.dat")
        lines.append("0 NOFILE")
        return "\n".join(lines) + "\n"

    def save_ldr(self, path: str | Path) -> Path:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(self.to_ldr())
        return p

    def render_sheet(
        self,
        out_png: str | Path,
        size: int = 384,
        ref_image: str | Path | None = None,
    ) -> Path:
        """Render a crisp 4-view Metal `bmshot` inspection sheet (Front-3/4, Rear-3/4, Side, Front) + optional ref image."""
        if not BMSHOT.exists():
            raise FileNotFoundError(f"bmshot binary not found at {BMSHOT}")
        views = [
            ("Front 3/4", 2.48, 0.36),
            ("Rear 3/4", 5.62, 0.36),
            ("Side", 1.57, 0.14),
            ("Front", 3.1416, 0.16),
        ]
        ldr_text = self.to_ldr()
        panels: list[tuple[str, Image.Image]] = []
        if ref_image is not None and Path(ref_image).exists():
            rim = Image.open(ref_image).convert("RGB")
            rim.thumbnail((size, size), Image.Resampling.LANCZOS)
            bg = Image.new("RGB", (size, size), (245, 247, 250))
            bg.paste(rim, ((size - rim.width) // 2, (size - rim.height) // 2))
            panels.append(("Reference Image", bg))

        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            lp = tdp / "build.ldr"
            lp.write_text(ldr_text)
            for label, az, el in views:
                safe = re.sub(r"[^a-zA-Z0-9_-]+", "_", label)
                png = tdp / f"{safe}.png"
                res = subprocess.run(
                    [
                        str(BMSHOT),
                        str(lp),
                        "--out",
                        str(png),
                        "--size",
                        f"{size}x{size}",
                        "--azimuth",
                        str(az),
                        "--elevation",
                        str(el),
                        "--studio",
                    ],
                    cwd=ROOT,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                if res.returncode == 0 and png.exists():
                    panels.append((label, Image.open(png).convert("RGB")))

        rep = self.validate()
        n = len(panels)
        cols = min(n, 3) if n > 4 else min(n, 2)
        rows = (n + cols - 1) // cols
        header_h = 30
        footer_h = 28
        canvas = Image.new("RGB", (cols * size, rows * (size + header_h) + footer_h), (244, 246, 249))
        draw = ImageDraw.Draw(canvas)
        for i, (label, im) in enumerate(panels):
            r, c = divmod(i, cols)
            x0, y0 = c * size, r * (size + header_h)
            draw.text((x0 + 10, y0 + 8), label, fill=(25, 28, 35))
            canvas.paste(im, (x0, y0 + header_h))
        c = rep.check
        wx, hp, dz = rep.span_studs
        foot = (
            f"{self.title} | {c.pieces} parts | ov={c.overlaps} | grp={c.groups} | "
            f"stands={'YES' if c.stands else 'NO'} (margin={c.margin:.1f}) | "
            f"{wx:.1f}x{dz:.1f}s x {hp/3:.1f}b | sym={rep.symmetry_score*100:.0f}%"
        )
        draw.text(
            (10, rows * (size + header_h) + 7),
            foot,
            fill=(15, 110, 40) if c.certified else (180, 25, 25),
        )
        out_p = Path(out_png)
        out_p.parent.mkdir(parents=True, exist_ok=True)
        canvas.save(out_p)
        return out_p
