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
