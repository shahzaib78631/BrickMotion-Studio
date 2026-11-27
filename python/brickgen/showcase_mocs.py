"""Three human-grade showcase LEGO MOCs built with BrickLayer-Studio + certified by native C++ libbmcore.

Demonstrates the BrickWright / BrickLayer hierarchical sub-assembly paradigm directly on BrickMotion Studio's
native C++ geometry/connector/collision/stability solver (`libbmcore`) and Apple Metal renderer (`bmshot`):
  1. `speed_champions_gt`: 8-stud-wide Red Speed Champions GT Sports Car (matching reference image!)
  2. `medieval_watchtower`: Medieval Stone Castle Watchtower with embossed masonry, arches, battlements, torches & banner
  3. `brickheadz_hero`: Collectible BrickHeadz Superhero with authentic `22885` SNOT head core, curved hair & red cape
"""
from __future__ import annotations

from pathlib import Path

from .bricklayer import BrickBuild

OUT_DIR = Path("/Users/mac/Projects/BrickMotion-Data/brickgen/bricklayer_showcase")


def build_speed_champions_gt(out_dir: Path = OUT_DIR, ref_image: Path | None = None) -> dict:
    """8-stud-wide Red Speed Champions GT Sports Car — clean sub-assemblies, real wheels, arches, windscreen & spoiler."""
    prompt = (
        "A sleek 8-stud-wide red LEGO Speed Champions sports car with silver 5-spoke wheels inside red wheel arches, "
        "black front splitter and grille, translucent yellow headlights, curved red hood, dark tinted slanted windscreen, "
        "cockpit steering wheel, red sloped roof, translucent red taillights, and a black-and-red rear wing spoiler."
    )
    with BrickBuild("Speed Champions Red GT", prompt=prompt) as b:
        # ---- 1. Chassis & 4-Wheel Rolling Base ----
        # 30157 axle at y=2.75 puts 18977 racing tyres right at y_up=0 (ground), with top stud plane at y=5 plates!
        # Wheels occupy x=±[2.4..3.8], z=±[3.5..6.5], y=[0..7.5]p -> central spine stays 4-wide (x=[-2..+2]) at y=5..7!
        b.step("chassis_and_wheels")
        ax_f = b.place("30157", "black", x=0, y=2.75, z=5.0, yaw=0, tag="axle_front")
        ax_r = b.place("30157", "black", x=0, y=2.75, z=-5.0, yaw=0, tag="axle_rear")

        # Snap 4 Speed Champions rims + racing tyres via libbmcore exact Technic wheel pins
        wf1, wf2 = b.snap("18976", "silver", on=ax_f, near=(3.2, 3.5, 5.0), kind="technic", tag="wheel", mirror_x=True)
        b.snap("18977", "black", on=wf1, near=(3.2, 3.5, 5.0), kind="non_stud", tag="tyre", mirror_x=True)
        wr1, wr2 = b.snap("18976", "silver", on=ax_r, near=(3.2, 3.5, -5.0), kind="technic", tag="wheel", mirror_x=True)
        b.snap("18977", "black", on=wr1, near=(3.2, 3.5, -5.0), kind="non_stud", tag="tyre", mirror_x=True)

        # Rigid 4-wide central chassis spine passing cleanly between all 4 wheels (z = -8..+8, x = [-2..+2], y = 5)
        b.place("3035", "black", x=0, y=5, z=0, yaw=90, tag="chassis")               # 4x8 center spine z=[-4..+4]
        b.place("3031", "black", x=0, y=5, z=6.0, yaw=0, tag="chassis")              # 4x4 front spine z=[+4..+8] (locks onto ax_f!)
        b.place("3031", "black", x=0, y=5, z=-6.0, yaw=0, tag="chassis")             # 4x4 rear spine  z=[-8..-4] (locks onto ax_r!)

        # Full 8-stud-wide side sills & low dropped black side skirts strictly between wheel wells (z=[-3..+3])
        b.place_sym("3795", "black", x=3.0, y=5, z=0, yaw=90, tag="sill")            # 2x6 at x=±[2..4], z=[-3..+3], y=5
        b.place_sym("3795", "black", x=3.0, y=4, z=0, yaw=90, tag="rocker")          # 2x6 dropped black side skirt y=4
        b.place_sym("3710", "black", x=3.5, y=3, z=0, yaw=90, tag="rocker")          # lowest black aero side lip y=3

        # ---- 2. Front Splitter, Recessed Black Grille & Twin Yellow Headlights ----
        b.step("front_bumper_and_hood")
        # Low full-width 8-stud black front splitter chin (z=[+7..+9], y=4 plates, locked under front spine!)
        b.place("3034", "black", x=0, y=4, z=8.0, yaw=0, tag="splitter")             # 8x2 black front splitter x=[-4..4], z=[7..9]
        b.place("3710", "black", x=0, y=5, z=8.5, yaw=0, tag="grille")               # 4x1 black center intake base
        b.place("2412b", "black", x=-1.0, y=6, z=8.5, yaw=0, tag="grille")           # center intake grille tiles
        b.place("2412b", "black", x=1.0, y=6, z=8.5, yaw=0, tag="grille")
        # Red front bumper corners + angled nose accents (x=±[2..4], z=[7..9])
        b.place_sym("3022", "red", x=3.0, y=5, z=8.0, yaw=0, tag="front_bumper")     # 2x2 red bumper base
        b.place_sym("3022", "red", x=3.0, y=6, z=8.0, yaw=0, tag="front_bumper")     # 2x2 red bumper mid
        # Twin translucent yellow headlights (matching reference image!) + solid fender deck behind them
        b.place_sym("6141", "trans_yellow", x=2.5, y=7, z=8.5, tag="headlight")
        b.place_sym("6141", "trans_yellow", x=3.5, y=7, z=8.5, tag="headlight")
        b.place_sym("3023", "red", x=3.0, y=7, z=7.5, yaw=0, tag="hood_nose")         # 2x1 red plate supporting front arch bridge!

        # ---- 3. Wheel Arches & Sculpted Red Hood ----
        b.step("wheel_arches_and_hood")
        # Fore & aft wheel-well fender pillars (z=±2.5 & z=-7.5 — strictly clear of wheels z=±[3.5..6.5]!)
        b.place_sym("3023", "red", x=3.0, y=6, z=2.5, yaw=0, tag="fender_side")      # x=[2..4], z=[2..3], y=6
        b.place_sym("3023", "red", x=3.0, y=7, z=2.5, yaw=0, tag="fender_side")      # y=7
        b.place_sym("3023", "red", x=3.0, y=6, z=-2.5, yaw=0, tag="fender_side")
        b.place_sym("3023", "red", x=3.0, y=7, z=-2.5, yaw=0, tag="fender_side")

        # Rear diffuser & bumper corners (built early so rear wheel arches bridge cleanly onto them!)
        b.place("3034", "black", x=0, y=4, z=-8.0, yaw=0, tag="rear_diffuser")       # 8x2 low black rear diffuser x=[-4..4], z=[-9..-7]
        b.place("3710", "black", x=0, y=5, z=-8.5, yaw=0, tag="rear_diffuser")       # 4x1 black exhaust recess
        b.place_sym("3022", "red", x=3.0, y=5, z=-8.0, yaw=0, tag="rear_bumper")     # 2x2 red rear corners
        b.place_sym("3022", "red", x=3.0, y=6, z=-8.0, yaw=0, tag="rear_bumper")
        b.place_sym("3023", "red", x=3.0, y=7, z=-7.5, yaw=0, tag="rear_fender")     # x=[2..4], z=[-8..-7], y=7

        # Top red wheel-arch bridges spanning cleanly over front & rear wheels at y=8 (clears 7.5p tyres!)
        b.place_sym("3666", "red", x=3.5, y=8, z=5.0, yaw=90, tag="fender_arch")     # 1x6 at x=±3.5, z=[2..8], y=8
        b.place_sym("3666", "red", x=3.5, y=8, z=-5.0, yaw=90, tag="fender_arch")    # 1x6 at x=±3.5, z=[-8..-2], y=8
        # Curved wheel-arch crowns (11477/15068: yaw=180 slopes down toward +Z front, yaw=0 slopes down toward -Z rear!)
        b.place_sym("11477", "red", x=3.5, y=9, z=7.0, yaw=180, tag="arch_curve")    # front wheel arch forward slope (+Z)
        b.place_sym("3069b", "red", x=3.5, y=9, z=5.0, yaw=90, tag="arch_crown")     # smooth 1x2 crown over wheel
        b.place_sym("11477", "red", x=3.5, y=9, z=3.0, yaw=0, tag="arch_curve")      # front wheel arch rear slope (-Z)
        b.place_sym("11477", "red", x=3.5, y=9, z=-3.0, yaw=180, tag="arch_curve")   # rear wheel arch forward slope (+Z)
        b.place_sym("3069b", "red", x=3.5, y=9, z=-5.0, yaw=90, tag="arch_crown")
        b.place_sym("11477", "red", x=3.5, y=9, z=-7.0, yaw=0, tag="arch_curve")     # rear wheel arch tail slope (-Z)

        # Inner front hood core (4-wide at y=6..7 to clear tyres, widening to 6-wide at y=8 ABOVE tyres!)
        b.place("3031", "red", x=0, y=6, z=5.0, yaw=0, tag="hood_base")              # 4x4 z=[3..7], x=[-2..2]
        b.place("3031", "red", x=0, y=7, z=5.0, yaw=0, tag="hood_mid")               # 4x4 z=[3..7], x=[-2..2]
        b.place("3032", "red", x=0, y=8, z=5.0, yaw=0, tag="hood_bridge")            # 6x4 z=[3..7], x=[-3..3] (ties fenders!)
        b.place("3710", "black", x=0, y=6, z=7.5, yaw=0, tag="hood_nose")            # 4x1 black upper grille backing z=[7..8]
        b.place("3710", "red", x=0, y=7, z=7.5, yaw=0, tag="hood_nose")              # 4x1 front hood support z=[7..8]
        b.place("3710", "red", x=0, y=8, z=7.5, yaw=0, tag="hood_nose")              # 4x1 front hood lip
        # Sculpted sleek curved red hood slopes (15068: yaw=180 slopes smoothly down toward +Z nose!)
        b.place_sym("15068", "red", x=1.0, y=9, z=7.0, yaw=180, tag="hood_slope")    # z=[6..8], slopes down toward nose!
        b.place_sym("15068", "red", x=1.0, y=9, z=5.0, yaw=180, tag="hood_slope")    # z=[4..6]
        b.place_sym("3069b", "red", x=1.0, y=9, z=3.5, yaw=0, tag="hood_cowl")       # smooth cowl ahead of windscreen
        b.place_sym("11477", "red", x=2.5, y=9, z=6.0, yaw=180, tag="hood_ridge")    # outer hood ridges sloping forward
        b.place_sym("3069b", "red", x=2.5, y=9, z=4.0, yaw=90, tag="hood_ridge")

        # ---- 4. Side Doors, Cockpit Interior, Side Mirrors & Dark Tinted Windscreen ----
        b.step("cockpit_and_doors")
        # Split cockpit side sills at y=6 leaving a genuine low-slung driver cockpit well (x=[-1..+1]) for steering & seat!
        b.place_sym("3020", "dark_bluish_gray", x=2.0, y=6, z=0, yaw=90, tag="interior")  # 2x4 sills x=±[1..3], z=[-2..+2]
        # Front black dashboard cowl (z=+2.5, y=6..9) — mates directly to 65633 windscreen front studs!
        b.place("3710", "black", x=0, y=6, z=2.5, yaw=0, tag="dashboard")            # 4x1 dash base x=[-2..+2], z=[2..3]
        b.place("3710", "black", x=0, y=7, z=2.5, yaw=0, tag="dashboard")
        b.place("3710", "black", x=0, y=8, z=2.5, yaw=0, tag="dashboard")            # y=8 -> 65633 snaps right onto this!
        b.place("3023", "black", x=0, y=6, z=0.5, yaw=0, tag="steering_mount")       # center console mount
        b.place("3023", "black", x=0, y=6, z=-1.5, yaw=0, tag="seat_base")           # low racing seat base
        b.place("3023", "dark_bluish_gray", x=0, y=7, z=-1.5, yaw=0, tag="seat_back")
        # Sculpted smooth red side doors (z=[-2..+2], x=±3.5, y=6..10) + sleek low-profile red side mirrors!
        b.place_sym("3710", "red", x=3.5, y=6, z=0, yaw=90, tag="door")              # 1x4 door lower plate
        b.place_sym("3010", "red", x=3.5, y=7, z=0, yaw=90, tag="door")              # 1x4 smooth red door brick (y=7..10)
        b.place_sym("63864", "red", x=3.5, y=10, z=-0.5, yaw=90, tag="door_top")     # 1x3 smooth red door trim z=[-2..+1]
        b.place_sym("3023", "red", x=4.0, y=10, z=1.5, yaw=0, tag="side_mirror")     # compact red mirror arm x=±[3..5]
        b.place_sym("3070b", "red", x=4.5, y=11, z=1.5, tag="side_mirror")           # sleek flat red mirror cap!
        # Windscreen support rails (x=±2.5, z=[-2..+2], y=7..9)
        b.place_sym("3710", "black", x=2.5, y=7, z=0, yaw=90, tag="ws_rail")
        b.place_sym("3710", "black", x=2.5, y=8, z=0, yaw=90, tag="ws_rail")
        # Official Speed Champions 6x6 angled dark tinted windscreen (65633)
        b.place("65633", "trans_black", x=0, y=9, z=0.0, yaw=180, tag="windscreen")
        # Sleek flush 6x2 red roof starting EXACTLY at 65633's roof line (z=-2.0..z=-4.0, ZERO overhanging visor!)
        b.place("3795", "red", x=0, y=13, z=-3.0, yaw=0, tag="roof")                 # 6x2 red roof z=[-4..-2], x=[-3..+3]
        b.place("3068b", "red", x=-1.0, y=14, z=-3.0, yaw=0, tag="roof_tile")        # smooth 2x2 red roof tiles
        b.place("3068b", "red", x=1.0, y=14, z=-3.0, yaw=0, tag="roof_tile")
        b.place_sym("3069b", "red", x=2.5, y=14, z=-3.0, yaw=90, tag="roof_tile")

        # ---- 5. Fastback Engine Deck, Taillights & Black-and-Red GT Rear Wing Spoiler ----
        b.step("rear_deck_and_spoiler")
        # 4-wide rear deck core at y=6..7 (clears tyres!), widening to 6-wide at y=8 ABOVE tyres!
        b.place("3031", "red", x=0, y=6, z=-5.0, yaw=0, tag="rear_deck")             # 4x4 z=[-7..-3]
        b.place("3031", "red", x=0, y=7, z=-5.0, yaw=0, tag="rear_deck")
        b.place("3032", "red", x=0, y=8, z=-5.0, yaw=0, tag="rear_bridge")           # 6x4 z=[-7..-3], x=[-3..3] (ties rear arches!)
        # Rear cabin B-pillars & tinted rear quarter window framing rising cleanly to lock the roof at y=13!
        b.place_sym("3005", "black", x=2.5, y=9, z=-3.5, tag="b_pillar")             # 1x1 black B-pillar y=9..12
        b.place_sym("3024", "red", x=2.5, y=12, z=-3.5, tag="b_pillar")              # y=12..13 -> locks roof at y=13!
        # Fastback sloped rear engine deck sweeping smoothly down from roof (z=-4) to tail (z=-6)!
        b.place("3020", "black", x=0, y=9, z=-4.0, yaw=0, tag="engine_bay")          # 4x2 dark engine louver base z=[-5..-3]
        b.place("3020", "black", x=0, y=10, z=-5.0, yaw=0, tag="engine_bay")         # stepped dark rear deck z=[-6..-4]
        b.place("3020", "red", x=0, y=11, z=-5.0, yaw=0, tag="fastback_deck")        # sleek fastback deck z=[-6..-4]
        b.place_sym("15068", "red", x=1.0, y=12, z=-5.0, yaw=0, tag="fastback_slope") # locks onto fastback_deck z=-5.5, sweeps aft!
        b.place_sym("11477", "red", x=2.5, y=9, z=-5.0, yaw=0, tag="fastback")       # curved red rear deck shoulders sloping aft (-Z)!
        # Rear fascia + glowing translucent red taillights!
        b.place("3010", "red", x=0, y=6, z=-8.5, yaw=0, tag="rear_fascia")           # 1x4 red rear fascia y=6..9
        b.place_sym("6141", "trans_red", x=2.5, y=7, z=-8.5, tag="taillight")
        b.place_sym("6141", "trans_red", x=3.5, y=7, z=-8.5, tag="taillight")
        b.place("3020", "red", x=0, y=9, z=-7.0, yaw=0, tag="rear_trunk")            # 4x2 trunk deck z=[-8..-6], y=9
        b.place("2431", "red", x=0, y=10, z=-6.5, yaw=0, tag="rear_trunk_tile")
        b.place("3069b", "red", x=0, y=10, z=-7.5, yaw=0, tag="rear_trunk_tile")

        # Iconic Black-and-Red GT Rear Wing Spoiler on twin black struts (100% locked with 8-wide 3460 blade!)
        b.place_sym("3005", "black", x=1.5, y=10, z=-7.5, tag="wing_strut")          # twin 1x1 black wing struts y=10..13
        b.place("3460", "black", x=0, y=13, z=-7.5, yaw=0, tag="wing_blade")         # full 1x8 black wing spar x=[-4..+4]!
        b.place("6636", "black", x=0, y=14, z=-7.5, yaw=0, tag="wing_blade_top")     # smooth 1x6 black wing tile x=[-3..+3]
        # Red wing endplates mounted directly onto the outer studs (x=±3.5, z=-7.5) of the 1x8 wing spar!
        b.place_sym("11477", "red", x=3.5, y=14, z=-7.0, yaw=0, tag="wing_endplate") # stud at z=-7.5 locks onto 3460!
        b.place_sym("3024", "red", x=3.5, y=12, z=-7.5, tag="wing_endplate")         # lower red endplate fin hanging cleanly under wing!

        rep = b.validate()
        ldr = b.save_ldr(out_dir / "speed_champions_gt.ldr")
        png = b.render_sheet(out_dir / "speed_champions_gt.png", size=384, ref_image=ref_image)
        print("SPEED CHAMPIONS GT:\n" + rep.summary(), flush=True)
        return {"name": "speed_champions_gt", "ldr": str(ldr), "png": str(png), "ok": rep.check.certified, "pieces": rep.check.pieces}


def build_medieval_watchtower(out_dir: Path = OUT_DIR) -> dict:
    """Medieval Stone Castle Watchtower with embossed masonry, arched gate, recessed windows, corbeled battlements & banner."""
    prompt = (
        "A detailed medieval gray stone LEGO castle watchtower on a dark green and gray base with an arched doorway, "
        "embossed stone masonry walls, corner buttresses, recessed dark windows, glowing wall torches, "
        "corbeled dark gray battlements with crenellations, a sloped dark red gable roof turret, and a red castle banner."
    )
    with BrickBuild("Medieval Stone Watchtower", prompt=prompt) as b:
        # ---- 1. Interlocking Grounded Foundation & Green Turf Courtyard (8x12!) ----
        b.step("foundation")
        # Three 8x4 plates along Z (z=[-6..-2], [-2..+2], [+2..+6]) so the 8x6 keep walls (z=[-3..+3]) naturally lock all 3 together!
        b.place("3035", "dark_green", x=0, y=0, z=4.0, yaw=0, tag="turf")            # front courtyard z=[2..6]
        b.place("3035", "dark_bluish_gray", x=0, y=0, z=0.0, yaw=0, tag="base")      # center keep floor z=[-2..+2]
        b.place("3035", "dark_green", x=0, y=0, z=-4.0, yaw=0, tag="turf")           # rear courtyard z=[-6..-2]
        # Cobblestone entry path + outer corner buttress plinths (strictly outside z=[-3..3]!)
        b.place("3068b", "light_bluish_gray", x=0, y=1, z=4.0, tag="path")           # z=[3..5], x=[-1..1]
        b.place("3069b", "dark_bluish_gray", x=0, y=1, z=5.5, yaw=0, tag="path")     # z=[5..6], x=[-1..1]
        b.place_sym("3022", "dark_bluish_gray", x=3.0, y=1, z=4.0, tag="buttress")   # 2x2 front outer corner plinths x=[2..4], z=[3..5]
        b.place_sym("3022", "dark_bluish_gray", x=3.0, y=1, z=-4.0, tag="buttress")  # 2x2 rear outer corner plinths  x=[2..4], z=[-5..-3]
        b.place("3031", "light_bluish_gray", x=0, y=1, z=0, tag="tower_floor")       # 4x4 interior stone floor x=[-2..2], z=[-2..2]

        # ---- 2. Lower Keep Walls & Arched Front Gate (y = 1..8 plates) ----
        b.step("lower_keep_and_gate")
        # 8x6 keep walls on x=[-4..4], z=[-3..3] with embossed masonry bricks (98283)
        for y in (1, 4):
            b.place_sym("98283", "light_bluish_gray", x=3.0, y=y, z=2.5, yaw=0, tag="wall_f")   # x=[2..4], z=[2..3]
            b.place_sym("98283", "light_bluish_gray", x=3.0, y=y, z=-2.5, yaw=0, tag="wall_b")  # x=[2..4], z=[-3..-2]
            b.place("3010", "light_bluish_gray", x=0, y=y, z=-2.5, yaw=0, tag="wall_b")         # solid 1x4 back wall
            b.place_sym("98283", "light_bluish_gray", x=3.5, y=y, z=1.0, yaw=90, tag="wall_s")  # x=[3..4], z=[0..2]
            b.place_sym("98283", "light_bluish_gray", x=3.5, y=y, z=-1.0, yaw=90, tag="wall_s") # x=[3..4], z=[-2..0]
        # Sloped dark gray outer corner buttress stones (3040b: 1x2, high row toward tower, sloping outward)
        b.place_sym("3040b", "dark_bluish_gray", x=3.5, y=2, z=4.0, yaw=180, tag="buttress")    # x=[3..4], z=[3..5], slopes toward +Z
        b.place_sym("3040b", "dark_bluish_gray", x=3.5, y=2, z=-4.0, yaw=0, tag="buttress")     # x=[3..4], z=[-5..-3], slopes toward -Z
        b.place_sym("3070b", "dark_bluish_gray", x=3.5, y=5, z=3.5, tag="buttress_cap")         # crisp stone buttress cap
        b.place_sym("3070b", "dark_bluish_gray", x=3.5, y=5, z=-3.5, tag="buttress_cap")
        # Grand Stone Archway (6182, 1x4x2 = 6 plates tall!) over the entrance at y=1..7!
        b.place("6182", "dark_bluish_gray", x=0, y=1, z=2.5, yaw=0, tag="gate_arch")            # x=[-2..2], z=[2..3], y=1..7
        # Recessed wooden castle door inside the arch (reddish brown bricks at z=+1.5, resting on y=2 floor!)
        b.place("3004", "reddish_brown", x=0, y=2, z=1.5, yaw=0, tag="door")                    # x=[-1..1], z=[1..2], y=2..5
        b.place("3004", "reddish_brown", x=0, y=5, z=1.5, yaw=0, tag="door")                    # y=5..8
        # Glowing medieval gate braziers flanking the archway on the inner half of the front corner plinths (x=±2.5, z=3.5)!
        b.place_sym("3062b", "dark_bluish_gray", x=2.5, y=2, z=3.5, tag="torch_post")           # 1x1 round stone pedestal y=2..5
        b.place_sym("6141", "pearl_gold", x=2.5, y=5, z=3.5, tag="torch_sconce")                # gold brazier cup
        b.place_sym("6141", "trans_orange", x=2.5, y=6, z=3.5, tag="torch_flame")               # warm orange flame
        b.place_sym("54200", "trans_yellow", x=2.5, y=7, z=3.5, yaw=0, tag="torch_flame")       # bright yellow flame tip

        # Continuous interlocking dark gray stone belt course at y = 7..8 plates (binds all 4 walls!)
        b.place("3710", "dark_bluish_gray", x=-2.0, y=7, z=2.5, yaw=0, tag="belt")
        b.place("3710", "dark_bluish_gray", x=2.0, y=7, z=2.5, yaw=0, tag="belt")
        b.place("3710", "dark_bluish_gray", x=-2.0, y=7, z=-2.5, yaw=0, tag="belt")
        b.place("3710", "dark_bluish_gray", x=2.0, y=7, z=-2.5, yaw=0, tag="belt")
        b.place_sym("3710", "dark_bluish_gray", x=3.5, y=7, z=0, yaw=90, tag="belt")

        # ---- 3. Upper Watchtower Shaft with Recessed Candlelit Windows (y = 8..21 plates) ----
        b.step("upper_tower_shaft")
        b.place("3036", "light_bluish_gray", x=0, y=8, z=0, yaw=0, tag="deck2")                 # 8x6 full tying slab!
        b.place_sym("6636", "dark_bluish_gray", x=3.5, y=9, z=0, yaw=90, tag="cornice")         # smooth stone cornice rim

        # 6x6 Tower Shaft (x=[-3..+3], z=[-3..+3]) rising from y = 9 to y = 21 plates (4 brick courses!)
        for course_i, y in enumerate((9, 12, 15, 18)):
            if course_i in (1, 2):
                b.place_sym("98283", "light_bluish_gray", x=2.0, y=y, z=2.5, yaw=0, tag="shaft")
                b.place_sym("98283", "light_bluish_gray", x=2.0, y=y, z=-2.5, yaw=0, tag="shaft")
                b.place("98283", "light_bluish_gray", x=0, y=y, z=-2.5, yaw=0, tag="shaft")
                b.place_sym("3005", "dark_bluish_gray", x=2.5, y=y, z=1.5, tag="shaft")
                b.place_sym("3005", "dark_bluish_gray", x=2.5, y=y, z=-1.5, tag="shaft")
            else:
                b.place("3009", "light_bluish_gray", x=0, y=y, z=2.5, yaw=0, tag="shaft")
                b.place("3009", "light_bluish_gray", x=0, y=y, z=-2.5, yaw=0, tag="shaft")
                b.place_sym("3010", "light_bluish_gray", x=2.5, y=y, z=0, yaw=90, tag="shaft")
        # Real framed glass windows (60592 + 60601) in Front & Side openings at y = 12..18!
        wf = b.place("60592", "black", x=0, y=12, z=2.5, yaw=0, tag="win_f")
        b.snap("60601", "trans_yellow", on=wf, near=(0, 15, 2.5), kind="non_stud", tag="glass")
        ws1, ws2 = b.place_sym("60592", "black", x=2.5, y=12, z=0, yaw=90, tag="win_s")
        b.snap("60601", "trans_yellow", on=ws1, near=(2.5, 15, 0), kind="non_stud", tag="glass", mirror_x=True)

        # ---- 4. Corbeled Crenellated Battlements (y = 21..32 plates) ----
        b.step("corbeled_battlements")
        # Inverted 45° stone corbel slopes flaring outward from 6x6 shaft out to 8x8 battlements!
        b.place_sym("3665", "dark_bluish_gray", x=2.5, y=21, z=3.0, yaw=180, tag="corbel")      # front outer corbels
        b.place_sym("3660", "dark_bluish_gray", x=1.0, y=21, z=3.0, yaw=180, tag="corbel")      # front center corbels
        b.place_sym("3665", "dark_bluish_gray", x=2.5, y=21, z=-3.0, yaw=0, tag="corbel")       # rear outer corbels
        b.place_sym("3660", "dark_bluish_gray", x=1.0, y=21, z=-3.0, yaw=0, tag="corbel")       # rear center corbels
        b.place_sym("3665", "dark_bluish_gray", x=3.0, y=21, z=1.5, yaw=270, tag="corbel")      # side corbels (+X/-X)
        b.place_sym("3665", "dark_bluish_gray", x=3.0, y=21, z=-1.5, yaw=270, tag="corbel")
        b.place_sym("3660", "dark_bluish_gray", x=3.0, y=21, z=0.0, yaw=270, tag="corbel")
        # 8x8 Battlement parapet deck at y = 24 plates!
        b.place("3035", "dark_bluish_gray", x=0, y=24, z=2.0, yaw=0, tag="parapet_deck")
        b.place("3035", "dark_bluish_gray", x=0, y=24, z=-2.0, yaw=0, tag="parapet_deck")

        # Raised crenellated parapet walls with symmetric LEGO merlons + smooth dark gray cap tiles!
        b.place("3008", "light_bluish_gray", x=0, y=25, z=3.5, yaw=0, tag="parapet")            # 1x8 front
        b.place("3008", "light_bluish_gray", x=0, y=25, z=-3.5, yaw=0, tag="parapet")           # 1x8 back
        b.place_sym("3009", "light_bluish_gray", x=3.5, y=25, z=0, yaw=90, tag="parapet")       # 1x6 sides
        for mx, mz in [(3.5, 3.5), (3.5, 1.5), (3.5, -1.5), (3.5, -3.5), (1.5, 3.5), (1.5, -3.5)]:
            b.place_sym("3005", "light_bluish_gray", x=mx, y=28, z=mz, tag="merlon")
            b.place_sym("3070b", "dark_bluish_gray", x=mx, y=31, z=mz, tag="merlon_cap")

        # ---- 5. Dark Red Medieval Gable Roof Turret & Crimson Banner ----
        b.step("roof_and_banner")
        b.place("3001", "dark_bluish_gray", x=0, y=25, z=1.0, yaw=0, tag="turret")              # 4x2 inner turret
        b.place("3001", "dark_bluish_gray", x=0, y=25, z=-1.0, yaw=0, tag="turret")
        # Pitched dark-red medieval gable roof (3037 high edge at z=0, sloping down toward +Z and -Z!)
        b.place("3037", "dark_red", x=0, y=28, z=1.0, yaw=180, tag="roof")
        b.place("3037", "dark_red", x=0, y=28, z=-1.0, yaw=0, tag="roof")
        for rx in (-1.5, -0.5, 0.5, 1.5):
            b.place("3044c", "dark_red", x=rx, y=31, z=0, yaw=0, tag="roof_ridge")
        # Tall pearl-gold flagpole with waving crimson castle banner!
        pole = b.place("3957", "pearl_gold", x=3.5, y=28, z=-0.5, tag="flagpole")
        b.snap("4495", "red", on=pole, near=(4.5, 36, -0.5), kind="non_stud", tag="banner")

        rep = b.validate()
        ldr = b.save_ldr(out_dir / "medieval_watchtower.ldr")
        png = b.render_sheet(out_dir / "medieval_watchtower.png", size=384)
        print("MEDIEVAL WATCHTOWER:\n" + rep.summary(), flush=True)
        return {"name": "medieval_watchtower", "ldr": str(ldr), "png": str(png), "ok": rep.check.certified, "pieces": rep.check.pieces}


def build_brickheadz_hero(out_dir: Path = OUT_DIR) -> dict:
    """Collectible BrickHeadz Superhero built with authentic LEGO BrickHeadz SNOT (`22885`) architecture."""
    prompt = (
        "A LEGO BrickHeadz collectible superhero character figure on a black 4x6 display stand, with dark blue suit, "
        "yellow utility belt, red boots, side arms, oversized square BrickHeadz head with iconic black round eyes, "
        "sculpted dark brown curved-slope hair, and a flowing red cape."
    )
    with BrickBuild("BrickHeadz Classic Hero", prompt=prompt) as b:
        # ---- 1. Iconic Black 4x6 BrickHeadz Display Stand (y = 0..2 plates) ----
        b.step("display_stand")
        b.place("3032", "black", x=0, y=0, z=0, yaw=0, tag="stand")                  # 6x4 black plate x=[-3..3], z=[-2..2]
        b.place("3031", "black", x=0, y=1, z=0, yaw=0, tag="stand_top")              # 4x4 center riser
        b.place_sym("2431", "black", x=2.5, y=1, z=0, yaw=90, tag="stand_tile")      # smooth tiled stand side borders!
        b.place("2431", "black", x=0, y=2, z=1.5, yaw=0, tag="stand_tile")           # front tile edge
        b.place("2431", "black", x=0, y=2, z=-1.5, yaw=0, tag="stand_tile")          # rear tile edge

        # ---- 2. Red Boots & Blue Legs (y = 2..6 plates; 1x2 boots at half-integer x=±1.5!) ----
        b.step("boots_and_legs")
        b.place_sym("3023", "red", x=1.5, y=2, z=0, yaw=90, tag="boots")             # 1x2 red boots x=[±1..±2], z=[-1..+1]
        b.place_sym("3023", "red", x=1.5, y=3, z=0, yaw=90, tag="boots")             # boot height 2 plates
        b.place_sym("3023", "blue", x=1.5, y=4, z=0, yaw=90, tag="legs")             # 1x2 blue pants
        b.place("3020", "blue", x=0, y=5, z=0, yaw=0, tag="hips")                    # 4x2 blue pelvis tying both legs!

        # ---- 3. Superhero Torso, Yellow Belt, SNOT Chest Crest, Side Arms & Red Cape (y = 6..12 plates) ----
        b.step("torso_arms_and_cape")
        b.place("3020", "yellow", x=0, y=6, z=0, yaw=0, tag="belt")                  # bright yellow utility belt!
        # Blue chest with embedded 87087 SNOT bricks on front center (x=±0.5, z=+0.5) for iconic red/yellow chest crest!
        b.place("3010", "blue", x=0, y=7, z=-0.5, yaw=0, tag="torso")                # 4x1 back torso y=7..10
        b.place_sym("3005", "blue", x=1.5, y=7, z=0.5, tag="torso")                  # outer front chest pillars
        b.place_sym("87087", "blue", x=0.5, y=7, z=0.5, yaw=180, tag="snot_chest")   # front chest SNOT studs (+Z)!
        b.snap("3069b", "red", on="snot_chest", near=(0, 8.5, 1.5), studs_dir="+z", tag="chest_crest")  # red superhero emblem!
        b.place("3020", "blue", x=0, y=10, z=0, yaw=0, tag="shoulders")              # 4x2 shoulders y=10..11
        # Shoulder bar (6x1 at z=+0.5, half-integer!) + Red cape collar (4x2 at z=-1.0 -> z=[-2..0])
        b.place("3666", "blue", x=0, y=11, z=0.5, yaw=0, tag="shoulder_bar")         # x=[-3..+3], z=[0..+1]
        b.place("3020", "red", x=0, y=11, z=-1.0, yaw=0, tag="cape_collar")          # x=[-2..+2], z=[-2..0]
        # Hanging BrickHeadz arms (at x=±2.5, z=0.5, hanging cleanly from shoulder_bar y=11 down to y=7!)
        b.place_sym("3024", "blue", x=2.5, y=10, z=0.5, tag="arm")                   # upper sleeve
        b.place_sym("3024", "blue", x=2.5, y=9, z=0.5, tag="arm")
        b.place_sym("3024", "red", x=2.5, y=8, z=0.5, tag="glove")                   # red superhero gauntlet
        b.place_sym("3024", "light_nougat", x=2.5, y=7, z=0.5, tag="hand")           # hand!
        # Flowing Red Cape hanging cleanly under cape_collar (z=[-2..-1] top studs, flaring toward -Z!)
        b.place_sym("3039", "red", x=1.0, y=8, z=-2.0, yaw=0, tag="cape")            # upper cape slopes z=[-3..-1], y=8..11
        b.place_sym("3039", "red", x=1.0, y=5, z=-2.0, yaw=0, tag="cape")            # lower cape slopes z=[-3..-1], y=5..8

        # ---- 4. Iconic Oversized BrickHeadz SNOT Head Core (`22885`, y = 12..22 plates) ----
        b.step("snot_head_core")
        b.place("3031", "light_nougat", x=0, y=12, z=0, yaw=0, tag="chin")           # 4x4 chin plate y=12..13!
        # Authentic LEGO BrickHeadz core: 22885 (1x2x1.667 SNOT bricks, 5 plates tall -> y=13..18!) facing ALL 4 sides!
        b.place_sym("22885", "light_nougat", x=1.0, y=13, z=1.5, yaw=180, tag="snot_front")   # studs face +Z!
        b.place_sym("22885", "dark_brown", x=1.0, y=13, z=-1.5, yaw=0, tag="snot_back")       # studs face -Z!
        b.place_sym("22885", "dark_brown", x=1.5, y=13, z=0.0, yaw=270, tag="snot_side")      # studs face +X / -X!
        # Iconic BrickHeadz Easter-egg pink brain inside the 2x2 hollow core!
        b.place("3003", "dark_pink", x=0, y=13, z=0, yaw=0, tag="brain")
        b.place("3022", "dark_pink", x=0, y=16, z=0, yaw=0, tag="brain")
        b.place("3022", "dark_pink", x=0, y=17, z=0, yaw=0, tag="brain")
        # Upper head tie plate (4x4 at y = 18..19) + SNOT upper brow/hair band (y = 19..22)!
        b.place("3031", "dark_brown", x=0, y=18, z=0, yaw=0, tag="head_tie")
        b.place("3001", "dark_brown", x=0, y=19, z=-1.0, yaw=0, tag="head_upper")
        b.place("3010", "dark_brown", x=0, y=19, z=0.5, yaw=0, tag="head_upper")
        # Front upper forehead SNOT bricks (4x 87087 with studs facing +Z -> yaw=180) so dark-brown bangs frame the face!
        for bx in (-1.5, -0.5, 0.5, 1.5):
            b.place("87087", "dark_brown", x=bx, y=19, z=1.5, yaw=180, tag="snot_brow")

        # ---- 5. Front Face Tiles, Iconic Black Round Eyes (`98138`), & Side Hair Panels (SNOT!) ----
        b.step("face_and_eyes")
        face_bot = b.snap("3710", "light_nougat", on="snot_front", near=(0, 14.0, 2.5), studs_dir="+z", tag="face")
        face_mid = b.snap("3710", "light_nougat", on="snot_front", near=(0, 16.5, 2.5), studs_dir="+z", tag="face")
        # Iconic BrickHeadz 1x1 Round Black Eyes (`98138`) snapped cleanly onto `face_mid` at x=±1.5!
        b.snap("98138", "black", on=face_mid, near=(1.5, 16.5, 3.0), studs_dir="+z", tag="eyes", mirror_x=True)
        # Smooth forehead/cheek tiles between eyes & across chin!
        b.snap("3069b", "light_nougat", on=face_mid, near=(0.0, 16.5, 3.0), studs_dir="+z", tag="face_tile")
        b.snap("2431", "light_nougat", on=face_bot, near=(0.0, 14.0, 3.0), studs_dir="+z", tag="face_tile")
        # Crisp SNOT superhero bangs framing the forehead (+Z) right above the eyes!
        brow_p = b.snap("3710", "dark_brown", on="snot_brow", near=(0, 20.5, 2.5), studs_dir="+z", tag="hair_brow")
        b.snap("2431", "dark_brown", on=brow_p, near=(0, 20.5, 3.0), studs_dir="+z", tag="hair_brow_tile")

        # Side & Back Hair Tiles snapped cleanly onto SNOT side/back studs!
        b.snap("3020", "dark_brown", on="snot_back", near=(0, 15.5, -2.5), studs_dir="-z", tag="hair_back")
        b.snap("87079", "dark_brown", on="hair_back", near=(0, 15.5, -3.0), studs_dir="-z", tag="hair_back_tile")
        b.snap("3022", "dark_brown", on="snot_side", near=(2.5, 15.5, 0), studs_dir="+x", tag="hair_side", mirror_x=True)
        b.snap("3068b", "dark_brown", on="hair_side", near=(3.0, 15.5, 0), studs_dir="+x", tag="hair_side_tile", mirror_x=True)

        # ---- 6. Sculpted Curved-Slope Hair Crown (y = 22..25 plates) ----
        b.step("sculpted_hair_crown")
        b.place("3031", "dark_brown", x=0, y=22, z=0, yaw=0, tag="hair_crown")
        # Seamless domed curved-slope hair crown (yaw=180 slopes down toward +Z forehead, yaw=0 slopes down toward -Z back!)
        b.place("15068", "dark_brown", x=-1.0, y=23, z=1.0, yaw=180, tag="hair_bangs")
        b.place("11477", "dark_brown", x=0.5, y=23, z=1.0, yaw=180, tag="hair_bangs")
        b.place("11477", "dark_brown", x=1.5, y=23, z=1.0, yaw=180, tag="hair_bangs")
        b.place("15068", "dark_brown", x=-1.0, y=23, z=-1.0, yaw=0, tag="hair_top")
        b.place("15068", "dark_brown", x=1.0, y=23, z=-1.0, yaw=0, tag="hair_top")

        rep = b.validate()
        ldr = b.save_ldr(out_dir / "brickheadz_hero.ldr")
        png = b.render_sheet(out_dir / "brickheadz_hero.png", size=384)
        print("BRICKHEADZ HERO:\n" + rep.summary(), flush=True)
        return {"name": "brickheadz_hero", "ldr": str(ldr), "png": str(png), "ok": rep.check.certified, "pieces": rep.check.pieces}


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ref_car = OUT_DIR / "ref_sports_car.jpg"
    results = []
    for fn, kw in [
        (build_speed_champions_gt, {"ref_image": ref_car if ref_car.exists() else None}),
        (build_medieval_watchtower, {}),
        (build_brickheadz_hero, {}),
    ]:
        try:
            results.append(fn(OUT_DIR, **kw))
        except Exception as exc:
            print(f"ERROR in {fn.__name__}: {exc}", flush=True)
    print("\nSummary:", results, flush=True)


if __name__ == "__main__":
    main()
