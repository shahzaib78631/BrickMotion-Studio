"""A booklet may build the model file's models in another order than the file lists them (40413 builds its six
characters blast, charlie, gelo, mvp, mvpshooter, tricky; the file lists gelo first). Counts alone cannot tell
the models apart, so the audit fits the booklet as one contiguous stretch per model, by how its callout pictures
look like each model's parts, and tries the models in that order."""
import numpy as np

from booklet_mpd.audit import block_order, model_blocks, segment_blocks


def test_model_blocks_follow_the_root_models():
    children = {"main": ["gelo", "blast"], "gelo": ["geloleg"], "blast": ["arm"], "geloleg": [], "arm": []}
    files = ["gelo", "geloleg", "gelo", "blast", "arm", "blast"]
    assert model_blocks(files, children, "main") == [0, 0, 0, 1, 1, 1]


def test_segments_find_the_order_the_booklet_builds_in():
    # six booklet steps that look like model 2, then model 0, then model 1 (with a little noise)
    looks = np.array([[0, .1, 1], [.2, 0, .9], [1, 0, 0], [.9, .3, 0], [0, 1, .1], [.1, .8, .5]])
    assert segment_blocks(looks, switch=0.2) == [2, 0, 1]


def test_a_noisy_step_does_not_open_a_model_of_its_own():
    looks = np.array([[1, 0], [1, 0], [0, .1], [1, 0], [0, 1], [0, 1]])
    assert segment_blocks(looks, switch=0.2) == [0, 1]


def test_steps_are_regrouped_by_model_in_that_order():
    order = [0, 1, 2, 3, 4, 5]
    blocks = [0, 0, 1, 1, 2, 2]
    assert block_order(order, blocks, [2, 0]) == [4, 5, 0, 1, 2, 3]     # model 1 never seen: it keeps its turn after


def test_group_look_averages_the_groups_that_have_pictures():
    from booklet_mpd.audit import group_look
    look = lambda b, o: None if b == [2] else (1.0 if b[0] == o[0] else 0.5)
    assert group_look(look, [([0], [0]), ([1], [5]), ([2], [2])]) == 0.75
    assert group_look(None, [([0], [0])]) == 0.0


def test_many_models_are_ordered_quickly():
    # 30 models built in reverse order, 4 steps each: exact subset search would never finish
    import time
    n = 30
    looks = np.zeros((4 * n, n))
    for i in range(4 * n):
        looks[i, n - 1 - i // 4] = 1.0
    t = time.time()
    assert segment_blocks(looks, switch=0.2) == list(range(n - 1, -1, -1))
    assert time.time() - t < 5
