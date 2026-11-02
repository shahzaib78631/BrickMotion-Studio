"""Character specification for the procedural BrickHeadz generator.

A spec is the small, human-meaningful bundle of choices that seed a figure:
dimensions, colours, hair and face style. `from_grammar` samples one from the
Phase-1 corpus grammar so "free generation" stays inside the learned distribution.
"""
from __future__ import annotations

import random
from dataclasses import asdict, dataclass

# A handful of common LDraw colour codes (see LDConfig.ldr).
SKIN = [14, 15, 19, 28, 70, 78, 92, 366, 283]  # yellow, white, tan, ... light nougat
BODY = [0, 4, 1, 2, 5, 14, 71, 72, 25, 191, 320, 28]
HAIR = [0, 70, 19, 28, 25, 2, 4, 71, 320, 384]
ACCENT = [0, 71, 72, 15, 4]


@dataclass
class Spec:
    name: str = "BrickHeadz"
    head: int = 4  # head footprint, studs
    body: int = 4  # body footprint, studs
    body_h: int = 12  # body height, plates
    head_courses: int = 3  # 5-plate SNOT courses (head height = 2 + 5*courses)
    leg_h: int = 2  # leg/foot height, plates
    base: bool = True
    hair: str = "flat"  # none | flat | cap
    eyes: str = "round"  # round | none
    color_head: int = 14
    color_body: int = 1
    color_leg: int = 1
    color_hair: int = 0
    color_eye: int = 0
    color_base: int = 0
    color_accent: int = 71
    color_face: int = -1  # head front panel (e.g. a silver faceplate inside a hood); -1 = same as head
    seed: int = 0
    # Descriptive design notes (recorded; used by later phases / the vision step).
    headwear_name: str = ""
    face_notes: str = ""
    prop_name: str = ""
    # Optional accent bands (LDraw colour codes; -1 = none). A thin collar plate at
    # the top of the torso, a thin belt plate at the bottom, and a small 1x1 hair
    # clip mounted on the head's front studs.
    trim_collar: int = -1
    trim_belt: int = -1
    trim_clip: int = -1
    # A vertical colour stripe down the centre of the torso's front face.
    trim_center: int = -1
    trim_center_width: int = 2
    # Small side arms/hands (e.g. trans-green energy claws) and a back cape panel.
    trim_arm: int = -1
    prop_cape: int = -1

    def to_dict(self) -> dict:
        return asdict(self)


def random_spec(rng: random.Random, name: str = "BrickHeadz") -> Spec:
    head = 6 if rng.random() < 0.2 else 4
    return Spec(
        name=name,
        head=head,
        body=4,
        body_h=rng.choice([9, 12, 12, 15]),
        head_courses=3 if head == 6 else rng.choice([3, 3, 4]),
        leg_h=rng.choice([0, 2, 2, 3]),
        base=True,
        hair=rng.choice(["none", "flat", "flat", "cap"]),
        eyes="round",
        color_head=rng.choice(SKIN),
        color_body=rng.choice(BODY),
        color_leg=rng.choice(BODY),
        color_hair=rng.choice(HAIR),
        color_eye=rng.choice([0, 0, 0, 71]),
        color_base=rng.choice([0, 0, 71]),
        color_accent=rng.choice(ACCENT),
        seed=rng.randrange(1 << 30),
    )
