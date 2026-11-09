"""Overlaps and free connectors of placed parts (python/lab/world.py)."""
import math
import os
import sys
import time
from pathlib import Path

import numpy as np
import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, 'bricknet'))

D = Path('/Users/mac/Projects/BrickMotion-Data/bricknet')
COMPAT = Path('/Users/mac/Projects/BrickMotion-Data/lab/compat.json')
pytestmark = pytest.mark.skipif(not COMPAT.exists(), reason='run python -m lab.connectors first')


@pytest.fixture(scope='module')
def env():
    import decode
    from lab.connectors import Connectors, load_compat
    return decode, Connectors(decode.Catalog(D)), load_compat(COMPAT)


def world(env):
    from lab.world import World
    return World(env[1], env[2])


def pid(env, stem):
    return env[1].cat.stems.index(stem)


def at(x=0.0, y=0.0, z=0.0, yaw=0.0):
    c, s = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
    return np.array([[c, 0, s, x], [0, 1, 0, y], [-s, 0, c, z], [0, 0, 0, 1.0]])


def test_stacked_plates_do_not_collide(env):
    w = world(env)
    w.add(pid(env, '3020'), 4, at())
    assert not w.collides(pid(env, '3020'), at(y=-8))


def test_same_spot_collides(env):
    w = world(env)
    w.add(pid(env, '3001'), 4, at())
    assert w.collides(pid(env, '3001'), at())


def test_half_overlap_collides(env):
    w = world(env)
    w.add(pid(env, '3001'), 4, at())
    assert w.collides(pid(env, '3001'), at(x=10))


def test_rotated_45_collides(env):
    w = world(env)
    w.add(pid(env, '3001'), 4, at())
    assert w.collides(pid(env, '3001'), at(yaw=45))


def test_side_by_side_touching_ok(env):
    w = world(env)
    w.add(pid(env, '3001'), 4, at())
    assert not w.collides(pid(env, '3001'), at(z=40))  # 3001 is 2 studs deep along z... and 4 along x
    assert not w.collides(pid(env, '3001'), at(x=80))


def test_real_models_mostly_clean(env):
    from lab.sequence import poses, to_steps
    decode, conn, _ = env
    arrs = decode.load(D / 'val.npz')
    flagged = total = 0
    for i in range(min(300, len(arrs['node_ptr']) - 1)):
        pids, colors, edges = decode.model(arrs, i)
        order, _ = decode.realise(conn.cat, pids, edges)
        steps = to_steps(pids, colors, edges, order[0], conn)
        w = world(env)
        for s, m in zip(steps, poses(steps, conn)):
            flagged += w.collides(s['part'], m, s['parent'])
            total += 1
            w.add(s['part'], s['colour'], m)
    print(f'{flagged}/{total} flagged')
    assert flagged / total <= 0.05  # joints the connector data does not know (bars in hollow studs, wheels) cost ~4%


def test_studs_freed_and_taken(env):
    w = world(env)
    b = pid(env, '3001')
    lo = w.add(b, 4, at())
    hi = w.add(b, 4, at(y=-24))
    types = env[1].types(b)
    studs = lambda i: [c for c in w.free(i) if types[c].startswith('stud/')]  # noqa: E731
    assert len(studs(lo)) == 0
    assert len(studs(hi)) == 8


def test_baseplate_step_under_1s(env):
    w = world(env)
    w.add(pid(env, '3811'), 2, at())
    t = time.perf_counter()
    w.free(0)
    w.collides(pid(env, '3001'), at(y=-24))
    assert time.perf_counter() - t < 1.0


def test_pose_for_matches_sequence(env):
    from lab.sequence import poses, to_steps
    decode, conn, _ = env
    arrs = decode.load(D / 'val.npz')
    pids, colors, edges = decode.model(arrs, 3)
    order, _ = decode.realise(conn.cat, pids, edges)
    steps = to_steps(pids, colors, edges, order[0], conn)
    want = poses(steps, conn)
    w = world(env)
    w.add(steps[0]['part'], steps[0]['colour'], want[0])
    for s, m in zip(steps[1:], want[1:]):
        got = w.pose_for(s['parent'], s['pconn'], s['part'], s['oconn'], s['kind'],
                         {k: s[k] for k in ('a1', 'a2', 'a3', 'flip')})
        assert np.allclose(got, m, atol=1e-6)
        w.add(s['part'], s['colour'], got)
    assert 'BrickNet' in w.to_ldr('t', 'caption')


def test_pushed_into_parent_collides(env):
    """Its parent may interlock with it a little, not swallow half of it."""
    w = world(env)
    w.add(pid(env, '3001'), 4, at())
    assert w.collides(pid(env, '3001'), at(y=-12), parent=0)
    assert not w.collides(pid(env, '3001'), at(y=-24), parent=0)


def test_upright_turns_a_tipped_model_back(env):
    """A set built from a sideways first part comes out tipped over; upright() turns it by a right
    angle so most parts stand the way they do in real sets."""
    import numpy as np
    from lab.world import upright
    tip = np.array([[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1.0]])  # 90 degrees about x
    poses = [tip @ np.array([[1, 0, 0, 0], [0, 1, 0, -24.0 * k], [0, 0, 1, 0], [0, 0, 0, 1]]) for k in range(4)]
    poses.append(np.eye(4))  # one part that really is on its side in the tipped model
    fixed = upright(poses)
    assert sum(np.allclose(m[:3, 1], [0, 1, 0]) for m in fixed) == 4
