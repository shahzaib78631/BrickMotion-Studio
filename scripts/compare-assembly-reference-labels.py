"""Index exact-ID BrickNet labels alongside shadow presence and assembly evidence."""
import hashlib
import json
import lzma
import math
import sys
from collections import Counter
from pathlib import Path


def label_rows(part):
    for kind, groups in part.items():
        for group, value in groups.items():
            polarized = value.items() if kind in {"fixed", "hinge", "ball"} else [(None, value)]
            for polarity, rows in polarized:
                for row in rows:
                    yield {"kind": kind, "group": group, "polarity": polarity, "values": row}


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def compare(directory, labels_path):
    snapshot = json.loads((directory / "assembly-use-cases.json").read_text())
    inventory = json.loads((directory / "coverage.json").read_text())
    if snapshot["inventoryHash"] != inventory["inventoryHash"]:
        raise ValueError("Assembly report belongs to a different frozen inventory")
    counts = {}
    with (directory / "reference-library.jsonl").open() as stream:
        for line in stream:
            row = json.loads(line)
            if row["id"] in counts:
                raise ValueError(f"Duplicate shadow export row: {row['id']}")
            counts[row["id"]] = len(row["connectors"])
    frozen = {part["id"]: part for part in inventory["parts"]}
    if set(counts) != set(frozen):
        raise ValueError("Shadow export does not match the frozen inventory")

    raw = labels_path.read_bytes()
    catalog = json.loads(lzma.decompress(raw))
    labels = {key[:-4]: list(label_rows(part)) for key, part in catalog.items()
              if key.endswith(".dat") and key[:-4] in frozen}
    supplemental = []
    for part, rows in sorted(labels.items()):
        if not rows or counts[part]:
            continue
        supplemental.append({"id": part, "description": frozen[part].get("description"),
                             "status": "exact-id-reference-candidate", "labelCount": len(rows),
                             "families": dict(Counter(row["kind"] for row in rows))})

    agreements = []
    for pair in snapshot["documented"]:
        if pair["mirrored"] or pair["evidence"] != "part-author-placement":
            continue
        host, insert = pair["host"], pair["resolvedInsert"]
        m, pos = pair["seat"]["m"], pair["seat"]["pos"]
        matches = []
        for a in labels.get(host, []):
            if not a["polarity"]:
                continue
            for b in labels.get(insert, []):
                if not b["polarity"] or a["polarity"] == b["polarity"]:
                    continue
                if (a["kind"], a["group"]) != (b["kind"], b["group"]):
                    continue
                placed = [pos[i] + sum(m[i * 3 + j] * b["values"][j] for j in range(3)) for i in range(3)]
                distance = math.dist(placed, a["values"][:3])
                if distance <= 1:
                    matches.append({"kind": a["kind"], "group": a["group"], "hostLabel": a["values"],
                                    "insertLabel": b["values"], "originDistanceLdu": distance})
        if matches:
            agreements.append({"host": host, "insert": insert, "kind": pair["kind"],
                               "sourceLine": pair["source"]["line"], "matches": matches})
    summary = {"catalogParts": len(catalog), "exactIdPartsInInventory": len(labels),
               "exactIdPartsWithLabels": sum(bool(rows) for rows in labels.values()),
               "partsWithLabelsAndZeroShadowConnectors": len(supplemental),
               "labelsOnPartsWithZeroShadowConnectors": sum(part["labelCount"] for part in supplemental),
               "documentedPosesWithSameGroupOriginAgreement": len(agreements)}
    result = {"format": "brickmotion-reference-label-comparison", "version": 1, "fullCoverage": False,
              "inventoryHash": inventory["inventoryHash"], "summary": summary, "source": {
                  "name": "BrickNet catalog v1 (Peter Kulits and Cordelia Schmid, CVPR 2026)",
                  "url": "https://github.com/kulits/BrickNet/blob/master/DATA.md",
                  "sha256": hashlib.sha256(raw).hexdigest(),
              }, "supplementalQueue": supplemental, "originAgreements": agreements,
              "limits": ["Exact LDraw IDs are compared without alias transfer. CAD revision equivalence is unverified.",
                         "Agreement checks complementary group and origin only. Roll, axes, clearance and motion remain unverified.",
                         "A positive label count does not certify that every interface is present."]}
    write_json(directory / "assembly-reference-label-comparison.json", result)
    geometry_path = directory / "assembly-reference-label-geometry.json"
    geometry_summary = None
    if geometry_path.is_file():
        geometry = json.loads(geometry_path.read_text())
        if (geometry["labelsSha256"] != result["source"]["sha256"] or
                geometry["inventoryHash"] != inventory["inventoryHash"]):
            raise ValueError("Geometry comparison belongs to different labels or CAD inventory")
        queue = {part["id"]: part for part in supplemental}
        if {part["id"] for part in geometry["parts"]} != set(queue):
            raise ValueError("Geometry comparison does not cover the supplemental queue")
        candidates = []
        for part in geometry["parts"]:
            identifier = part["id"]
            if part["status"] != "same-geometry-and-frame":
                continue
            candidates.append({
                **queue[identifier], "status": "geometry-matched-reference-candidate",
                "geometrySignature": part["frozenSignature"], "labels": labels[identifier],
            })
        geometry_summary = {"summary": geometry["summary"], "referenceSnapshot": geometry["referenceSnapshot"]}
        write_json(directory / "assembly-geometry-matched-labels.json", {
            "format": "brickmotion-geometry-matched-reference-labels",
            "version": 1, "units": "LDU", "fullCoverage": False,
            "inventoryHash": inventory["inventoryHash"], "source": result["source"],
            **geometry_summary, "parts": candidates,
            "limits": [geometry["limitation"]],
        })
    curated = {
        "format": "brickmotion-assembly-use-case-measurements",
        "version": 1,
        "units": "LDU",
        "fullCoverage": False,
        "inventoryHash": snapshot["inventoryHash"],
        "assemblySummary": snapshot["summary"],
        "referenceSummary": summary,
        "referenceGeometryComparison": geometry_summary,
        "modelCorpus": snapshot["corpus"],
        "catalogSource": result["source"],
        "documentedPlacements": snapshot["documented"],
        "targetedModelCandidates": [pair for pair in snapshot["modelCandidates"] if pair["kind"] != "nearby-surfaces"],
        "originAgreements": agreements,
        "instructionEvidence": snapshot["instructionEvidence"],
        "targetPairsWithoutModelCandidates": snapshot["targetPairsWithoutModelCandidates"],
        "limits": snapshot["limits"] + result["limits"],
    }
    write_json(directory / "assembly-use-case-measurements.json", curated)
    return result


if __name__ == "__main__":
    directory = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".cache/measurements")
    labels_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("python/knowledge/bricknet/labels.json.xz")
    print(json.dumps(compare(directory, labels_path)["summary"]))
