# Standard Motion v4 — authored mechanism examples

These are **synthetic configuration examples, not an auto-verified LEGO 5590 setup**. Their part keys, world-space pivots and centres describe idealized test fixtures. Replace ALL placeholder instance keys, pivots, axes, parent relationships and any physical data before applying them to a real model. The four-bar fixture additionally assumes its three animated objects are assembled at translations (0,0,0), (2,0,0) and (5,0,0) with identity rotations. Gear fixture assumes two gear centres at (0,0,0) and (8,0,0).

- `gear-pair.example.json`: two parallel spur gear axes, 8:24 external tooth ratio.
- `four-bar.example.json`: numerical closure for a planar three-revolute open tree forming a four-bar loop.
- `gravity-pendulum.example.json`: opt-in one-coordinate mass/gravity/damping preview, with a **nonphysical cinematic return to rest** at the end.

Paste a fully adapted file under **Video → Planner → Standard Motion v4 → V4 mechanical demonstration → Apply mechanical program**, rebuild the timeline and review the *unverified* collision status. A part filename (e.g. `3647.dat`) is not an instance key. See [`../../STANDARD_MOTION_V4_PHASES_4_6.md`](../../STANDARD_MOTION_V4_PHASES_4_6.md).
