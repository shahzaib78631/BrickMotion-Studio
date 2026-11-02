"""BrickHeadz dataset intelligence (Phase 1 of the generative construction engine).

Turns the official OMR BrickHeadz MPD corpus into a structured dataset
(per-model records) plus a derived construction grammar. Pure extraction and
analysis: no synthesis, no learned model.
"""
from brickheadz.dat import Piece, load_pieces, parse_part_name
from brickheadz.schema import GRAMMAR_SCHEMA, RECORD_SCHEMA, ModelRecord

__all__ = [
    "Piece",
    "load_pieces",
    "parse_part_name",
    "ModelRecord",
    "RECORD_SCHEMA",
    "GRAMMAR_SCHEMA",
]
