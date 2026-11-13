from collections import Counter

import pytest

from booklet_mpd.inventory_check import (Rebrickable, booklet_counter, compare, official_counter,
                                         omr_counter, to_set_part)


def row(part="3001", ldraw=("3001",), colour=4, element="300121", qty=2, spare=False):
    return {"element_id": element, "quantity": qty, "is_spare": spare,
            "part": {"part_num": part, "external_ids": {"LDraw": list(ldraw)}},
            "color": {"name": "Red", "external_ids": {"LDraw": {"ext_ids": [colour]}}}}


def test_to_set_part_reads_ldraw_ids():
    p = to_set_part(row(part="3001pr1", ldraw=("3001p01",), colour=4))
    assert (p["ldrawPart"], p["color"], p["quantity"], p["element"]) == ("3001p01", 4, 2, "300121")


def test_to_set_part_falls_back_to_rebrickable_id_and_null_colour():
    r = row()
    r["part"]["external_ids"] = {}
    r["color"]["external_ids"] = {}
    p = to_set_part(r)
    assert p["ldrawPart"] == "3001" and p["color"] is None


def test_set_parts_merges_pages_and_caches(tmp_path):
    calls = []

    def get(url, headers):
        calls.append(url)
        if "/sets/" in url and url.endswith("/sets/?page_size=1000"):
            return {"results": [], "next": None}
        if "page=2" in url:
            return {"results": [row(part="3023", ldraw=("3023",), element="302301")], "next": None}
        return {"results": [row()], "next": "https://rebrickable.com/x/parts/?page=2"}

    rb = Rebrickable("k", tmp_path, get=get, pause=0, sleep=lambda s: None)
    parts = rb.set_parts("40271-1")
    assert [p["ldrawPart"] for p in parts] == ["3001", "3023"]
    n = len(calls)
    assert rb.set_parts("40271-1") == parts and len(calls) == n  # second call served from cache


def test_missing_key_is_a_clear_error_that_does_not_echo_anything(tmp_path):
    with pytest.raises(RuntimeError, match="REBRICKABLE_API_KEY"):
        Rebrickable("", tmp_path)


def test_official_counter_excludes_spares_by_default():
    parts = [to_set_part(row(qty=3)), to_set_part(row(part="3023", ldraw=("3023",), qty=1, spare=True))]
    assert official_counter(parts) == Counter({("3001", 4): 3})
    assert official_counter(parts, spares=True)[("3023", 4)] == 1


def test_omr_counter_counts_part_and_colour():
    eye = None
    truth = [[("3001", 4, eye), ("3001", 4, eye)], [("3023", 15, eye)]]
    assert omr_counter(truth) == Counter({("3001", 4): 2, ("3023", 15): 1})


def test_booklet_counter_resolves_elements_through_the_set_inventory():
    parts = [to_set_part(row(element="300121", qty=2))]
    inventory = [{"element": "300121", "count": 2}, {"element": "999", "count": 1}]
    counter, unresolved = booklet_counter(inventory, parts, lookup=lambda e: None)
    assert counter == Counter({("3001", 4): 2}) and unresolved == ["999"]


def test_compare_identical_is_fully_exact():
    a = Counter({("3001", 4): 2, ("3023", 1): 1})
    r = compare(a, Counter(a))
    assert r["exact"] == 3 and r["a_covered"] == 1.0 and r["b_covered"] == 1.0 and not r["only_a"] and not r["only_b"]


def test_compare_reports_colour_swap_and_subset():
    r = compare(Counter({("3001", 4): 2}), Counter({("3001", 1): 2, ("3023", 1): 5}))
    assert r["exact"] == 0 and r["only_a"] == {("3001", 4): 2}
    assert r["only_b"] == {("3001", 1): 2, ("3023", 1): 5}
    sub = compare(Counter({("3001", 4): 2}), Counter({("3001", 4): 9}))
    assert sub["a_covered"] == 1.0 and sub["b_covered"] == pytest.approx(2 / 9)


from booklet_mpd.inventory_check import alias_map, remap


def test_remap_folds_alternate_ldraw_ids_and_counts_remaps():
    parts = [to_set_part(row(part="3069b", ldraw=("3069b", "3069"), colour=4, qty=2))]
    counter, remapped = remap(Counter({("3069", 4): 2, ("3001", 4): 1}), alias_map(parts))
    assert counter == Counter({("3069b", 4): 2, ("3001", 4): 1}) and remapped == 2


from booklet_mpd.inventory_check import count_signature


def test_count_signature_equal_shape_with_different_ids_still_agrees():
    inv = [{"element": "1", "count": 3}, {"element": "2", "count": 1}, {"element": "3", "count": 1}]
    omr = Counter({("3001", 4): 1, ("3023", 1): 3, ("54200", 15): 1})
    r = count_signature(inv, omr)
    assert r["same_total"] and r["same_distinct"] and r["same_signature"] and r["shared_counts"] == 5


def test_count_signature_flags_spares_and_shape_differences():
    inv = [{"element": "1", "count": 3}, {"element": "2", "count": 1}, {"element": "3", "count": 2}]
    omr = Counter({("3001", 4): 3, ("3023", 1): 1})
    r = count_signature(inv, omr)
    assert not r["same_signature"] and r["booklet_total"] == 6 and r["omr_total"] == 4
    assert r["booklet_extra"] == {2: 1} and r["omr_extra"] == {}


def test_count_signature_merges_repeated_element_entries():
    inv = [{"element": "1", "count": 2}, {"element": "1", "count": 1}]
    assert count_signature(inv, Counter({("3001", 4): 3}))["same_signature"]


def test_omr_counter_strips_embedded_set_prefix_from_part_names():
    truth = [[("42121 - 42924", 1, None), ("42924", 1, None), ("3001", 4, None), ("technicflexaxle-studio-1", 0, None)]]
    assert omr_counter(truth) == Counter({("42924", 1): 2, ("3001", 4): 1, ("technicflexaxle-studio-1", 0): 1})


from booklet_mpd.inventory_check import base_number, reconcile


def test_base_number_strips_variant_and_print_suffixes():
    assert [base_number(x) for x in ("63965a", "30367c", "98138pz0", "3070bp07", "3070bpr0235", "3023", "technicflexaxle-studio-1")] == \
        ["63965", "30367", "98138", "3070", "3070", "3023", "technicflexaxle-studio-1"]


def test_reconcile_pairs_variants_and_alternates_within_the_same_colour():
    only_a = {("63965a", 15): 3, ("28653", 15): 4, ("4073", 2): 1, ("2780", 0): 5}
    only_b = {("63965", 15): 3, ("3023", 15): 4, ("6141", 2): 1, ("2780", 1): 5}
    related = lambda a, b: "alternate" if {a, b} in ({"28653", "3023"}, {"4073", "6141"}) else None
    r = reconcile(only_a, only_b, related)
    tiers = {(a, b): t for a, b, n, t in r["pairs"]}
    assert tiers[("63965a", "63965")] == "variant"
    assert tiers[("28653", "3023")] == "alternate" and tiers[("4073", "6141")] == "alternate"
    assert r["residual_a"] == {("2780", 0): 5} and r["residual_b"] == {("2780", 1): 5}  # colour differs: real mismatch
    assert r["reconciled"] == 8


def test_reconcile_consumes_counts_without_double_use():
    r = reconcile({("63965a", 15): 5}, {("63965", 15): 3}, lambda a, b: None)
    assert r["reconciled"] == 3 and r["residual_a"] == {("63965a", 15): 2} and r["residual_b"] == {}


def test_part_lookup_is_cached_and_404_is_none(tmp_path):
    import urllib.error
    calls = []

    def get(url, headers):
        calls.append(url)
        if url.endswith("/parts/9999/"):
            raise urllib.error.HTTPError(url, 404, "nf", {}, None)
        return {"part_num": "28653", "alternates": ["3023"], "molds": ["28653b"], "prints": [], "print_of": None}

    rb = Rebrickable("k", tmp_path, get=get, pause=0, sleep=lambda s: None)
    assert rb.related_parts("28653") == {"28653", "3023", "28653b"}
    assert rb.related_parts("28653") == {"28653", "3023", "28653b"} and rb.related_parts("9999") == {"9999"}
    assert len(calls) == 2


import numpy as np

from booklet_mpd.inventory_check import colour_aliases, geometry_equivalent, remap_colours


class MeshLib:
    def __init__(self, meshes):
        self.meshes = meshes

    def triangles(self, name):
        return self.meshes.get(name.removesuffix(".dat"), np.zeros((0, 3)))


def test_geometry_equivalent_when_meshes_are_identical_up_to_order():
    cube = np.array([[0, 0, 0], [20, 0, 0], [0, 8, 0], [0, 0, 10]], float)
    lib = MeshLib({"3023": cube, "28653": cube[::-1].copy(), "3001": cube * 2})
    assert geometry_equivalent(lib, "3023", "28653")
    assert not geometry_equivalent(lib, "3023", "3001")
    assert not geometry_equivalent(lib, "3023", "not-in-library")


def test_colour_aliases_map_rubber_colours_to_their_base_colour(tmp_path):
    cfg = tmp_path / "LDConfig.ldr"
    cfg.write_text("0 !COLOUR Black CODE 0 VALUE #05131D EDGE #595959\n"
                   "0 !COLOUR Rubber_Black CODE 256 VALUE #1B2A34 EDGE #808080 RUBBER\n"
                   "0 !COLOUR Rubber_Mystery CODE 999 VALUE #000000 EDGE #000000\n")
    assert colour_aliases(cfg) == {256: 0}


def test_remap_colours_merges_counts():
    c = Counter({("92402", 256): 4, ("92402", 0): 1, ("3001", 4): 2})
    assert remap_colours(c, {256: 0}) == Counter({("92402", 0): 5, ("3001", 4): 2})


def test_omr_counter_strips_set_prefix_that_carries_a_version_suffix():
    truth = [[("41181-1 - 3068bpm1", 15, None), ("3068bpm1", 15, None), ("40272 - 3001", 4, None)]]
    assert omr_counter(truth) == Counter({("3068bpm1", 15): 2, ("3001", 4): 1})


def test_related_parts_never_queries_the_api_for_a_malformed_id(tmp_path):
    calls = []
    rb = Rebrickable("k", tmp_path, get=lambda url, headers: calls.append(url) or {}, pause=0, sleep=lambda s: None)
    assert rb.related_parts("weird name with spaces") == {"weird name with spaces"}
    assert rb.related_parts("42121 - 42924") == {"42121 - 42924"} and calls == []
