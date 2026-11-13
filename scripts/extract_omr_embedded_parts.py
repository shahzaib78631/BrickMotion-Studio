"""Extract the parts OMR models carry inside their MPD files into the local LDraw library.

OMR files embed unofficial and set-specific parts (flexed hoses, bent or patterned variants, named
like "42120 - 61332.dat") as `0 FILE ... .dat` sections. The answer keys use them as ordinary parts, but
the shared library does not have them, so the app, the solver and the collision audit found no mesh.
Each embedded `.dat` that the official library lacks is written to public/ldraw/models/ (searched by the
app's library and by assembly_model.ldraw). The same name with different text in two models is
reported and the first copy kept.

    python3 scripts/extract_omr_embedded_parts.py [--omr /path/to/omr/models] [--dry-run]
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LDRAW = ROOT / "public/ldraw"
FILE = re.compile(r"^0\s+FILE\s+(.+?)\s*$", re.IGNORECASE)


def sections(text: str):
    name, lines = None, []
    for line in text.splitlines():
        m = FILE.match(line)
        if m:
            if name:
                yield name, lines
            name, lines = m.group(1), []
        elif name is not None and not re.match(r"^0\s+NOFILE\b", line, re.IGNORECASE):
            lines.append(line)
    if name:
        yield name, lines


def official(name: str) -> bool:
    n = name.replace("\\", "/")
    return any((LDRAW / d / n).is_file() or (LDRAW / d / n.lower()).is_file() for d in ("parts", "p"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--omr", default="/Users/mac/Projects/BrickMotion-Data/omr/models")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    out_dir = LDRAW / "models"
    written, same, clashes, skipped = {}, 0, [], 0
    for mpd in sorted(Path(a.omr).glob("*/*.mpd")):
        text = mpd.read_text(errors="replace")
        for name, lines in sections(text):
            if not name.lower().endswith(".dat"):
                continue
            if official(name):
                skipped += 1
                continue
            key = name.lower().replace("\\", "/")
            body = "\n".join(lines).strip() + "\n"
            if key in written:
                if written[key][1] == body:
                    same += 1
                else:
                    clashes.append((key, written[key][0], mpd.parent.name))
                continue
            written[key] = (mpd.parent.name, body)
    if not a.dry_run:
        for key, (_src, body) in written.items():
            path = out_dir / key
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                path.write_text(body)
    print(f"embedded parts written {len(written)}, repeated identical {same}, official skipped {skipped}, clashes {len(clashes)}")
    for c in clashes[:20]:
        print("  clash", *c)


if __name__ == "__main__":
    main()
