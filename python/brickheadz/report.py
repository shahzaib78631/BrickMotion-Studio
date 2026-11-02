"""Aggregate the per-model records into the BrickHeadz construction grammar.

The grammar is the machine-readable bridge to the Phase-2 procedural generator:
canonical head/body/leg proportions, per-role part vocabulary, role-to-role
connection patterns, colour usage and a coverage/consistency report.
"""
from __future__ import annotations

import json

import numpy as np

from brickheadz.schema import GRAMMAR_SCHEMA

_LABELS = ("head", "face", "hair", "torso", "arms", "legs", "base")


def build_grammar(records: list[dict], source: str = "") -> dict:
    dims: dict[str, list[list[float]]] = {l: [] for l in _LABELS}
    part_by_role: dict[str, dict[str, int]] = {l: {} for l in _LABELS}
    pairs: dict[str, int] = {}
    colors: dict[int, int] = {}
    kinds: dict[str, int] = {}
    face_tiles: list[int] = []
    front_sides: dict[str, int] = {}
    totals: list[list[float]] = []
    heads_detected = 0
    faces_detected = 0
    warnings: list[str] = []

    for r in records:
        by_key = {p["key"]: p for p in r["pieces"]}
        for c in r["components"]:
            if c["figure"] != 0:
                continue
            label = c["label"]
            if label in dims and label != "head":
                d = c["dims"]
                dims[label].append([d["wStuds"], d["dStuds"], d["hPlates"]])
        if r["figures"] and r["figures"][0].get("headCube"):
            hc = r["figures"][0]["headCube"]
            dims["head"].append([hc["wStuds"], hc["dStuds"], hc["hPlates"]])
        for p in r["pieces"]:
            if p["figure"] == 0 and p["component"] in part_by_role:
                role = p["component"]
                part_by_role[role][p["basePart"]] = part_by_role[role].get(p["basePart"], 0) + 1
            colors[p["color"]] = colors.get(p["color"], 0) + 1
        for conn in r["connections"]:
            a = by_key.get(conn["a"], {}).get("component", "?")
            b = by_key.get(conn["b"], {}).get("component", "?")
            key = " | ".join(sorted([a, b]))
            pairs[key] = pairs.get(key, 0) + 1
            kinds[conn["kind"]] = kinds.get(conn["kind"], 0) + 1
        if r["figures"] and r["figures"][0]["roles"].get("head"):
            heads_detected += 1
        face = r.get("face", {})
        if face.get("tiles"):
            faces_detected += 1
            face_tiles.append(face["tiles"])
        if face.get("side"):
            front_sides[face["side"]] = front_sides.get(face["side"], 0) + 1
        total = r["bbox"].get("dims", {})
        totals.append([total.get("wStuds", 0), total.get("dStuds", 0), total.get("hPlates", 0)])
        warnings.extend(r["warnings"])

    n = len(records)
    return {
        "schema": GRAMMAR_SCHEMA,
        "version": 1,
        "source": source,
        "models": n,
        "coverage": {
            "headDetected": heads_detected,
            "headRate": round(heads_detected / n, 3) if n else 0.0,
            "faceDetected": faces_detected,
            "faceRate": round(faces_detected / n, 3) if n else 0.0,
            "warningCount": len(warnings),
        },
        "template": {
            "total": _stats(totals),
            "head": _stats(dims["head"]),
            "torso": _stats(dims["torso"]),
            "legs": _stats(dims["legs"]),
            "arms": _stats(dims["arms"]),
            "hair": _stats(dims["hair"]),
            "face": _stats(dims["face"]),
            "base": _stats(dims["base"]),
        },
        "roles": {l: _top(part_by_role[l], 12) for l in _LABELS},
        "connections": {"kinds": _top(kinds, 12), "pairs": _top(pairs, 20)},
        "colors": _top(colors, 20),
        "face": {
            "meanTiles": round(float(np.mean(face_tiles)), 2) if face_tiles else 0.0,
            "frontSides": _top(front_sides, 4),
        },
        "warnings": warnings[:50],
    }


def _stats(rows: list[list[float]]) -> dict:
    if not rows:
        return {"n": 0}
    a = np.array(rows, dtype=float)
    med = np.median(a, axis=0)
    return {
        "n": len(rows),
        "mean": [round(float(v), 2) for v in a.mean(0)],
        "std": [round(float(v), 2) for v in a.std(0)],
        "median": [round(float(v), 2) for v in med],
        "min": [round(float(v), 2) for v in a.min(0)],
        "max": [round(float(v), 2) for v in a.max(0)],
    }


def _top(d: dict, k: int) -> list[list]:
    return [[a, b] for a, b in sorted(d.items(), key=lambda kv: (-kv[1], str(kv[0])))[:k]]


def render_markdown(grammar: dict, color_names: dict[int, str] | None = None) -> str:
    color_names = color_names or {}
    c = grammar["coverage"]
    lines = [
        "# BrickHeadz construction grammar",
        "",
        f"Derived from **{grammar['models']}** models ({grammar['source']}).",
        "",
        "## Coverage",
        f"- head detected: {c['headDetected']} ({c['headRate']:.0%})",
        f"- face detected: {c['faceDetected']} ({c['faceRate']:.0%})",
        f"- warnings: {c['warningCount']}",
        "",
        "## Canonical proportions (w x d studs, h plates)",
        "| part | median | mean | std | n |",
        "| --- | --- | --- | --- | --- |",
    ]
    for label, s in grammar["template"].items():
        if s.get("n"):
            lines.append(f"| {label} | {s['median']} | {s['mean']} | {s['std']} | {s['n']} |")
    lines += ["", "## Top parts per role", ""]
    for label, top in grammar["roles"].items():
        if top:
            lines.append(f"- **{label}**: " + ", ".join(f"{p}x{n}" for p, n in top[:8]))
    lines += ["", "## Connection kinds", ""]
    for k, n in grammar["connections"]["kinds"][:10]:
        lines.append(f"- {k}: {n}")
    lines += ["", "## Colours", ""]
    for code, n in grammar["colors"][:12]:
        lines.append(f"- {code} {color_names.get(code, '')}: {n}")
    lines += ["", "## Face", f"- mean front details: {grammar['face']['meanTiles']}", ""]
    return "\n".join(lines)


def write_json(grammar: dict, path: str) -> None:
    with open(path, "w") as f:
        json.dump(grammar, f, indent=1)
