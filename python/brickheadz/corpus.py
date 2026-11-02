"""Corpus discovery: find the BrickHeadz MPDs and their provenance metadata."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass

DEFAULT_CORPUS = os.path.join("..", "dist", "ldraw_brickheadz")


@dataclass
class CorpusModel:
    path: str
    id: str
    name: str
    source: dict


def _manifest(corpus: str) -> dict[str, dict]:
    path = os.path.join(corpus, "download_manifest.json")
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        raw = json.load(f)
    return {str(m.get("relative_path", "")): m for m in raw.get("models", [])}


def discover(corpus: str = DEFAULT_CORPUS) -> list[CorpusModel]:
    """All downloaded, readable .mpd models in a corpus directory, sorted by id."""
    if not os.path.isdir(corpus):
        raise FileNotFoundError(f"corpus directory not found: {corpus}")
    meta = _manifest(corpus)
    out: list[CorpusModel] = []
    for name in sorted(os.listdir(corpus)):
        if not name.lower().endswith(".mpd") or name.startswith("."):
            continue
        path = os.path.join(corpus, name)
        m = meta.get(name, {})
        set_no = str(m.get("set_number") or name.split(" - ")[0].split(".")[0]).strip()
        title = m.get("name") or name
        source = {
            "file": path,
            "set": set_no,
            "author": m.get("author"),
            "license": m.get("license"),
            "sha256": m.get("sha256"),
            "theme": m.get("theme", "Brickheadz"),
            "url": m.get("downloaded_from"),
        }
        out.append(CorpusModel(path=path, id=set_no, name=_title(name, title), source=source))
    return out


def _title(file_name: str, manifest_name: str) -> str:
    base = file_name.rsplit(".", 1)[0]
    if " - " in base:
        base = base.split(" - ", 1)[1]
    return base.strip() or manifest_name
