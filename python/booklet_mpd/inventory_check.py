"""Cross-check part identity: booklet parts list vs Rebrickable official inventory vs OMR.

The Rebrickable key is read from the environment by the caller and is only ever sent
as the Authorization header; only set and element numbers leave the machine.
"""
from __future__ import annotations

import json
import numpy as np
import re
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Callable

API = "https://rebrickable.com/api/v3/lego/"


def default_get(url: str, headers: dict) -> dict:
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
        return json.load(response)


def to_set_part(row: dict) -> dict:
    part = row.get("part") or {}
    colour = (((row.get("color") or {}).get("external_ids") or {}).get("LDraw") or {}).get("ext_ids") or []
    ldraw = (part.get("external_ids") or {}).get("LDraw") or []
    return {"element": row.get("element_id"), "part": part.get("part_num", ""),
            "ldrawPart": (ldraw[0] if ldraw else part.get("part_num", "")), "ldrawAll": list(ldraw),
            "color": colour[0] if colour and isinstance(colour[0], int) else None,
            "colorName": (row.get("color") or {}).get("name", ""), "quantity": row.get("quantity", 0),
            "spare": bool(row.get("is_spare"))}


class Rebrickable:
    def __init__(self, key: str, cache_dir: Path, get: Callable = default_get, pause: float = 1.1,
                 sleep: Callable = time.sleep):
        if not key or not key.strip():
            raise RuntimeError("Set REBRICKABLE_API_KEY (free key from rebrickable.com settings, API section)")
        self._key, self.cache = key.strip(), Path(cache_dir)
        self._get, self._pause, self._sleep = get, pause, sleep

    def _call(self, url: str) -> dict:
        for attempt in range(6):
            try:
                return self._get(url, {"Authorization": f"key {self._key}"})
            except urllib.error.HTTPError as error:
                if error.code != 429 or attempt == 5:
                    raise
                self._sleep(float(error.headers.get("Retry-After", 5)) + 1)
        raise RuntimeError("unreachable")

    def _all(self, url: str) -> list[dict]:
        rows: list[dict] = []
        while url:
            page = self._call(url)
            rows += page.get("results") or []
            url = page.get("next")
            self._sleep(self._pause)
        return rows

    def set_parts(self, set_num: str, _seen: tuple = ()) -> list[dict]:
        cache = self.cache / f"{set_num}.json"
        if not _seen and cache.is_file():
            return json.loads(cache.read_text())
        merged: dict[tuple, dict] = {}

        def add(part: dict, times: int):
            key = (part["element"] or (part["part"], part["colorName"]), part["spare"])
            if key in merged:
                merged[key]["quantity"] += part["quantity"] * times
            else:
                merged[key] = {**part, "quantity": part["quantity"] * times}

        for row in self._all(f"{API}sets/{set_num}/parts/?page_size=1000&inc_color_details=1"):
            add(to_set_part(row), 1)
        for sub in self._all(f"{API}sets/{set_num}/sets/?page_size=1000"):
            number = sub.get("set_num") or ""
            if number and number not in _seen and number != set_num:
                for part in self.set_parts(number, (*_seen, set_num)):
                    add(part, sub.get("quantity", 1))
        result = list(merged.values())
        if not _seen:
            self.cache.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(result, indent=1))
        return result

    def element(self, element_id: str) -> dict | None:
        cache = self.cache / "elements.json"
        known = json.loads(cache.read_text()) if cache.is_file() else {}
        if element_id not in known:
            try:
                known[element_id] = {**to_set_part(self._call(f"{API}elements/{element_id}/")), "element": element_id}
            except urllib.error.HTTPError as error:
                if error.code != 404:
                    raise
                known[element_id] = None
            self.cache.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(known, indent=1))
            self._sleep(self._pause)
        return known[element_id]

    def related_parts(self, part_id: str) -> set[str]:
        cache = self.cache / "parts.json"
        known = json.loads(cache.read_text()) if cache.is_file() else {}
        if part_id not in known:
            try:
                known[part_id] = self._call(f"{API}parts/{part_id}/")
            except urllib.error.HTTPError as error:
                if error.code != 404:
                    raise
                known[part_id] = None
            self.cache.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(known, indent=1))
            self._sleep(self._pause)
        record = known[part_id] or {}
        related = {part_id, *(record.get("alternates") or []), *(record.get("molds") or []), *(record.get("prints") or [])}
        if record.get("print_of"):
            related.add(record["print_of"])
        return related


def official_counter(parts: list[dict], spares: bool = False) -> Counter:
    counter: Counter = Counter()
    for p in parts:
        if p["spare"] and not spares:
            continue
        counter[(p["ldrawPart"].lower(), p["color"])] += p["quantity"]
    return counter


_EMBEDDED = re.compile(r"^\d+ - (.+)$")


def _plain(part: str) -> str:
    """OMR authors name embedded part files '<set> - <part>'; that is the part itself."""
    match = _EMBEDDED.match(part)
    return (match.group(1) if match else part).lower()


def omr_counter(truth_steps) -> Counter:
    return Counter((_plain(part), colour) for step in truth_steps for part, colour, _m in step)


def booklet_counter(inventory: list[dict], set_parts: list[dict], lookup: Callable) -> tuple[Counter, list[str]]:
    index: dict[str, dict] = {}
    for p in set_parts:
        if p["element"] and (p["element"] not in index or index[p["element"]]["spare"]):
            index[p["element"]] = p
    counter: Counter = Counter()
    unresolved: list[str] = []
    for entry in inventory:
        part = index.get(entry["element"]) or lookup(entry["element"])
        if part is None:
            unresolved.append(entry["element"])
            continue
        counter[(part["ldrawPart"].lower(), part["color"])] += entry["count"]
    return counter, unresolved


def compare(a: Counter, b: Counter) -> dict:
    """`exact` parts agree on id, colour and count; `*_covered` is the share of each side
    explained by the other (a subset relationship shows as 1.0 on the smaller side)."""
    exact = sum(min(a[k], b[k]) for k in set(a) & set(b))
    ta, tb = sum(a.values()), sum(b.values())
    return {"exact": exact, "total_a": ta, "total_b": tb,
            "a_covered": exact / ta if ta else None, "b_covered": exact / tb if tb else None,
            "only_a": dict(a - b), "only_b": dict(b - a)}


def alias_map(parts: list[dict]) -> dict[str, str]:
    """Every LDraw id (and Rebrickable id) of a set part -> the id used in official_counter."""
    aliases: dict[str, str] = {}
    for p in parts:
        canonical = p["ldrawPart"].lower()
        for other in (*p.get("ldrawAll", []), p["part"]):
            aliases.setdefault(other.lower(), canonical)
    return aliases


def remap(counter: Counter, aliases: dict[str, str]) -> tuple[Counter, int]:
    out: Counter = Counter()
    remapped = 0
    for (part, colour), n in counter.items():
        target = aliases.get(part, part)
        remapped += n if target != part else 0
        out[(target, colour)] += n
    return out, remapped


def count_signature(inventory: list[dict], omr: Counter) -> dict:
    """Shape check that needs no part dictionary: booklet parts list (element -> count)
    against the OMR (part, colour -> count). Same shape means the same total, the same
    number of distinct parts and the same multiset of counts; it is necessary for the two
    lists to describe identical parts, not sufficient."""
    elements: Counter = Counter()
    for entry in inventory:
        elements[entry["element"]] += entry["count"]
    a, b = Counter(elements.values()), Counter(omr.values())
    shared = a & b
    return {"booklet_total": sum(elements.values()), "omr_total": sum(omr.values()),
            "booklet_distinct": len(elements), "omr_distinct": len(omr),
            "same_total": sum(elements.values()) == sum(omr.values()),
            "same_distinct": len(elements) == len(omr), "same_signature": a == b,
            "shared_counts": sum(c * n for c, n in shared.items()),
            "booklet_extra": dict(a - b), "omr_extra": dict(b - a)}


_VARIANT = re.compile(r"^(\d+)[a-z][a-z0-9]*$")


def base_number(part: str) -> str:
    """'63965a', '30367c', '98138pz0', '3070bpr0235' -> the bare part number."""
    match = _VARIANT.match(part.lower())
    return match.group(1) if match else part.lower()


def reconcile(only_a: dict, only_b: dict, related: Callable) -> dict:
    """Pair leftover parts of equal colour that are the same physical part under another
    id: 'variant' (same base number) or whatever tier `related(a, b)` names (or None)."""
    left_a, left_b = dict(only_a), dict(only_b)
    pairs: list[tuple[str, str, int, str]] = []
    for (pa, ca) in sorted(left_a, key=lambda k: -left_a[k]):
        for (pb, cb) in list(left_b):
            if cb != ca or left_a[(pa, ca)] == 0 or left_b[(pb, cb)] == 0:
                continue
            tier = "variant" if base_number(pa) == base_number(pb) else related(pa, pb)
            if not tier:
                continue
            take = min(left_a[(pa, ca)], left_b[(pb, cb)])
            left_a[(pa, ca)] -= take
            left_b[(pb, cb)] -= take
            pairs.append((pa, pb, take, tier))
    return {"pairs": pairs, "reconciled": sum(n for _a, _b, n, _t in pairs),
            "residual_a": {k: n for k, n in left_a.items() if n}, "residual_b": {k: n for k, n in left_b.items() if n}}


def geometry_equivalent(lib, a: str, b: str) -> bool:
    """Two LDraw ids are the same physical part when their triangle meshes coincide."""
    def signature(part):
        triangles = lib.triangles(part + ".dat")
        return None if not len(triangles) else np.unique(np.round(triangles, 3), axis=0)

    sa, sb = signature(a), signature(b)
    return sa is not None and sb is not None and sa.shape == sb.shape and bool(np.allclose(sa, sb, atol=0.001))


_COLOUR = re.compile(r"!COLOUR\s+(\S+)\s+CODE\s+(\d+)")


def colour_aliases(ldconfig: Path) -> dict[int, int]:
    """Rubber_X -> X (LDraw lists rubber variants separately; inventories do not)."""
    codes = {}
    for line in Path(ldconfig).read_text(errors="ignore").splitlines():
        match = _COLOUR.search(line)
        if match:
            codes[match.group(1)] = int(match.group(2))
    return {code: codes[name[len("Rubber_"):]] for name, code in codes.items()
            if name.startswith("Rubber_") and name[len("Rubber_"):] in codes}


def remap_colours(counter: Counter, mapping: dict[int, int]) -> Counter:
    out: Counter = Counter()
    for (part, colour), n in counter.items():
        out[(part, mapping.get(colour, colour))] += n
    return out
