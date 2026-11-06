"""BrickHeadz parts knowledge base.

Reads the role-labelled corpus records (``records.jsonl`` from ``brickheadz all``: each piece
tagged head / face / hair / torso / arms / legs / base / accessory, plus its connections) and
joins them with LDraw part titles and the Rebrickable catalogue (names, categories, how many
BrickHeadz sets use each part). Writes machine-readable JSON plus a readable summary:

  parts.json   per part: name, category, roles it is used for, colours, stud direction, partners
  roles.json   per body region: most used parts, categories, piece counts, SNOT share
  hair.json    per model hair recipe (parts, orientation, what they attach to, extent vs head)
               and corpus-wide hair techniques
  KNOWLEDGE.md the readable summary

Run:  python -m brickheadz.knowledge --records ../.cache/brickheadz/records.jsonl --out knowledge
"""
from __future__ import annotations

import argparse
import collections
import csv
import gzip
import json
import os
import re
import statistics

import numpy as np

ROLES = ("head", "face", "hair", "torso", "arms", "legs", "base", "accessory")
PLATE = 8.0  # LDU per plate height
STUD = 20.0  # LDU per stud


# ---------------------------------------------------------------- sources

def ldraw_title(root: str, part: str) -> str:
    for sub in ("parts", "p", "unofficial/parts"):
        path = os.path.join(root, sub, part + ".dat")
        if os.path.exists(path):
            with open(path, encoding="utf-8", errors="replace") as fh:
                first = fh.readline().strip()
            return re.sub(r"\s+", " ", first[2:] if first.startswith("0 ") else first).strip()
    return ""


_CANON: dict[str, str] = {}


def canonical(root: str, part: str) -> str:
    """Follow LDraw '~Moved to X' redirects (3023 -> 3023b) so one part is counted once."""
    if part not in _CANON:
        seen, p = set(), part
        while p not in seen:
            seen.add(p)
            m = re.match(r"~Moved to (\S+)", ldraw_title(root, p))
            if not m:
                break
            p = m.group(1).removesuffix(".dat").lower()
        _CANON[part] = p
    return _CANON[part]


def _csv(path: str):
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        yield from csv.DictReader(fh)


def rebrickable(rb_dir: str, theme_id: int = 610) -> dict:
    """{'parts': {num: (name, category)}, 'bh_sets': {num: n BrickHeadz sets}, 'colors': {id: name}}."""
    out: dict = {"parts": {}, "bh_sets": {}, "bh_total": 0, "colors": {}}
    if not rb_dir or not os.path.isdir(rb_dir):
        return out
    cats = {r["id"]: r["name"] for r in _csv(os.path.join(rb_dir, "part_categories.csv.gz"))}
    out["parts"] = {r["part_num"]: (r["name"], cats.get(r["part_cat_id"], "")) for r in _csv(os.path.join(rb_dir, "parts.csv.gz"))}
    out["colors"] = {r["id"]: r["name"] for r in _csv(os.path.join(rb_dir, "colors.csv.gz"))}
    sets = {r["set_num"] for r in _csv(os.path.join(rb_dir, "sets.csv.gz")) if r["theme_id"] == str(theme_id)}
    inv = {r["id"]: r["set_num"] for r in _csv(os.path.join(rb_dir, "inventories.csv.gz")) if r["set_num"] in sets}
    per: dict[str, set] = collections.defaultdict(set)
    for r in _csv(os.path.join(rb_dir, "inventory_parts.csv.gz")):
        s = inv.get(r["inventory_id"])
        if s and r["is_spare"] == "f":
            per[r["part_num"]].add(s)
    out["bh_sets"] = {p: len(s) for p, s in per.items()}
    out["bh_total"] = len(sets)
    return out


def _rb_key(part: str, rb: dict) -> str | None:
    """LDraw id -> Rebrickable id (mostly identical; try without the trailing letter or print code)."""
    for cand in (part, re.sub(r"[a-z]$", "", part), re.sub(r"p\w+$", "", part), part + "b"):
        if cand in rb["parts"]:
            return cand
    return None


def color_names(ldconfig: str) -> dict[int, str]:
    out = {}
    if os.path.exists(ldconfig):
        for line in open(ldconfig, encoding="utf-8", errors="replace"):
            m = re.match(r"0\s+!COLOUR\s+(\S+)\s+CODE\s+(\d+)", line)
            if m:
                out[int(m.group(2))] = m.group(1).replace("_", " ")
    return out


def bricknet_connectors(folder: str) -> dict[str, dict]:
    """Per-part connector summary from BrickNet's catalogue (labels.json.xz):
    studs by direction (pitch 0 = up, 90 = sideways, 180 = down), holes/tubes underneath,
    and the counts of clips, bars, pins/axles, hinges, ball joints and fixed mounts."""
    import lzma

    path = os.path.join(folder, "labels.json.xz") if folder else ""
    if not path or not os.path.exists(path):
        return {}
    out: dict[str, dict] = {}
    for stem, kinds in json.load(lzma.open(path)).items():
        c = collections.Counter()
        for kind, subs in kinds.items():
            for sub, rows in subs.items():
                if isinstance(rows, dict):  # polarised kinds: {"in"|"on": rows}
                    c[kind] += sum(len(r) for r in rows.values())
                    continue
                for r in rows:
                    pitch = abs(((r[3] + 180) % 360) - 180)
                    d = "up" if pitch < 45 else ("down" if pitch > 135 else "side")
                    if kind == "stud":
                        c[f"studs_{d}"] += 1
                    elif kind == "hole":
                        c["anti_studs" if d == "up" else f"holes_{d}"] += 1
                    elif kind == "axle":
                        c[{"clip": "clips", "bar": "bars", "pin": "pins", "cross": "axle_holes", "axle": "axles",
                           "socket": "pin_holes"}.get(sub, sub)] += 1
                    else:
                        c[kind] += 1
        out[stem.removesuffix(".dat").lower()] = dict(c)
    # renamed / duplicate parts: copy the canonical part's connectors (pure renames only, so directions hold)
    apath = os.path.join(folder, "part_aliases.json.xz")
    if os.path.exists(apath):
        ident = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
        for r in json.load(lzma.open(apath)).get("rows", []):
            src, dst = r["src"].lower(), r["dst"].lower()
            if src not in out and dst in out and r.get("final_matrix_3x4") == ident:
                out[src] = out[dst]
    return out


def _conn_text(c: dict) -> str:
    order = ["studs_up", "studs_side", "studs_down", "anti_studs", "holes_side", "holes_down", "clips", "bars",
             "pins", "pin_holes", "axles", "axle_holes", "hinge", "ball", "fixed"]
    return " ".join(f"{k.replace('_', ' ')} {c[k]}" for k in order if c.get(k))


# ---------------------------------------------------------------- geometry helpers

def stud_dir(matrix: list[float], front: list[float]) -> str:
    """Where the part's studs point in the figure frame: up / down / front / back / side."""
    m = matrix
    s = np.array([-m[4], m[5], -m[6]])  # local -y (LDraw stud side) in figure space (y up)
    if s[1] > 0.7:
        return "up"
    if s[1] < -0.7:
        return "down"
    f = float(np.dot(s, np.array(front, float)))
    if f > 0.7:
        return "front"
    if f < -0.7:
        return "back"
    return "side"


def _box(aabb):
    return np.array(aabb[0], float), np.array(aabb[1], float)


# ---------------------------------------------------------------- build

def load_records(path: str) -> list[dict]:
    with open(path) as fh:
        return [json.loads(line) for line in fh if line.strip()]


def build(records: list[dict], ldraw_root: str, rb: dict) -> dict:
    for rec in records:
        for p in rec["pieces"]:
            p["basePart"] = canonical(ldraw_root, p["basePart"])
    cnames = color_names(os.path.join(ldraw_root, "LDConfig.ldr"))
    part = collections.defaultdict(lambda: {"uses": 0, "models": set(), "roles": collections.Counter(),
                                            "colors": collections.Counter(), "studs": collections.Counter(),
                                            "partners": collections.Counter()})
    role = {r: {"pieces": [], "parts": collections.Counter(), "models": collections.defaultdict(set),
                "colors": collections.Counter(), "studs": collections.Counter()} for r in ROLES}
    hair_models, attach = [], collections.Counter()
    pair_hair = collections.Counter()

    for rec in records:
        mid = rec["id"]
        front = rec.get("face", {}).get("front") or rec["frame"]["front"]
        pcs = {p["key"]: p for p in rec["pieces"]}
        per_role = collections.Counter()
        for p in rec["pieces"]:
            bp, r = p["basePart"], p["component"]
            d = stud_dir(p["matrix"], front)
            e = part[bp]
            e["uses"] += 1
            e["models"].add(mid)
            e["roles"][r] += 1
            e["colors"][p["color"]] += 1
            e["studs"][d] += 1
            if r in role:
                role[r]["parts"][bp] += 1
                role[r]["models"][bp].add(mid)
                role[r]["colors"][p["color"]] += 1
                role[r]["studs"][d] += 1
            per_role[r] += 1
        for r in ROLES:
            role[r]["pieces"].append(per_role.get(r, 0))
        # connections (one direction only)
        nb = collections.defaultdict(set)
        for c in rec["connections"]:
            if c["confidence"].endswith("-rev"):
                continue
            a, b = pcs.get(c["a"]), pcs.get(c["b"])
            if not a or not b:
                continue
            nb[a["key"]].add(b["key"]); nb[b["key"]].add(a["key"])
            part[a["basePart"]]["partners"][b["basePart"]] += 1
            part[b["basePart"]]["partners"][a["basePart"]] += 1
            if a["component"] == "hair" or b["component"] == "hair":
                pair_hair[tuple(sorted((a["basePart"], b["basePart"])))] += 1
        hair_models.append(_hair_recipe(rec, front, nb, cnames, attach))

    return {"part": part, "role": role, "hair_models": [h for h in hair_models if h], "attach": attach,
            "pair_hair": pair_hair, "n_models": len(records), "cnames": cnames}


def _hair_recipe(rec: dict, front, nb, cnames, attach: collections.Counter) -> dict | None:
    pcs = {p["key"]: p for p in rec["pieces"]}
    hair = [p for p in rec["pieces"] if p["component"] == "hair"]
    head = [p for p in rec["pieces"] if p["component"] in ("head", "face") and p["figure"] == 0]
    if not hair or not head:
        return None
    hlo = np.min([_box(p["aabb"])[0] for p in head], 0)
    hhi = np.max([_box(p["aabb"])[1] for p in head], 0)
    alo = np.min([_box(p["aabb"])[0] for p in hair], 0)
    ahi = np.max([_box(p["aabb"])[1] for p in hair], 0)
    fr = np.array(front, float)
    ax = 0 if abs(fr[0]) > 0.5 else 2  # front/back axis
    side = 2 if ax == 0 else 0
    sgn = 1.0 if fr[ax] > 0 else -1.0
    head_front, head_back = (hhi[ax], hlo[ax]) if sgn > 0 else (hlo[ax], hhi[ax])
    hair_front, hair_back = (ahi[ax], alo[ax]) if sgn > 0 else (alo[ax], ahi[ax])
    extent = {
        "above_head_plates": round(float(ahi[1] - hhi[1]) / PLATE, 1),
        "lowest_below_head_top_plates": round(float(hhi[1] - alo[1]) / PLATE, 1),
        "side_overhang_studs": round(float(max(hlo[side] - alo[side], ahi[side] - hhi[side], 0)) / STUD, 2),
        "front_overhang_studs": round(float(sgn * (hair_front - head_front)) / STUD, 2),
        "back_overhang_studs": round(float(-sgn * (hair_back - head_back)) / STUD, 2),
    }
    items = collections.Counter()
    for p in hair:
        d = stud_dir(p["matrix"], front)
        on = sorted({pcs[k]["component"] for k in nb.get(p["key"], ()) if pcs[k]["component"] != "hair"})
        for o in on:
            attach[(d, o)] += 1
        items[(p["basePart"], cnames.get(p["color"], str(p["color"])), d, "+".join(on) or "hair")] += 1
    snot = sum(n for (_, _, d, _), n in items.items() if d not in ("up", "down"))
    full = _full_hair(rec, hair, head, front, cnames)
    return {
        "id": rec["id"], "name": rec["name"].removesuffix(".mpd"),
        "head": rec["figures"][0].get("headCube") if rec.get("figures") else None,
        "pieces": len(hair), "snot_pieces": snot, "extent": extent,
        "items": [{"part": a, "color": c, "studs": d, "attached_to": o, "count": n}
                  for (a, c, d, o), n in sorted(items.items(), key=lambda kv: -kv[1])],
        "full_hair": full,
    }


def _full_hair(rec: dict, hair: list[dict], head: list[dict], front, cnames) -> dict | None:
    """The labeller calls only pieces above the head 'hair'; side hair, fringe and back hair
    sit inside the head shell. Count head/face pieces in the hair colour too, unless the hair
    colour is also the face colour (furry animals, where colour cannot separate them)."""
    hc = collections.Counter(p["color"] for p in hair).most_common(1)[0][0]
    face = [p for p in rec["pieces"] if p["component"] == "face"]
    if face and sum(p["color"] == hc for p in face) / len(face) >= 0.4:
        return None
    extra = [p for p in head if p["color"] == hc and p["component"] != "face" or (p["component"] == "face" and p["color"] == hc)]
    if not extra:
        return {"color": cnames.get(hc, str(hc)), "pieces": len(hair), "in_head_shell": 0, "sides": {}, "parts": {}}
    hlo = np.min([_box(p["aabb"])[0] for p in head if p["color"] != hc] or [_box(p["aabb"])[0] for p in head], 0)
    hhi = np.max([_box(p["aabb"])[1] for p in head if p["color"] != hc] or [_box(p["aabb"])[1] for p in head], 0)
    fr = np.array(front, float)
    sides = collections.Counter()
    for p in extra:
        lo, hi = _box(p["aabb"])
        c = (lo + hi) / 2
        rel = c - (hlo + hhi) / 2
        half = (hhi - hlo) / 2 + 1e-6
        f = float(np.dot(rel, fr)) / float(np.dot(np.abs(fr), half))
        sd = float(np.dot(rel, np.array([fr[2], 0, -fr[0]]))) / float(np.dot(np.abs([fr[2], 0, fr[0]]), half))
        if f > 0.6:
            sides["front (fringe)"] += 1
        elif f < -0.6:
            sides["back"] += 1
        elif abs(sd) > 0.6:
            sides["sides"] += 1
        else:
            sides["top/inside"] += 1
    parts = collections.Counter(p["basePart"] for p in extra)
    return {"color": cnames.get(hc, str(hc)), "pieces": len(hair) + len(extra), "in_head_shell": len(extra),
            "sides": dict(sides.most_common()), "parts": dict(parts.most_common(10))}


# ---------------------------------------------------------------- exact connections (connector graph)

def connection_grammar(records: list[dict], model_paths: list[str], root: str) -> dict:
    """Exact connector edges of each model (brickheadz.connectors), joined to the records' body-region
    labels by file hash. Counts which part attaches to which, through which connector, per region pair."""
    import glob
    import hashlib

    from brickheadz import connectors as cg
    from brickheadz.dat import load_pieces

    by_hash = {r["source"].get("sha256"): r for r in records if r.get("source", {}).get("sha256")}
    files = []
    for p in model_paths:
        files += sorted(glob.glob(os.path.join(p, "**", "*.mpd"), recursive=True)) if os.path.isdir(p) else [p]
    cat = cg.catalog()
    pair = collections.Counter()  # (female part, female sub, female role, male part, male sub, male role)
    regions = collections.Counter()
    per_model: dict[str, list[str]] = {}
    stats = {"models": 0, "pieces": 0, "edges": 0, "clip_edges": 0, "loose_edges": 0, "no_connector_data": 0,
             "largest_component_share": []}
    for f in files:
        rec = by_hash.get(hashlib.sha256(open(f, "rb").read()).hexdigest())
        if rec is None:
            continue
        role = {p["key"]: p["component"] for p in rec["pieces"]}
        ps = load_pieces(f)
        g = cg.graph_of_pieces(ps, cat)
        roles = [role.get(p.key, "?") for p in ps]
        parts = [canonical(root, p.base_part) for p in ps]
        stats["models"] += 1
        stats["pieces"] += len(ps)
        stats["edges"] += len(g.edges)
        stats["clip_edges"] += sum(e.family == "clip" for e in g.edges)
        stats["loose_edges"] += sum(cg.loose(e) for e in g.edges)
        stats["no_connector_data"] += len(g.unknown)
        stats["largest_component_share"].append(len(g.components()[0]) / max(1, len(ps)))
        lines = []
        for e in g.edges:
            ma = cat.connectors(g.parts[e.a])[e.a_conn].sub
            fb = cat.connectors(g.parts[e.b])[e.b_conn].sub
            pair[(parts[e.b], fb, roles[e.b], parts[e.a], ma, roles[e.a])] += 1
            regions[(roles[e.b], roles[e.a])] += 1
            if "hair" in (roles[e.a], roles[e.b]):
                y = f" turned {round(e.yaw) % 360}" if e.family == "stud" and round(e.yaw) % 360 else ""
                lines.append(f"{parts[e.b]} ({roles[e.b]}, {fb}) on {parts[e.a]} ({roles[e.a]}, {ma}){y}")
        per_model[rec["id"]] = [f"{n}x {l}" for l, n in collections.Counter(lines).most_common()]
    sh = stats.pop("largest_component_share")
    stats["largest_component_median"] = round(statistics.median(sh), 3) if sh else 0
    return {"stats": stats,
            "regions": [{"upper": a, "lower": b, "edges": n} for (a, b), n in regions.most_common()],
            "pairs": [{"female": f, "female_conn": fs, "female_role": fr, "male": m, "male_conn": ms, "male_role": mr, "count": n}
                      for (f, fs, fr, m, ms, mr), n in pair.most_common(400)],
            "hair_attachments": per_model}


# ---------------------------------------------------------------- outputs

def _name(bp: str, root: str, rb: dict) -> tuple[str, str, str | None]:
    k = _rb_key(bp, rb)
    rb_name, cat = rb["parts"].get(k, ("", "")) if k else ("", "")
    return ldraw_title(root, bp) or rb_name, cat, k


def write(kb: dict, out: str, root: str, rb: dict) -> dict:
    os.makedirs(out, exist_ok=True)
    cn, N = kb["cnames"], kb["n_models"]
    parts = {}
    for bp, e in sorted(kb["part"].items(), key=lambda kv: -len(kv[1]["models"])):
        name, cat, k = _name(bp, root, rb)
        parts[bp] = {
            "name": name, "category": cat, "rebrickable": k,
            "models": len(e["models"]), "uses": e["uses"],
            "brickheadz_sets": rb["bh_sets"].get(k, 0) if k else 0,
            "roles": dict(e["roles"].most_common()),
            "colors": {cn.get(c, str(c)): n for c, n in e["colors"].most_common(6)},
            "studs": dict(e["studs"].most_common()),
            "partners": [p for p, _ in e["partners"].most_common(8)],
            "connectors": kb.get("connectors", {}).get(bp, {}),
        }
    roles = {}
    for r, e in kb["role"].items():
        tot = sum(e["parts"].values()) or 1
        cats = collections.Counter()
        for bp, n in e["parts"].items():
            cats[parts.get(bp, {}).get("category") or "?"] += n
        roles[r] = {
            "pieces_per_model_median": statistics.median(e["pieces"]) if e["pieces"] else 0,
            "models_with_role": sum(1 for n in e["pieces"] if n),
            "stud_directions": {d: round(n / tot, 3) for d, n in e["studs"].most_common()},
            "categories": {c: round(n / tot, 3) for c, n in cats.most_common(10)},
            "top_parts": [{"part": bp, "name": parts[bp]["name"], "models": len(e["models"][bp]), "uses": n}
                          for bp, n in sorted(e["parts"].items(), key=lambda kv: (-len(e["models"][kv[0]]), -kv[1]))[:40]],
            "colors": {cn.get(c, str(c)): n for c, n in e["colors"].most_common(10)},
        }
    hm = kb["hair_models"]
    techniques = {
        "models_with_hair": len(hm),
        "attachment": [{"studs": d, "attached_to": o, "pieces": n} for (d, o), n in kb["attach"].most_common(15)],
        "connected_pairs": [{"a": a, "b": b, "a_name": parts.get(a, {}).get("name", ""), "b_name": parts.get(b, {}).get("name", ""), "count": n}
                            for (a, b), n in kb["pair_hair"].most_common(30)],
        "extent_median": {k: statistics.median(h["extent"][k] for h in hm) for k in hm[0]["extent"]} if hm else {},
        "snot_share": round(sum(h["snot_pieces"] for h in hm) / max(1, sum(h["pieces"] for h in hm)), 3),
        "styles": _styles(hm),
    }
    json.dump(parts, open(os.path.join(out, "parts.json"), "w"), indent=1)
    json.dump(roles, open(os.path.join(out, "roles.json"), "w"), indent=1)
    conn = kb.get("connections") or {}
    if conn:
        for h in hm:
            h["exact_attachments"] = conn["hair_attachments"].get(h["id"], [])
        json.dump({k: v for k, v in conn.items() if k != "hair_attachments"}, open(os.path.join(out, "connections.json"), "w"), indent=1)
    json.dump({"techniques": techniques, "models": hm}, open(os.path.join(out, "hair.json"), "w"), indent=1)
    vids = _video_stats(kb.get("videos", []), parts, root, rb)
    if vids:
        json.dump(vids, open(os.path.join(out, "video_parts.json"), "w"), indent=1)
    with open(os.path.join(out, "KNOWLEDGE.md"), "w") as fh:
        fh.write(_markdown(parts, roles, techniques, hm, N, rb, vids, kb.get("brickgpt"), out, conn))
    return {"parts": len(parts), "models": N, "hair_models": len(hm)}


def _styles(hm: list[dict]) -> dict:
    """Coarse hair style tags from the hair's extent relative to the head."""
    tags = collections.Counter()
    for h in hm:
        e, t = h["extent"], []
        if e["lowest_below_head_top_plates"] > 12:
            t.append("long (reaches below head mid-height)")
        if e["above_head_plates"] >= 3:
            t.append("volume on top (>= 1 brick above head)")
        if e["side_overhang_studs"] >= 0.5:
            t.append("wider than head (side overhang)")
        if e["back_overhang_studs"] >= 0.5:
            t.append("back overhang")
        if e["front_overhang_studs"] >= 0.25:
            t.append("fringe sticks out at the front")
        if h["snot_pieces"] >= max(2, h["pieces"] // 3):
            t.append("SNOT-heavy (sideways pieces)")
        h["tags"] = t or ["flat cap (thin layer on top)"]
        tags.update(h["tags"])
    return dict(tags.most_common())


def _video_stats(videos: list[dict], parts: dict, root: str, rb: dict) -> dict:
    """Part usage across the KenBrick parts lists (real fan builds, no body-region labels)."""
    if not videos:
        return {}
    clips, pieces, colours = collections.Counter(), collections.Counter(), collections.Counter()
    for v in videos:
        seen = set()
        for it in v["items"]:
            p = canonical(root, it["part"])
            pieces[p] += it["qty"] or 0
            colours[(p, it["color"])] += it["qty"] or 0
            seen.add(p)
        clips.update(seen)
    top = []
    for p, n in clips.most_common(120):
        name, cat, _k = _name(p, root, rb)
        roles = parts.get(p, {}).get("roles", {})
        tot = sum(roles.values()) or 1
        top.append({"part": p, "name": name, "category": cat, "clips": n, "pieces": pieces[p],
                    "official_models": parts.get(p, {}).get("models", 0),
                    "official_roles": {r: round(c / tot, 2) for r, c in list(roles.items())[:3]},
                    "colors": [c for (q, c), _n in colours.most_common() if q == p][:5]})
    not_official = [t for t in top if not t["official_models"]]
    return {"clips": len(videos), "pieces": sum(pieces.values()), "distinct_parts": len(clips),
            "median_pieces_per_build": statistics.median(v["pieces"] for v in videos),
            "top_parts": top, "used_by_fans_not_in_official": not_official[:30]}


def _markdown(parts, roles, tech, hm, N, rb, vids=None, bgpt=None, out=".", conn=None) -> str:
    L = [f"# BrickHeadz parts knowledge base\n",
         f"Built from {N} BrickHeadz models (78 official LDraw OMR files plus our own hand-built ones; each piece labelled by body region) "
         f"and the Rebrickable catalogue ({rb['bh_total']} BrickHeadz sets). Machine-readable data: "
         "`parts.json`, `roles.json`, `hair.json`. Web research notes: `research/`.\n"]
    L.append("## Body regions\n")
    for r, e in roles.items():
        if not e["models_with_role"]:
            continue
        L.append(f"### {r}\n")
        L.append(f"In {e['models_with_role']}/{N} models, median {e['pieces_per_model_median']} pieces. "
                 f"Stud directions: " + ", ".join(f"{d} {v:.0%}" for d, v in e["stud_directions"].items()) + ".\n")
        L.append("Categories: " + ", ".join(f"{c} {v:.0%}" for c, v in list(e["categories"].items())[:6]) + ".\n")
        L.append("| part | name | models | uses |\n|---|---|---|---|")
        for t in e["top_parts"][:15]:
            L.append(f"| {t['part']} | {t['name']} | {t['models']} | {t['uses']} |")
        L.append("")
    L.append("## Hair: how it is built\n")
    L.append(f"{tech['models_with_hair']} models have hair/headwear; {tech['snot_share']:.0%} of hair pieces are mounted sideways (SNOT).\n")
    L.append("Median extent vs the head: " + ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in tech["extent_median"].items()) + ".\n")
    L.append("Style tags (count of models): " + "; ".join(f"{k} {v}" for k, v in tech["styles"].items()) + ".\n")
    L.append("How hair pieces attach (stud direction -> region they connect to):\n")
    for a in tech["attachment"][:10]:
        L.append(f"- studs {a['studs']}, attached to {a['attached_to']}: {a['pieces']} pieces")
    L.append("\nMost common connected part pairs in hair:\n")
    for p in tech["connected_pairs"][:15]:
        L.append(f"- {p['a']} ({p['a_name']}) + {p['b']} ({p['b_name']}): {p['count']}")
    fh = [h["full_hair"] for h in hm if h.get("full_hair")]
    if fh:
        L.append(f"\nHair inside the head shell (same colour as the hair, {len(fh)} models where colour separates hair from skin): "
                 f"median {statistics.median(f['in_head_shell'] for f in fh)} extra pieces per model, "
                 f"full hair median {statistics.median(f['pieces'] for f in fh)} pieces.")
        sides, parts_c = collections.Counter(), collections.Counter()
        for f in fh:
            sides.update(f["sides"]); parts_c.update(f["parts"])
        L.append("Where: " + ", ".join(f"{k} {v}" for k, v in sides.most_common()) + ".")
        L.append("Parts used for side/back/fringe hair: " + ", ".join(f"{p} {parts.get(p, {}).get('name', '')} ({n})" for p, n in parts_c.most_common(12)) + ".")
    L.append("\n### Hair recipes per model\n")
    for h in sorted(hm, key=lambda h: -h["pieces"]):
        L.append(f"**{h['name']}** - {h['pieces']} pieces, {h['snot_pieces']} sideways; " + ", ".join(h.get("tags", [])))
        if h.get("full_hair") and h["full_hair"]["in_head_shell"]:
            f = h["full_hair"]
            L.append(f"  plus {f['in_head_shell']} {f['color']} pieces in the head shell ({', '.join(f'{k} {v}' for k, v in f['sides'].items())})")
        if h.get("exact_attachments"):
            L.append("  exact: " + "; ".join(h["exact_attachments"][:10]))
        L.append("  " + "; ".join(f"{i['count']}x {i['part']} {parts.get(i['part'], {}).get('name', '')} ({i['color']}, studs {i['studs']}, on {i['attached_to']})" for i in h["items"][:12]))
        L.append("")
    if conn:
        st = conn["stats"]
        L.append("## How parts connect (exact connectors)\n")
        L.append(f"Typed connector graphs (`brickheadz.connectors`, BrickNet-style) for {st['models']} models: {st['edges']} exact "
                 f"connections ({st['clip_edges']} clip-on-bar, {st['loose_edges']} slightly loose in the source file); a median "
                 f"{st['largest_component_median']:.0%} of a model's pieces form one connected structure; "
                 f"{st['no_connector_data']} of {st['pieces']} pieces have no connector data. Each model can be rebuilt exactly "
                 "from its connections alone. Data: `connections.json`.\n")
        L.append("Which region sits on which (connections, upper part on lower part's studs):\n")
        for r in conn["regions"][:14]:
            L.append(f"- {r['upper']} on {r['lower']}: {r['edges']}")
        L.append("\nMost common exact connections (part with the hole/clip -> part with the stud/bar):\n")
        L.append("| upper part | via | region | onto | via | region | count |\n|---|---|---|---|---|---|---|")
        for p in conn["pairs"][:30]:
            L.append(f"| {p['female']} {parts.get(p['female'], {}).get('name', '')} | {p['female_conn']} | {p['female_role']} | "
                     f"{p['male']} {parts.get(p['male'], {}).get('name', '')} | {p['male_conn']} | {p['male_role']} | {p['count']} |")
        hp = [p for p in conn["pairs"] if "hair" in (p["female_role"], p["male_role"])][:20]
        if hp:
            L.append("\nHair: exact connections\n")
            for p in hp:
                L.append(f"- {p['female']} {parts.get(p['female'], {}).get('name', '')} ({p['female_role']}, {p['female_conn']}) on "
                         f"{p['male']} {parts.get(p['male'], {}).get('name', '')} ({p['male_role']}, {p['male_conn']}): {p['count']}")
        L.append("")
    if vids:
        L.append("## KenBrick fan builds (parts lists read from the videos)\n")
        L.append(f"{vids['clips']} builds, {vids['pieces']} pieces, {vids['distinct_parts']} distinct parts, "
                 f"median {vids['median_pieces_per_build']} pieces per build. Region shares come from the official models.\n")
        L.append("| part | name | builds | pieces | official models | used for (official) | colours |\n|---|---|---|---|---|---|---|")
        for t in vids["top_parts"][:60]:
            L.append(f"| {t['part']} | {t['name']} | {t['clips']} | {t['pieces']} | {t['official_models']} | "
                     + ", ".join(f"{r} {v:.0%}" for r, v in t["official_roles"].items()) + f" | {', '.join(t['colors'][:3])} |")
        if vids["used_by_fans_not_in_official"]:
            L.append("\nUsed in fan builds but never in the official models: " + ", ".join(
                f"{t['part']} {t['name']} ({t['clips']})" for t in vids["used_by_fans_not_in_official"]) + ".\n")
    snot = [(bp, p) for bp, p in parts.items() if (p.get("connectors") or {}).get("studs_side") or (p.get("connectors") or {}).get("clips")]
    if snot:
        L.append("## Sideways and clip connections (from BrickNet's connector catalogue)\n")
        L.append("Parts in our models that offer sideways studs or clips: the tools for SNOT, hair strands and ears. "
                 "BrickNet counts any connector that grips a bar as a clip, including hollow studs, and the hollow tube under 1xN "
                 "plates and bricks as a bar (clips grip it). So 22885's 'clips 4' are its 4 hollow side studs.\n\n"
                 "Counts are connectors per part; 'models' is official models using it.\n")
        L.append("| part | name | models | used for | connectors |\n|---|---|---|---|---|")
        for bp, p in sorted(snot, key=lambda kv: -kv[1]["models"])[:40]:
            tot = sum(p["roles"].values()) or 1
            use = ", ".join(f"{r} {n / tot:.0%}" for r, n in list(p["roles"].items())[:3])
            L.append(f"| {bp} | {p['name']} | {p['models']} | {use} | {_conn_text(p['connectors'])} |")
        L.append("")
    if bgpt:
        L.append("## BrickGPT / StableText2Brick (CMU, ICCV 2025)\n")
        L.append(f"{bgpt['structures']} stable structures of everyday objects ({', '.join(list(bgpt['categories'])[:6])}, ...), "
                 f"{bgpt['bricks']} bricks, median {bgpt['bricks_per_structure_median']} per structure. Only 8 plain brick sizes "
                 "(no plates, slopes, tiles or SNOT), so it says nothing about BrickHeadz parts. Useful for stacking rules: "
                 f"{bgpt['interlocking_share']:.0%} of bricks above the ground rest on 2+ bricks below (running bond); size mix "
                 + ", ".join(f"{k} {v:.0%}" for k, v in bgpt["brick_sizes"].items()) + ". Its stability checker needs Gurobi.\n")
    rd = os.path.join(out, "research")
    if os.path.isdir(rd):
        L.append("## Web research (Big Pickle via OpenCode; claims carry source links, not independently verified)\n")
        for f in sorted(os.listdir(rd)):
            L.append(f"- [research/{f}](research/{f})")
        L.append("")
    L.append("## Parts and what they are used for\n")
    L.append("| part | name | category | models | BrickHeadz sets | used for | connectors (BrickNet) |\n|---|---|---|---|---|---|---|")
    for bp, p in list(parts.items())[:150]:
        tot = sum(p["roles"].values()) or 1
        use = ", ".join(f"{r} {n / tot:.0%}" for r, n in list(p["roles"].items())[:3])
        L.append(f"| {bp} | {p['name']} | {p['category']} | {p['models']} | {p['brickheadz_sets']} | {use} | {_conn_text(p.get('connectors') or {})} |")
    return "\n".join(L) + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="brickheadz.knowledge")
    ap.add_argument("--records", nargs="+", default=[os.path.join("..", ".cache", "brickheadz", "records.jsonl")])
    ap.add_argument("--bricknet", default="", help="folder with BrickNet's labels.json.xz (connector catalogue)")
    ap.add_argument("--models", nargs="*", default=[], help="MPD files or folders for exact connector graphs (matched to records by hash)")
    ap.add_argument("--brickgpt", default="", help="brickgpt_stats.json (StableText2Brick statistics)")
    ap.add_argument("--videos", default="", help="video_inventories.json from brickheadz.video_inventory")
    ap.add_argument("--library", default=os.path.join("..", "public", "ldraw"))
    ap.add_argument("--rebrickable", default="", help="folder with Rebrickable CSV .gz downloads")
    ap.add_argument("--out", default="knowledge")
    a = ap.parse_args(argv)
    rb = rebrickable(a.rebrickable)
    recs = [r for path in a.records for r in load_records(path)]
    kb = build(recs, a.library, rb)
    kb["connectors"] = bricknet_connectors(a.bricknet)
    kb["connections"] = connection_grammar(recs, a.models, a.library) if a.models else {}
    kb["brickgpt"] = json.load(open(a.brickgpt)) if a.brickgpt and os.path.exists(a.brickgpt) else {}
    kb["videos"] = json.load(open(a.videos)) if a.videos and os.path.exists(a.videos) else []
    print(json.dumps(write(kb, a.out, a.library, rb)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
