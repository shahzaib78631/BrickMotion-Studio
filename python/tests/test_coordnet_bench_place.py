"""Placement benchmark bookkeeping."""
from coordnet import bench_place


def test_summary_counts():
    rows = [dict(step=1, exact=3, placed=3, needed=3, seconds=1.0, review=False, fallback=[]),
            dict(step=2, exact=1, placed=2, needed=2, seconds=3.0, review=True, fallback=["3001.dat|4"]),
            dict(step=3, exact=0, placed=0, needed=1, seconds=9.0, review=True, fallback=[]),
            dict(step=4, skipped="exploded")]
    s = bench_place.summary(rows)
    assert s["steps"] == 3 and s["skipped"] == 1
    assert s["exact_part_rate"] == 4 / 6
    assert s["exact_step_rate"] == 1 / 3
    assert s["median_seconds"] == 3.0
    assert s["fallback_rate"] == 1 / 3 and s["review_rate"] == 2 / 3
    assert s["unflagged_wrong"] == 0                   # every non-exact step was marked for review


def test_unflagged_wrong_steps_are_counted():
    rows = [dict(step=1, exact=1, placed=2, needed=2, seconds=1.0, review=False, fallback=[])]
    assert bench_place.summary(rows)["unflagged_wrong"] == 1
