import pytest
from collections import Counter

from booklet_mpd.align import align_steps, count_similarity, multiset_similarity

sim = count_similarity


def test_identical_sequences_align_diagonally():
    a = align_steps([3, 5, 7], [3, 5, 7], sim)
    assert a.ok and a.pairs == [(0, 0), (1, 1), (2, 2)] and a.reason == ""


def test_missing_middle_step_is_a_gap_and_not_ok():
    a = align_steps([3, 7], [3, 5, 7], sim)
    assert a.pairs == [(0, 0), (None, 1), (1, 2)]
    assert not a.ok and "unmatched" in a.reason


def test_extra_booklet_step_at_end():
    a = align_steps([3, 5, 7, 9], [3, 5, 7], sim)
    assert a.pairs[-1] == (3, None)


def test_different_sequences_not_ok():
    a = align_steps([1, 1, 1], [9, 9, 9], sim)
    assert not a.ok and a.mean_similarity < 0.8


def test_multiset_similarity():
    assert multiset_similarity(Counter({("3001", 4): 2}), Counter({("3001", 4): 1})) == 0.5
    assert multiset_similarity(Counter(), Counter()) == 0.0
    assert count_similarity(0, 3) == 0.0


from booklet_mpd.align import align_merged


def test_merged_run_matches_one_omr_step():
    a = align_merged([2, 6, 3, 1, 1], [2, 6, 5])
    assert a.runs == [([0], 0), ([1], 1), ([2, 3, 4], 2)] and a.ok


def test_merged_extra_booklet_step_is_skipped_not_fatal():
    a = align_merged([2, 6, 40, 3], [2, 6, 3])
    assert a.ok and a.runs[-1] == ([3], 2) and a.extra_booklet == [2]


def test_merged_unmatched_omr_step_makes_not_ok():
    a = align_merged([2, 6], [2, 6, 50])
    assert not a.ok and a.unmatched_omr == [2]


def test_merged_empty_inputs():
    a = align_merged([], [])
    assert not a.ok


from booklet_mpd.align import align_groups


def test_groups_one_to_one():
    g = align_groups([2, 6, 3], [2, 6, 3])
    assert g.ok and g.groups == [([0], [0]), ([1], [1]), ([2], [2])]


def test_groups_merge_on_either_side():
    # booklet step 1 = OMR steps 1+2 (2+3=5); OMR step 2 = booklet steps 2+3 (1+1=2)
    g = align_groups([2, 5, 1, 1], [2, 2, 3, 2])
    assert g.groups == [([0], [0]), ([1], [1, 2]), ([2, 3], [3])]
    assert g.ok and g.booklet_coverage == 1.0 and g.omr_coverage == 1.0


def test_groups_extra_steps_lower_coverage():
    g = align_groups([2, 40, 3], [2, 3])
    assert g.booklet_coverage == pytest.approx(2 / 3) and g.omr_coverage == 1.0 and not g.ok


def test_groups_empty():
    assert not align_groups([], []).ok


def test_groups_prefer_one_contiguous_block_over_scattered_matches():
    g = align_groups([1, 1, 1, 1], [5, 1, 5, 1, 5, 1, 1, 1, 1, 5])
    assert g.groups == [([0], [5]), ([1], [6]), ([2], [7]), ([3], [8])]
    assert g.booklet_coverage == 1.0 and g.omr_coverage == 0.4


def test_groups_unmatched_models_at_the_end_cost_nothing():
    """40353: the booklet builds two of three figures. Its last steps (4, 2, 3, 5 parts) match the second
    figure's last answer-key steps exactly; the third figure's steps follow, and their tail also happens to
    hold 4, 2, 3, 5 parts. Leaving a whole figure unmatched at the end must not cost more than skipping it in
    the middle, or the booklet's last steps get paired with the wrong figure."""
    figure2 = [3, 4, 4, 2, 2, 2, 4, 2, 3, 1, 4]
    figure3 = [1, 4, 4, 2, 3, 3, 2, 1, 2, 3, 6, 2, 2, 5, 1, 4, 2, 2, 2, 4, 2, 3, 2, 3]
    booklet = [3, 4, 4, 2, 2, 2, 4, 2, 3, 5]
    g = align_groups(booklet, figure2 + figure3)
    assert g.groups[-1] == ([9], [9, 10])
    assert all(o < len(figure2) for _b, os in g.groups for o in os)


def test_groups_parts_look_decides_between_equal_counts():
    """Two OMR runs hold the same totals; the parts-list pictures look like the second."""
    look = lambda b, o: 0.9 if min(o) >= 2 else 0.2
    assert [o for _b, o in align_groups([2, 3], [2, 3, 2, 3], part_sim=look).groups] == [[2], [3]]
    look = lambda b, o: 0.9 if max(o) <= 1 else 0.2
    assert [o for _b, o in align_groups([2, 3], [2, 3, 2, 3], part_sim=look).groups] == [[0], [1]]
