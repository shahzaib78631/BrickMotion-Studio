"""Pair booklet PDFs with OMR answer keys and assign a deterministic split."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Pair:
    set_number: str
    booklet: str
    pdf: Path
    omr: Path
    split: str


def split_of(set_number: str) -> str:
    """Whole-set split: 70% train, 20% validation, 10% test, stable across runs."""
    bucket = int(hashlib.sha256(set_number.encode()).hexdigest(), 16) % 10
    return "train" if bucket < 7 else "validation" if bucket < 9 else "test"


def _omr_file(omr_dir: Path, set_number: str) -> Path | None:
    folder = omr_dir / f"{set_number}-1"
    main = folder / f"{set_number}-1.mpd"
    if main.is_file():
        return main
    found = sorted(folder.glob("*.mpd")) if folder.is_dir() else []
    return found[0] if found else None


def find_pairs(sources_json: Path, omr_dir: Path, root: Path) -> tuple[list[Pair], list[dict]]:
    entries = json.loads(Path(sources_json).read_text())["booklets"]
    pairs: list[Pair] = []
    skips: list[dict] = []
    for entry in entries:
        set_number = entry["set"]
        omr = _omr_file(Path(omr_dir), set_number)
        if omr is None:
            skips.append({"set": set_number, "reason": "no OMR model"})
            continue
        pdf = Path(root) / entry["path"]
        if not pdf.is_file():
            skips.append({"set": set_number, "reason": "PDF missing"})
            continue
        pairs.append(Pair(set_number, str(entry["booklet"]), pdf, omr, split_of(set_number)))
    return pairs, skips
