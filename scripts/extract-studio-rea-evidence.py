#!/usr/bin/env python3
"""Produce readable, token-annotated CIL from an exported REA evidence bundle.

Reads evidence only; never loads or executes Studio assemblies. Token resolution
is isolated by artifact digest because metadata tokens are build-local.
"""
import argparse
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("out", type=Path)
    args = parser.parse_args()
    bundle = json.loads(args.bundle.read_text())
    artifacts = {}
    for record in bundle["records"]:
        if record["operation"] != "inspect_managed_members":
            continue
        result = record["normalized_result"]
        digest = result["artifact"]["sha256"]
        group = artifacts.setdefault(digest, {"records": [], "names": {}, "methods": {}})
        group["records"].append(record)
        names = group["names"]
        for collection in ("fields", "methods"):
            for row in result[collection]:
                names[row["token"]] = row["declaring_type"] + "." + row["name"]
        for row in result["member_refs"]:
            names[row["token"]] = str(row["parent_name"]) + "." + row["name"]
        strings = result["user_strings"]
        # REA retains user-string rows together with their coverage object.
        if isinstance(strings, dict):
            strings = strings.get("literals", [])
        for row in strings or []:
            names[row["token"]] = json.dumps(row["value"], ensure_ascii=False)
        for row in result["methods"]:
            group["methods"][row["token"]] = (record, row)
        for edge in result["call_edges"]:
            names.setdefault(edge["target_token"], str(edge["target_declaring_type"]) + "." + str(edge["target_name"]))

    args.out.mkdir(parents=True, exist_ok=True)
    manifest = []
    for digest, group in sorted(artifacts.items()):
        for token, (record, method) in sorted(group["methods"].items()):
            body = method.get("body") or {}
            if not body.get("anchors"):
                continue
            owner = method["declaring_type"]
            # Preserve all selected method bodies, including getters used by the
            # forward rendering path; no decompiler-produced C# is claimed.
            filename = digest[:12] + "-" + token + ".il.txt"
            lines = [
                "// Static CIL decoded by REA; not original C# and not a runtime trace.",
                "// Artifact: " + record["normalized_result"]["artifact"]["path"],
                "// SHA256: " + digest,
                "// MVID: " + str(record["normalized_result"]["module"]["mvid"]),
                "// Evidence: " + record["evidence_id"],
                "// Method: " + owner + "." + method["name"] + " " + token,
                "// Body SHA256: " + str(body.get("il_sha256")),
                "// Exception regions: " + json.dumps(body.get("exception_regions", [])),
            ]
            for anchor in body["anchors"]:
                operand = anchor.get("operand")
                annotation = group["names"].get(operand)
                suffix = " // " + annotation if annotation else ""
                lines.append(f"IL_{anchor['il_offset']:04x}: {anchor['opcode']:<16} {operand or ''}{suffix}")
            content = "\n".join(lines) + "\n"
            (args.out / filename).write_text(content)
            manifest.append({
                "artifact_sha256": digest, "evidence_id": record["evidence_id"],
                "method": owner + "." + method["name"], "token": token,
                "file": filename, "il_size": body.get("il_size"),
                "decoded_instructions": body.get("decoded_instruction_count"),
                "truncated_instructions": body.get("truncated_instructions"),
                "file_sha256": hashlib.sha256(content.encode()).hexdigest(),
            })
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Wrote {len(manifest)} method bodies from {len(artifacts)} artifacts to {args.out}")


if __name__ == "__main__":
    main()
