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
