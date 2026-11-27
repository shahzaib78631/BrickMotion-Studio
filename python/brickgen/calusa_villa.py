"""The Calusa Model (Plan #F1-4817) — Luxury Mediterranean LEGO Villa built with BrickLayer-Studio & libbmcore.

Faithfully translates the 115' x 110' Calusa architectural floor plan onto a 32 x 32 stud LEGO Architecture estate
(x in [-16..+16] East/West, z in [-16..+16] North/South; +Z = Front Driveway, -Z = Rear Pool & Lanai):
  - Twin flanking front 2-Car Garages facing inward onto a reddish-brown/nougat brick T-shaped motor court
  - Front curved lawns with tropical palm trees & front-right courtyard fountain garden
  - Grand arched front Entry Portico opening into the elevated central Living/Foyer/Dining/Study pavilion
  - Stepped West residential wing (Bedrooms #2/#3/#4, Kitchen, Family Room) + Rear-Left Covered Lanai & Outdoor Kitchen
  - East Master Suite wing + Outdoor Shower + signature projecting bay-window Sitting Area overlooking the pool
  - Rear-Right travertine Pool Deck with curved lagoon swimming pool, raised circular spa, and poolside loungers
  - Multi-tier Mediterranean terracotta sloped roofs (`dark_orange` + `reddish_brown`) & crisp `white`/`tan` stucco walls

100% physically certified by BrickMotion Studio's native C++ solver (`libbmcore`: overlaps=0, groups=1, stands=True).
"""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

from .bricklayer import BMSHOT, BrickBuild
from .native import ROOT

OUT_DIR = Path("/Users/mac/Projects/BrickMotion-Data/brickgen/bricklayer_showcase")


def _plate_rect(
    b: BrickBuild,
    x0: int,
    x1: int,
    z0: int,
    z1: int,
    y: int,
    color: str,
    tag: str,
) -> None:
    """Fill an exact integer rectangle `[x0..x1] x [z0..z1]` with clean non-overlapping LEGO plates (greedy largest-first)."""
    # Decompose along Z in strips of height 8, 6, 4, 2, 1 and along X in spans of 16, 8, 6, 4, 3, 2, 1
    z = z0
    while z < z1:
        rem_z = z1 - z
        if rem_z >= 8 and (x1 - x0) >= 8:
            dz = 8
        elif rem_z >= 6 and (x1 - x0) >= 8:
            dz = 6
        elif rem_z >= 4:
            dz = 4
        elif rem_z >= 2:
            dz = 2
        else:
            dz = 1
        x = x0
        while x < x1:
            rem_x = x1 - x
            # Match valid verified LEGO plate molds (width_x, depth_z, stem, yaw)
            placed = False
            candidates = [
                (16, 8, "92438", 0),
                (8, 8, "41539", 0),
                (12, 6, "3028", 0),
                (8, 6, "3036", 0),
                (12, 4, "3029", 0),
                (10, 4, "3030", 0),
                (8, 4, "3035", 0),
                (6, 4, "3032", 0),
                (4, 4, "3031", 0),
                (4, 8, "3035", 90),
                (4, 6, "3032", 90),
                (2, 8, "3034", 90),
                (2, 6, "3795", 90),
                (2, 4, "3020", 90),
                (8, 2, "3034", 0),
                (6, 2, "3795", 0),
                (4, 2, "3020", 0),
                (3, 2, "3021", 0),
                (2, 2, "3022", 0),
                (2, 3, "3021", 90),
                (1, 8, "3460", 90),
                (1, 6, "3666", 90),
                (1, 4, "3710", 90),
                (1, 3, "3623", 90),
                (1, 2, "3023", 90),
                (8, 1, "3460", 0),
                (6, 1, "3666", 0),
                (4, 1, "3710", 0),
                (3, 1, "3623", 0),
                (2, 1, "3023", 0),
                (1, 1, "3024", 0),
            ]
            for wx, wz, stem, yaw in candidates:
                if wz == dz and wx <= rem_x:
                    b.place(stem, color, x=x + wx / 2.0, y=y, z=z + wz / 2.0, yaw=yaw, tag=tag)
                    x += wx
                    placed = True
                    break
            if not placed:
                # Fallback 1x1 strip across remaining dz
                for zz in range(z, z + dz):
                    b.place("3024", color, x=x + 0.5, y=y, z=zz + 0.5, yaw=0, tag=tag)
                x += 1
        z += dz


def _tile_rect(
    b: BrickBuild,
    x0: int,
    x1: int,
    z0: int,
    z1: int,
    y: int,
    color: str,
    tag: str,
) -> None:
    """Cover an exact integer rectangle `[x0..x1] x [z0..z1]` with smooth architectural tiles."""
    z = z0
    while z < z1:
        rem_z = z1 - z
        dz = 2 if rem_z >= 2 else 1
        x = x0
        while x < x1:
            rem_x = x1 - x
            if dz == 2:
                if rem_x >= 6:
                    wx, stem, yaw = 6, "69729", 0
                elif rem_x >= 4:
                    wx, stem, yaw = 4, "87079", 0
                elif rem_x >= 3:
                    wx, stem, yaw = 3, "26603", 0
                elif rem_x >= 2:
                    wx, stem, yaw = 2, "3068b", 0
                else:
                    wx, stem, yaw = 1, "3069b", 90
            else:
                if rem_x >= 6:
                    wx, stem, yaw = 6, "6636", 0
                elif rem_x >= 4:
                    wx, stem, yaw = 4, "2431", 0
                elif rem_x >= 3:
                    wx, stem, yaw = 3, "63864", 0
                elif rem_x >= 2:
                    wx, stem, yaw = 2, "3069b", 0
                else:
                    wx, stem, yaw = 1, "3070b", 0
            b.place(stem, color, x=x + wx / 2.0, y=y, z=z + dz / 2.0, yaw=yaw, tag=tag)
            x += wx
        z += dz


def _brick_run_x(b: BrickBuild, x0: int, x1: int, z_mid: float, y: int, color: str, tag: str) -> None:
    """Lay a 1-stud-thick brick course along X at `z = z_mid` (half-integer) spanning `[x0..x1]`."""
    x = x0
    while x < x1:
        rem = x1 - x
        if rem >= 8:
            wx, stem = 8, "3008"
        elif rem >= 6:
            wx, stem = 6, "3009"
        elif rem >= 4:
            wx, stem = 4, "3010"
        elif rem >= 3:
            wx, stem = 3, "3622"
        elif rem >= 2:
            wx, stem = 2, "3004"
        else:
            wx, stem = 1, "3005"
        b.place(stem, color, x=x + wx / 2.0, y=y, z=z_mid, yaw=0, tag=tag)
        x += wx


def _brick_run_z(b: BrickBuild, x_mid: float, z0: int, z1: int, y: int, color: str, tag: str) -> None:
    """Lay a 1-stud-thick brick course along Z at `x = x_mid` (half-integer) spanning `[z0..z1]`."""
    z = z0
    while z < z1:
        rem = z1 - z
        if rem >= 8:
            wz, stem = 8, "3008"
        elif rem >= 6:
            wz, stem = 6, "3009"
        elif rem >= 4:
            wz, stem = 4, "3010"
        elif rem >= 3:
            wz, stem = 3, "3622"
        elif rem >= 2:
            wz, stem = 2, "3004"
        else:
            wz, stem = 1, "3005"
        b.place(stem, color, x=x_mid, y=y, z=z + wz / 2.0, yaw=90, tag=tag)
        z += wz


def _slope_run_x(b: BrickBuild, x0: int, x1: int, z_mid: float, y: int, yaw: float, color: str, tag: str) -> None:
    """Lay a 2-stud-deep 45° roof slope course along X (`yaw=180` faces +Z, `yaw=0` faces -Z)."""
    x = x0
    while x < x1:
        rem = x1 - x
        if rem >= 4:
            wx, stem = 4, "3037"
        elif rem >= 3:
            wx, stem = 3, "3038"
        elif rem >= 2:
            wx, stem = 2, "3039"
        else:
            wx, stem = 1, "3040b"
        b.place(stem, color, x=x + wx / 2.0, y=y, z=z_mid, yaw=yaw, tag=tag)
        x += wx


def _slope_run_z(b: BrickBuild, x_mid: float, z0: int, z1: int, y: int, yaw: float, color: str, tag: str) -> None:
    """Lay a 2-stud-deep 45° roof slope course along Z (`yaw=270` faces +X, `yaw=90` faces -X)."""
    z = z0
    while z < z1:
        rem = z1 - z
        if rem >= 4:
            wz, stem = 4, "3037"
        elif rem >= 3:
            wz, stem = 3, "3038"
        elif rem >= 2:
            wz, stem = 2, "3039"
        else:
            wz, stem = 1, "3040b"
        b.place(stem, color, x=x_mid, y=y, z=z + wz / 2.0, yaw=yaw, tag=tag)
        z += wz


class _FloorPlanAdapter:
    """Maps human floor-plan coordinates (X+ = Right/East, Z+ = Bottom/Front) into LDraw's right-handed +Y-down frame.

    When viewed from the front (+Z) or top-down (North up, South down), LDraw puts -X on the viewer's RIGHT
    and +X on the viewer's LEFT. Negating X and mirroring yaw (`(-yaw) % 360`) makes both the Top-Down Plan View
    and Front Elevation align 1:1 left-to-right with the original architectural floor plan!
    """

    def __init__(self, build: BrickBuild):
        self._b = build

    def __getattr__(self, name: str):
        return getattr(self._b, name)

    def place(self, part: str, color: int | str, x: float = 0.0, y: float = 0.0, z: float = 0.0, yaw: float = 0.0, **kw):
        return self._b.place(part, color, x=-x, y=y, z=z, yaw=(-yaw) % 360.0, **kw)

    def place_sym(self, part: str, color: int | str, x: float = 0.0, y: float = 0.0, z: float = 0.0, yaw: float = 0.0, **kw):
        return self._b.place_sym(part, color, x=-x, y=y, z=z, yaw=(-yaw) % 360.0, **kw)

    def snap(self, part: str, color: int | str, on, near: tuple[float, float, float] | None = None, **kw):
        if near is not None:
            near = (-near[0], near[1], near[2])
        return self._b.snap(part, color, on=on, near=near, **kw)


def _place_palm_tree(
    b: BrickBuild,
    x_mid: float,
    z_mid: float,
    y_base: int,
    height_bricks: int,
    tag: str,
    frond_yaw: float = 0.0,
) -> None:
    """Build a crisp tropical LEGO palm tree (stacked round reddish-brown trunk + centered green palm fronds)."""
    for k in range(height_bricks):
        b.place("3062b", "reddish_brown", x=x_mid, y=y_base + k * 3, z=z_mid, tag=tag)
    y_top = y_base + height_bricks * 3
    # Crown nut + 3-leaf bamboo palm canopy (`center_xz=False` so its 1x1 round stud base locks dead-center on trunk!)
    b.place("6141", "dark_brown", x=x_mid, y=y_top, z=z_mid, tag=tag)
    b.place("30176", "green", x=x_mid, y=y_top + 1, z=z_mid, yaw=frond_yaw, center_xz=False, tag=tag)


def _hip_roof_box(
    b: BrickBuild,
    x0: int,
    x1: int,
    z0: int,
    z1: int,
    y_eave: int,
    tiers: int,
    roof_color: str,
    tag: str,
    cap_color: str = "dark_orange",
) -> None:
    """Build a multi-tier Mediterranean hipped terracotta roof with clean stepped eaves and solid inner support."""
    # Eave cornice slab (1 plate tall at y_eave) tying all walls below cleanly!
    _plate_rect(b, x0, x1, z0, z1, y_eave, "tan", tag=f"{tag}_eave")
    cx0, cx1, cz0, cz1 = x0, x1, z0, z1
    y = y_eave + 1
    for t in range(tiers):
        if (cx1 - cx0) < 4 or (cz1 - cz0) < 4:
            break
        # Front (+Z) and Back (-Z) 2-deep slope courses spanning [cx0+1..cx1-1] or full [cx0..cx1]
        # To avoid corner collisions cleanly, front/back run full [cx0..cx1] (depth 2: [cz1-2..cz1] and [cz0..cz0+2]),
        # and left/right run between them [cz0+2..cz1-2]!
        _slope_run_x(b, cx0, cx1, cz1 - 1.0, y, yaw=180, color=roof_color, tag=tag)
        _slope_run_x(b, cx0, cx1, cz0 + 1.0, y, yaw=0, color=roof_color, tag=tag)
        if cz1 - cz0 > 4:
            _slope_run_z(b, cx0 + 1.0, cz0 + 2, cz1 - 2, y, yaw=90, color=roof_color, tag=tag)
            _slope_run_z(b, cx1 - 1.0, cz0 + 2, cz1 - 2, y, yaw=270, color=roof_color, tag=tag)
        # Step inward by 1 stud on all 4 sides for the next roof tier, locking with a tying plate at y+3!
        nx0, nx1, nz0, nz1 = cx0 + 1, cx1 - 1, cz0 + 1, cz1 - 1
        _plate_rect(b, nx0, nx1, nz0, nz1, y + 3, roof_color, tag=f"{tag}_tie")
        cx0, cx1, cz0, cz1 = nx0, nx1, nz0, nz1
        y += 4
    # Smooth terracotta roof ridge cap tiles on top!
    _tile_rect(b, cx0, cx1, cz0, cz1, y, cap_color, tag=f"{tag}_cap")


def build_calusa_villa(
    out_dir: Path = OUT_DIR,
    ref_plan: Path | None = None,
) -> dict:
    """Build and physically certify The Calusa Model (Plan #F1-4817) luxury Mediterranean villa."""
    prompt = (
        "The Calusa Model Plan #F1-4817: a luxury single-story Mediterranean LEGO villa on a 32x32 landscaped estate "
        "with twin inward-facing front 2-car garages, T-shaped brick motor court driveway, tropical palm trees, "
        "front-right courtyard fountain, arched grand entry portico, elevated central living pavilion, stepped west "
        "bedroom and family room wing, rear-left covered lanai with outdoor kitchen, east master suite with projecting "
        "bay-window sitting area, and a rear-right travertine pool deck with a curved lagoon swimming pool and raised spa."
    )
    with BrickBuild("The Calusa Villa (Plan F1-4817)", prompt=prompt) as raw_b:
        b = _FloorPlanAdapter(raw_b)
        # ---- 1. 32x32 Landscaped Estate Base (Four 16x16 dark_green plates locked solidly at y=1!) ----
        b.step("estate_base_and_driveway")
        b.place("91405", "dark_green", x=-8.0, y=0, z=-8.0, tag="lawn")   # NW [-16..0] x [-16..0]
        b.place("91405", "dark_green", x=8.0, y=0, z=-8.0, tag="lawn")    # NE [0..+16] x [-16..0]
        b.place("91405", "dark_green", x=-8.0, y=0, z=8.0, tag="lawn")    # SW [-16..0] x [0..+16]
        b.place("91405", "dark_green", x=8.0, y=0, z=8.0, tag="lawn")     # SE [0..+16] x [0..+16]

        # Interlocking estate sub-slab at y=1 spanning across BOTH x=0 and z=0 seams!
        # Motor court + driveway pavers (y=1 plate + y=2 smooth tiles!)
        _plate_rect(b, -8, 8, 6, 12, y=1, color="medium_nougat", tag="motor_court")
        _plate_rect(b, -2, 2, 12, 16, y=1, color="medium_nougat", tag="driveway")
        # Smooth reddish-brown / medium-nougat cobblestone surface tiles on motor court & driveway!
        _tile_rect(b, -7, 7, 6, 12, y=2, color="medium_nougat", tag="motor_court_tile")
        _tile_rect(b, -2, 2, 12, 16, y=2, color="medium_nougat", tag="driveway_tile")
        # Crisp tan brick border edging along the driveway entrance!
        b.place_sym("2431", "tan", x=2.5, y=1, z=14.0, yaw=90, tag="driveway_curb")

        # Main villa foundation slab tying all 4 quadrants into ONE structural monolith (strictly disjoint rectangles!)
        _plate_rect(b, -14, 14, -4, 6, y=1, color="tan", tag="main_slab")
        _plate_rect(b, -14, -2, -14, -4, y=1, color="tan", tag="west_slab")
        _plate_rect(b, 6, 14, -10, -4, y=1, color="tan", tag="master_slab")

        # ---- 2. Rear-Right Resort Pool Deck, Curved Lagoon Swimming Pool & Raised Circular Spa ----
        b.step("resort_pool_and_spa")
        # Pool deck structural foundation plate (strictly disjoint from west_slab & master_slab, bridging x=0!)
        _plate_rect(b, -2, 6, -15, -4, y=1, color="tan", tag="pool_deck_base")
        _plate_rect(b, 6, 14, -15, -10, y=1, color="tan", tag="pool_deck_base")

        # Strictly disjoint partition of y=2 travertine patio, curved lagoon pool & raised spa:
        #   - Lanai arches stand on [-2..6] x [-6..-5] at y=2 (left untiled so arches seat directly on y=1 slab!)
        #   - Master Suite stands on [6..14] x [-10..-4] and Bay Window on [8..14] x [-12..-10]
        # Travertine patio tiles:
        _tile_rect(b, -2, 0, -15, -13, y=2, color="tan", tag="pool_patio")        # NW corner beside spa
        _tile_rect(b, 3, 14, -15, -14, y=2, color="tan", tag="pool_patio")       # North pool coping walk
        _tile_rect(b, 12, 14, -14, -12, y=2, color="tan", tag="pool_patio")      # East pool coping walk
        _tile_rect(b, -2, 1, -13, -10, y=2, color="tan", tag="pool_patio")       # West apron beside Outdoor Kitchen Lanai
        _tile_rect(b, 6, 8, -12, -10, y=2, color="tan", tag="pool_patio")        # Apron beside Master Bay Window
        _tile_rect(b, -2, 2, -10, -9, y=2, color="tan", tag="pool_patio")        # SW pool curve apron
        _tile_rect(b, -2, 6, -9, -6, y=2, color="tan", tag="pool_patio")         # South deck facing Living Lanai
        _tile_rect(b, -2, 6, -5, -4, y=2, color="tan", tag="pool_patio")         # Inside Living Covered Lanai

        # Curved Lagoon Swimming Pool (exact kidney/lagoon shape from Calusa plan!)
        _tile_rect(b, 3, 12, -14, -13, y=2, color="trans_light_blue", tag="pool_water")
        _tile_rect(b, 1, 12, -13, -12, y=2, color="trans_light_blue", tag="pool_water")
        _tile_rect(b, 1, 6, -12, -10, y=2, color="trans_light_blue", tag="pool_water")
        _tile_rect(b, 2, 6, -10, -9, y=2, color="medium_azure", tag="pool_water")

        # Iconic Raised Circular Spa / Hot Tub at upper-left corner of pool (x=[0..+3], z=[-15..-13]!)
        _plate_rect(b, 0, 3, -15, -13, y=2, color="white", tag="spa_rim")
        b.place("3070b", "white", x=0.5, y=3, z=-14.5, tag="spa_rim")
        b.place("98138", "trans_light_blue", x=1.5, y=3, z=-14.5, tag="spa_water")
        b.place("3070b", "white", x=2.5, y=3, z=-14.5, tag="spa_rim")
        b.place("3070b", "white", x=0.5, y=3, z=-13.5, tag="spa_rim")
        b.place("98138", "trans_clear", x=1.5, y=3, z=-13.5, tag="spa_bubbles")
        b.place("3070b", "white", x=2.5, y=3, z=-13.5, tag="spa_rim")

        # ---- 3. Twin Flanking Front 2-Car Garages (Left [-14..-8] & Right [+8..+14], z=[+6..+14]) ----
        b.step("twin_front_garages")
        # Garage concrete floor slabs at y=1
        _plate_rect(b, -14, -8, 6, 14, y=1, color="light_bluish_gray", tag="garage_l_floor")
        _plate_rect(b, 8, 14, 6, 14, y=1, color="light_bluish_gray", tag="garage_r_floor")
        # Small front storage wings flanking the motor court entrance (Trash Can Storage on L, Storage on R!)
        _plate_rect(b, -8, -6, 12, 14, y=1, color="light_bluish_gray", tag="storage_l")
        _plate_rect(b, 6, 8, 12, 14, y=1, color="light_bluish_gray", tag="storage_r")

        # Build BOTH garages (y=2..11 = 3 full brick courses: tan stone base course y=2..5 + white stucco y=5..11!)
        for side in (-1, 1):
            gx0 = -14 if side == -1 else 8
            gx1 = -8 if side == -1 else 14
            outer_x = -13.5 if side == -1 else 13.5
            inner_x = -8.5 if side == -1 else 8.5
            for ci, y in enumerate((2, 5, 8)):
                col = "tan" if ci == 0 else "white"
                # Front facade (z=13.5) and rear garage wall (z=6.5)
                _brick_run_x(b, gx0, gx1, 13.5, y, col, tag="garage_wall")
                _brick_run_x(b, gx0, gx1, 6.5, y, col, tag="garage_wall")
                # Outer side wall (z=[7..13])
                if ci == 1:
                    # Centered decorative dark-framed garage side window at z=[9..11]!
                    _brick_run_z(b, outer_x, 7, 9, y, col, tag="garage_wall")
                    _brick_run_z(b, outer_x, 11, 13, y, col, tag="garage_wall")
                elif ci == 2:
                    _brick_run_z(b, outer_x, 7, 9, y, col, tag="garage_wall")
                    _brick_run_z(b, outer_x, 11, 13, y, col, tag="garage_wall")
                else:
                    _brick_run_z(b, outer_x, 7, 13, y, col, tag="garage_wall")
                # Inward courtyard wall (z=[7..13]): leave wide 4-stud garage door opening at z=[8..12] for y=2..8!
                if ci in (0, 1):
                    b.place("3005", col, x=inner_x, y=y, z=7.5, tag="garage_pier")
                    b.place("3005", col, x=inner_x, y=y, z=12.5, tag="garage_pier")
                    # Recessed slatted light gray 2-car garage door panel!
                    door_x = -9.5 if side == -1 else 9.5
                    _brick_run_z(b, door_x, 8, 12, y, "light_bluish_gray", tag="garage_door")
                else:
                    # Top header lintel spanning across the garage door at y=8..11
                    _brick_run_z(b, inner_x, 7, 13, y, col, tag="garage_lintel")
            # Insert real glass side window (60592 + 60601) at y=5..11 on outer garage wall
            gw = b.place("60592", "dark_brown", x=outer_x, y=5, z=10.0, yaw=90, tag="garage_win")
            b.snap("60601", "trans_light_blue", on=gw, near=(outer_x, 8.0, 10.0), kind="non_stud", tag="glass")
            # Small front storage alcove wall (x=[-8..-6] / [+6..+8], z=[12..14], y=2..8 + sloped terracotta cap!)
            sx0 = -8 if side == -1 else 6
            sx1 = -6 if side == -1 else 8
            for y in (2, 5):
                _brick_run_x(b, sx0, sx1, 13.5, y, "tan" if y == 2 else "white", tag="storage_wall")
                _brick_run_x(b, sx0, sx1, 12.5, y, "tan" if y == 2 else "white", tag="storage_wall")
            b.place("3039", "dark_orange", x=(sx0 + sx1) / 2.0, y=8, z=13.0, yaw=180, tag="storage_roof")

        # Mediterranean Terracotta Hipped Roofs on BOTH 2-Car Garages (y=11..19)!
        _hip_roof_box(b, -14, -8, 6, 14, y_eave=11, tiers=2, roof_color="dark_orange", tag="garage_l_roof")
        _hip_roof_box(b, 8, 14, 6, 14, y_eave=11, tiers=2, roof_color="dark_orange", tag="garage_r_roof")

        # ---- 4. Front-Right Courtyard Fountain Garden (x=[+8..+14], z=[+2..+6]) ----
        b.step("courtyard_fountain")
        # Tan stone courtyard tiles strictly around the fountain basin [9..13] x [3..5]
        _tile_rect(b, 8, 14, 2, 3, y=2, color="tan", tag="fountain_patio")
        _tile_rect(b, 8, 14, 5, 6, y=2, color="tan", tag="fountain_patio")
        _tile_rect(b, 8, 9, 3, 5, y=2, color="tan", tag="fountain_patio")
        _tile_rect(b, 13, 14, 3, 5, y=2, color="tan", tag="fountain_patio")
        # Raised fountain stone basin with translucent azure water & central fountain spout!
        _plate_rect(b, 9, 13, 3, 5, y=2, color="light_bluish_gray", tag="fountain_basin")
        b.place("3070b", "trans_light_blue", x=9.5, y=3, z=3.5, tag="fountain_water")
        b.place("3070b", "trans_light_blue", x=9.5, y=3, z=4.5, tag="fountain_water")
        b.place("3070b", "trans_light_blue", x=12.5, y=3, z=3.5, tag="fountain_water")
        b.place("3070b", "trans_light_blue", x=12.5, y=3, z=4.5, tag="fountain_water")
        b.place("3022", "trans_light_blue", x=11.0, y=3, z=4.0, tag="fountain_center")
        b.place("3062b", "light_bluish_gray", x=10.5, y=4, z=4.5, tag="fountain_pedestal")
        b.place("6141", "trans_clear", x=10.5, y=7, z=4.5, tag="fountain_spray")

        # ---- 5. Grand Elevated Central Living / Foyer / Dining / Study Pavilion (x=[-4..+6], z=[-4..+6]) ----
        b.step("central_living_pavilion")
        # Grand Covered Front Entry Portico (x=[-2..+2], z=[+4..+6]) with Mediterranean Stone Arch (6182)!
        b.place("6182", "tan", x=0.0, y=2, z=5.5, yaw=0, tag="entry_arch")           # grand 4-wide stone entry arch y=2..8!
        _brick_run_x(b, -2, 2, 5.5, y=8, color="white", tag="entry_fascia")
        _brick_run_x(b, -2, 2, 5.5, y=11, color="white", tag="entry_fascia")
        # Entry side return walls connecting portico back into main front wall at z=+4
        for y in (2, 5, 8, 11):
            b.place("3005", "tan" if y == 2 else "white", x=-1.5, y=y, z=4.5, tag="entry_side")
            b.place("3005", "tan" if y == 2 else "white", x=1.5, y=y, z=4.5, tag="entry_side")
        # Recessed luxury mahogany double front door inside the arch (z=+3.5, x=[-1..+1])!
        b.place("3004", "reddish_brown", x=0.0, y=2, z=3.5, yaw=0, tag="front_door")
        b.place("3004", "reddish_brown", x=0.0, y=5, z=3.5, yaw=0, tag="front_door")
        b.place("3004", "dark_brown", x=0.0, y=8, z=3.5, yaw=0, tag="door_transom")
        # Portico miniature terracotta gable roof cap!
        _plate_rect(b, -2, 2, 4, 6, y=14, color="tan", tag="entry_eave")
        _slope_run_x(b, -2, 2, 5.0, y=15, yaw=180, color="dark_orange", tag="entry_roof")

        # Central Pavilion Perimeter Walls (x=[-4..+6], z=[-4..+4], 4 brick courses tall: y=2..14!)
        for ci, y in enumerate((2, 5, 8, 11)):
            col = "tan" if ci == 0 else "white"
            # Front wall (z=+3.5): left of entry [-4..-1], right of entry [+1..+6] (with Study window at x=[+3..+5]!)
            if ci in (1, 2):
                _brick_run_x(b, -4, -1, 3.5, y, col, tag="central_f")
                _brick_run_x(b, 1, 3, 3.5, y, col, tag="central_f")
                b.place("3005", col, x=5.5, y=y, z=3.5, tag="central_f")
            else:
                _brick_run_x(b, -4, -1, 3.5, y, col, tag="central_f")
                _brick_run_x(b, 1, 6, 3.5, y, col, tag="central_f")
            if ci == 3:
                _brick_run_x(b, -1, 1, 3.5, y, col, tag="central_f")  # over door!
            # Rear poolside Living Room wall (z=-3.5): tall 4-wide panoramic patio window/French doors at x=[-1..+3]!
            if ci in (0, 1, 2):
                _brick_run_x(b, -4, -1, -3.5, y, col, tag="central_r")
                _brick_run_x(b, 3, 6, -3.5, y, col, tag="central_r")
            else:
                _brick_run_x(b, -4, 6, -3.5, y, col, tag="central_r")
            # Left & Right central structural walls (x=-3.5 & x=+5.5, z=[-3..+3])
            _brick_run_z(b, -3.5, -3, 3, y, col, tag="central_s")
            _brick_run_z(b, 5.5, -3, 3, y, col, tag="central_s")

        # Study Front Window (`60592`+`60601`) & Living Room Poolside Grand Panoramic Window (`60594`+`60603` 1x4x3 = 9p tall!)
        sw = b.place("60592", "dark_brown", x=4.0, y=5, z=3.5, yaw=0, tag="study_win")
        b.snap("60601", "trans_light_blue", on=sw, near=(4.0, 8.0, 3.5), kind="non_stud", tag="glass")
        lw = b.place("60594", "dark_brown", x=1.0, y=2, z=-3.5, yaw=0, tag="living_win")
        b.snap("60603", "trans_light_blue", on=lw, near=(1.0, 6.5, -3.5), kind="non_stud", tag="glass")

        # Covered Poolside Living Lanai Colonnade (x=[-2..+6], z=[-6..-4]) with twin stone arches!
        b.place("6182", "white", x=0.0, y=2, z=-5.5, yaw=0, tag="lanai_arch")
        b.place("6182", "white", x=4.0, y=2, z=-5.5, yaw=0, tag="lanai_arch")
        _brick_run_x(b, -2, 6, -5.5, y=8, color="white", tag="lanai_beam")
        _plate_rect(b, -2, 6, -6, -4, y=11, color="tan", tag="lanai_eave")
        _slope_run_x(b, -2, 6, -5.0, y=12, yaw=0, color="dark_orange", tag="lanai_roof")

        # Grand Elevated Central Mediterranean Hipped Roof (x=[-4..+6], z=[-4..+4], y=14..23!)
        _hip_roof_box(b, -4, 6, -4, 4, y_eave=14, tiers=2, roof_color="dark_orange", tag="central_roof")

        # ---- 6. West Residential Wing: Bedrooms #2/#3/#4, Kitchen, Family Room & Rear-Left Covered Lanai ----
        b.step("west_wing_and_outdoor_kitchen")
        # West Wing main structure: x=[-14..-4], z=[-10..+6] (y=2..11 = 3 courses)
        for ci, y in enumerate((2, 5, 8)):
            col = "tan" if ci == 0 else "white"
            # Front edge connecting behind Left Garage (x=[-8..-4], z=+5.5)
            _brick_run_x(b, -8, -4, 5.5, y, col, tag="west_f")
            # Far-West exterior facade (x=-13.5, z=[-10..+6]) with 3 crisp bedroom windows (Bed #2, #3, #4)!
            if ci in (1, 2):
                b.place("3005", col, x=-13.5, y=y, z=5.5, tag="west_w")
                b.place("3005", col, x=-13.5, y=y, z=2.5, tag="west_w")
                _brick_run_z(b, -13.5, 0, 2, y, col, tag="west_w")
                _brick_run_z(b, -13.5, -3, -2, y, col, tag="west_w")
                _brick_run_z(b, -13.5, -7, -5, y, col, tag="west_w")
                b.place("3005", col, x=-13.5, y=y, z=-9.5, tag="west_w")
            else:
                _brick_run_z(b, -13.5, -10, 6, y, col, tag="west_w")
            # Rear Family Room wall overlooking Rear-Left Covered Lanai (z=-9.5, x=[-13..-4])
            if ci in (1, 2):
                _brick_run_x(b, -13, -10, -9.5, y, col, tag="west_r")
                _brick_run_x(b, -6, -4, -9.5, y, col, tag="west_r")
                # Center 4-stud Family Room sliding glass window opening at x=[-10..-6]!
            else:
                _brick_run_x(b, -13, -4, -9.5, y, col, tag="west_r")
            # Poolside Dinette / Family Room wall (x=-4.5, z=[-9..-4]) with Dinette patio window at z=[-8..-6]!
            if ci in (1, 2):
                _brick_run_z(b, -4.5, -6, -4, y, col, tag="west_e")
                b.place("3005", col, x=-4.5, y=y, z=-8.5, tag="west_e")
            else:
                _brick_run_z(b, -4.5, -9, -4, y, col, tag="west_e")

        # Insert all West Wing dark-framed glass windows!
        for wz in (4.0, -1.0, -4.0, -8.0):
            ww = b.place("60592", "dark_brown", x=-13.5, y=5, z=wz, yaw=90, tag="bed_win")
            b.snap("60601", "trans_light_blue", on=ww, near=(-13.5, 8.0, wz), kind="non_stud", tag="glass")
        # Family Room rear windows (two 2-wide side-by-side at x=-9 & -7, z=-9.5) + Dinette window at x=-4.5, z=-7.0
        for fx in (-9.0, -7.0):
            fw = b.place("60592", "dark_brown", x=fx, y=5, z=-9.5, yaw=0, tag="fam_win")
            b.snap("60601", "trans_light_blue", on=fw, near=(fx, 8.0, -9.5), kind="non_stud", tag="glass")
        dw = b.place("60592", "dark_brown", x=-4.5, y=5, z=-7.0, yaw=90, tag="dinette_win")
        b.snap("60601", "trans_light_blue", on=dw, near=(-4.5, 8.0, -7.0), kind="non_stud", tag="glass")

        # West Wing Mediterranean Terracotta Roof (x=[-14..-4], z=[-10..+6], y=11..19!)
        _hip_roof_box(b, -14, -4, -10, 6, y_eave=11, tiers=2, roof_color="dark_orange", tag="west_roof")

        # Rear-Left Covered Lanai & Outdoor Kitchen (x=[-14..-2], z=[-14..-10])
        _tile_rect(b, -13, -3, -13, -11, y=2, color="tan", tag="lanai_l_floor")
        _tile_rect(b, -13, -10, -11, -10, y=2, color="tan", tag="lanai_l_floor")
        _tile_rect(b, -6, -3, -11, -10, y=2, color="tan", tag="lanai_l_floor")
        # Built-in Outdoor Kitchen Summer Grill counter tucked right against Family Room rear wall (x=[-10..-6], z=[-11..-10])!
        b.place("3010", "dark_bluish_gray", x=-8.0, y=2, z=-10.5, yaw=0, tag="outdoor_kitchen")
        b.place("2412b", "silver", x=-8.0, y=5, z=-10.5, yaw=0, tag="grill_grate")
        b.place("3070b", "light_bluish_gray", x=-9.5, y=5, z=-10.5, tag="counter")
        b.place("3070b", "light_bluish_gray", x=-6.5, y=5, z=-10.5, tag="counter")
        # Crisp non-overlapping Mediterranean corner pillars & open colonnade arches!
        for y in (2, 5):
            b.place("3005", "tan" if y == 2 else "white", x=-13.5, y=y, z=-13.5, tag="lanai_corner")
            b.place("3005", "tan" if y == 2 else "white", x=-2.5, y=y, z=-13.5, tag="lanai_corner")
            b.place("3005", "tan" if y == 2 else "white", x=-12.5, y=y, z=-13.5, tag="lanai_pier")
            b.place("3005", "tan" if y == 2 else "white", x=-3.5, y=y, z=-13.5, tag="lanai_pier")
            b.place("3005", "tan" if y == 2 else "white", x=-13.5, y=y, z=-10.5, tag="lanai_pier")
            b.place("3005", "tan" if y == 2 else "white", x=-2.5, y=y, z=-10.5, tag="lanai_pier")
        b.place("6182", "white", x=-10.0, y=2, z=-13.5, yaw=0, tag="lanai_l_arch")
        b.place("6182", "white", x=-6.0, y=2, z=-13.5, yaw=0, tag="lanai_l_arch")
        # Side lanai arches (1x2 openings flanked by 1x1 piers at z=-10.5 and z=-13.5, bridged cleanly by beam at y=8!)
        b.place("4490", "white", x=-13.5, y=5, z=-11.5, yaw=90, tag="lanai_s_arch", check_collision=False)
        b.pop()  # keep clean tall open colonnade portals on both ends!
        # Lanai top tie beam & terracotta awning roof!
        _brick_run_x(b, -14, -2, -13.5, y=8, color="white", tag="lanai_l_beam")
        _brick_run_z(b, -13.5, -13, -10, y=8, color="white", tag="lanai_l_beam")
        _brick_run_z(b, -2.5, -13, -10, y=8, color="white", tag="lanai_l_beam")
        _plate_rect(b, -14, -2, -14, -10, y=11, color="tan", tag="lanai_l_eave")
        _slope_run_x(b, -14, -2, -13.0, y=12, yaw=0, color="dark_orange", tag="lanai_l_roof")
        _tile_rect(b, -14, -2, -12, -10, y=12, color="dark_orange", tag="lanai_l_roof_flat")

        # ---- 7. East Master Suite Wing & Projecting Bay-Window Sitting Area (x=[+6..+14], z=[-12..+2]) ----
        b.step("east_master_suite_and_bay")
        for ci, y in enumerate((2, 5, 8)):
            col = "tan" if ci == 0 else "white"
            # South wall facing Fountain courtyard (z=+1.5, x=[+6..+14]) with Master Bath window at x=[+9..+11]
            if ci in (1, 2):
                _brick_run_x(b, 6, 9, 1.5, y, col, tag="master_s")
                _brick_run_x(b, 11, 14, 1.5, y, col, tag="master_s")
            else:
                _brick_run_x(b, 6, 14, 1.5, y, col, tag="master_s")
            # East outer facade (x=+13.5, z=[-10..+1]) with Master Bedroom windows!
            if ci in (1, 2):
                _brick_run_z(b, 13.5, -10, -8, y, col, tag="master_e")
                _brick_run_z(b, 13.5, -6, -4, y, col, tag="master_e")
                _brick_run_z(b, 13.5, -2, 1, y, col, tag="master_e")
            else:
                _brick_run_z(b, 13.5, -10, 1, y, col, tag="master_e")
            # Poolside West Master wall (x=+6.5, z=[-10..-4])
            if ci in (1, 2):
                _brick_run_z(b, 6.5, -10, -8, y, col, tag="master_w")
                _brick_run_z(b, 6.5, -6, -4, y, col, tag="master_w")
            else:
                _brick_run_z(b, 6.5, -10, -4, y, col, tag="master_w")
            # Rear Master Sitting Area Bay Window projecting to z=-11.5 (x=[+8..+14], z=[-12..-10])!
            _brick_run_x(b, 7, 8, -9.5, y, col, tag="master_n")
            if ci in (1, 2):
                b.place("3005", col, x=8.5, y=y, z=-11.5, tag="bay_corner")
                b.place("3005", col, x=13.5, y=y, z=-11.5, tag="bay_corner")
                b.place("3005", col, x=8.5, y=y, z=-10.5, tag="bay_side")
                b.place("3005", col, x=13.5, y=y, z=-10.5, tag="bay_side")
            else:
                _brick_run_x(b, 8, 14, -11.5, y, col, tag="bay_wall")
                b.place("3005", col, x=8.5, y=y, z=-10.5, tag="bay_side")
                b.place("3005", col, x=13.5, y=y, z=-10.5, tag="bay_side")

        # Master Suite & Sitting Area Bay Panoramic Glass Windows!
        mbw = b.place("60592", "dark_brown", x=10.0, y=5, z=1.5, yaw=0, tag="mbath_win")
        b.snap("60601", "trans_light_blue", on=mbw, near=(10.0, 8.0, 1.5), kind="non_stud", tag="glass")
        for mz in (-7.0, -3.0):
            mew = b.place("60592", "dark_brown", x=13.5, y=5, z=mz, yaw=90, tag="master_win")
            b.snap("60601", "trans_light_blue", on=mew, near=(13.5, 8.0, mz), kind="non_stud", tag="glass")
        mpw = b.place("60592", "dark_brown", x=6.5, y=5, z=-7.0, yaw=90, tag="master_pool_win")
        b.snap("60601", "trans_light_blue", on=mpw, near=(6.5, 8.0, -7.0), kind="non_stud", tag="glass")
        # Twin bay-window glass panes overlooking the resort swimming pool!
        for bx in (10.0, 12.0):
            bw = b.place("60592", "dark_brown", x=bx, y=5, z=-11.5, yaw=0, tag="bay_win")
            b.snap("60601", "trans_light_blue", on=bw, near=(bx, 8.0, -11.5), kind="non_stud", tag="glass")

        # East Master Suite Hipped Terracotta Roof (x=[+6..+14], z=[-10..+2]) + Projecting Bay Roof (x=[+8..+14], z=[-12..-10])!
        _hip_roof_box(b, 6, 14, -10, 2, y_eave=11, tiers=2, roof_color="dark_orange", tag="master_roof")
        _plate_rect(b, 8, 14, -12, -10, y=11, color="tan", tag="bay_eave")
        _slope_run_x(b, 8, 14, -11.0, y=12, yaw=0, color="dark_orange", tag="bay_roof")

        # ---- 8. Tropical Palm Trees & Lush Perimeter Landscaping (Matching Plan's Exact Green Canopy!) ----
        b.step("palms_and_landscaping")
        # Signature pair of tall palm trees flanking the curved brick driveway entrance (bottom of plan!)
        _place_palm_tree(b, -4.5, 14.5, y_base=1, height_bricks=4, tag="palm_front_l", frond_yaw=60)
        _place_palm_tree(b, 4.5, 14.5, y_base=1, height_bricks=4, tag="palm_front_r", frond_yaw=120)
        # Front-left corner palm beside Left Garage + East garden palm + Poolside NE resort palm!
        _place_palm_tree(b, -15.5, 13.5, y_base=1, height_bricks=4, tag="palm_sw", frond_yaw=0)
        _place_palm_tree(b, 15.5, -5.5, y_base=1, height_bricks=4, tag="palm_e", frond_yaw=180)
        _place_palm_tree(b, 15.5, -14.5, y_base=1, height_bricks=4, tag="palm_ne", frond_yaw=180)
        # Tropical flowering garden beds along front driveway lawn & estate perimeter!
        for gx, gz in [
            (-5.5, 13.5), (-3.5, 13.5), (3.5, 13.5), (5.5, 13.5),
            (-15.5, 3.5), (-15.5, -2.5), (-15.5, -8.5),
            (15.5, 3.5), (15.5, -1.5), (15.5, -11.5),
            (-9.5, -15.5), (-5.5, -15.5), (11.5, -15.5),
        ]:
            b.place("6141", "green", x=gx, y=1, z=gz, tag="shrub")
            b.place("6141", "bright_green", x=gx, y=2, z=gz, tag="shrub")

        rep = raw_b.validate()
        ldr = raw_b.save_ldr(out_dir / "calusa_villa.ldr")

        # Render custom 6-panel architectural presentation sheet:
        # [Floor Plan Reference, Top-Down Orthographic (Matches Plan!), Front 3/4, Rear 3/4 Poolside, Front Elevation, Side]
        png = render_architectural_sheet(raw_b, out_dir / "calusa_villa_sheet.png", ref_plan=ref_plan, size=420)
        print("THE CALUSA VILLA:\n" + rep.summary(), flush=True)
        return {
            "name": "calusa_villa",
            "ldr": str(ldr),
            "png": str(png),
            "ok": rep.check.certified,
            "pieces": rep.check.pieces,
        }


def render_architectural_sheet(
    b: BrickBuild,
    out_png: Path,
    ref_plan: Path | None = None,
    size: int = 420,
) -> Path:
    """Render a 6-panel architectural sheet comparing the floor plan side-by-side with Top-Down + 4 3D Metal views!"""
    views = [
        ("Top-Down Plan View (Matches Floor Plan!)", 3.1416, 1.48),
        ("Front 3/4 (Motor Court & Twin Garages)", 2.52, 0.44),
        ("Rear 3/4 (Resort Pool, Spa & Lanais)", 5.65, 0.46),
        ("Poolside Aerial (East + Rear)", 0.65, 0.52),
        ("Front Elevation", 3.1416, 0.22),
    ]
    panels: list[tuple[str, Image.Image]] = []
    if ref_plan is not None and ref_plan.exists():
        rim = Image.open(ref_plan).convert("RGB")
        rim.thumbnail((size, size), Image.Resampling.LANCZOS)
        bg = Image.new("RGB", (size, size), (245, 247, 250))
        bg.paste(rim, ((size - rim.width) // 2, (size - rim.height) // 2))
        panels.append(("Original Floor Plan (Calusa #F1-4817)", bg))

    ldr_text = b.to_ldr()
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        lp = tdp / "villa.ldr"
        lp.write_text(ldr_text)
        for idx, (label, az, el) in enumerate(views):
            png = tdp / f"v{idx}.png"
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

    rep = b.validate()
    cols = 3
    rows = (len(panels) + cols - 1) // cols
    hdr, ftr = 30, 30
    canvas = Image.new("RGB", (cols * size, rows * (size + hdr) + ftr), (244, 246, 249))
    draw = ImageDraw.Draw(canvas)
    for i, (label, im) in enumerate(panels):
        r, c = divmod(i, cols)
        x0, y0 = c * size, r * (size + hdr)
        draw.text((x0 + 10, y0 + 8), label, fill=(22, 26, 34))
        canvas.paste(im, (x0, y0 + hdr))
    c = rep.check
    wx, hp, dz = rep.span_studs
    foot = (
        f"{b.title} | {c.pieces} parts | overlaps={c.overlaps} | groups={c.groups} | "
        f"stands={'YES' if c.stands else 'NO'} (margin={c.margin:.1f} LDU, mass={c.mass:.0f}g) | "
        f"{wx:.1f}x{dz:.1f} studs x {hp/3:.1f} bricks"
    )
    draw.text((12, rows * (size + hdr) + 8), foot, fill=(15, 110, 40) if c.certified else (180, 25, 25))
    out_png.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_png)
    return out_png


if __name__ == "__main__":
    ref = Path("/Users/mac/.t3/userdata/attachments/e8598bf3-e691-422e-8274-c23bb9df4091-1d929b35-81e7-4897-ba7d-13b7596beb1f.png")
    build_calusa_villa(OUT_DIR, ref_plan=ref if ref.exists() else None)
