# LDraw AutoStep — geometry-aware step planning

Create logical building instructions (`0 STEP`) from LDraw `.ldr` and `.mpd` models. The planner
starts at the first part, follows compatible LDCad snap connectors when available, estimates
support and insertion feasibility, and groups complementary/mirrored parts into practical steps.

**Input fidelity is important:** all original `1 ...` part-reference lines are preserved
character-for-character (though they may be reordered). Comments, per-part metadata such as
`0 BFC INVERTNEXT`, and LSynth blocks are kept with their associated placements. Existing step
separators in processed submodels are regenerated. Unselected submodels are left unchanged.

## Install and run

Requires **Python 3.8+** and NumPy. There is no package installation step for the script itself.

```bash
python -m pip install numpy
python ldraw_autostep.py model.mpd -o model_steps.mpd
```

By default, referenced LDraw and LDCad shadow files are fetched on demand and cached under
`~/.cache/ldraw_autostep`. For reproducible/offline runs, point to existing libraries:

```bash
python ldraw_autostep.py model.mpd -o model_steps.mpd \
  --ldraw /path/to/ldraw --shadow-dir /path/to/LDCadShadowLibrary --offline
```

**Do not trust a geometry-free run as verified instructions.** When files are missing, the planner
uses small placeholder bounding boxes and reports the missing geometry. Snap and collision
information may be incomplete; providing local libraries is the most effective first fix.

## Diagnose *why* a step was chosen

The new `--explain` option records per-part geometry issues, links to previously placed parts,
insertion attempts (with candidate axes and blockers), support candidates, and selection reasons.
`--report-dot` creates an optional Graphviz connection diagram.

```bash
python ldraw_autostep.py model.mpd -o model_steps.mpd \
  --report-json diagnosis.json --explain \
  --report-dot connections.dot --strict

# Optional: with Graphviz installed, render the connection graph
dot -Tsvg connections.dot -o connections.svg
```

`--strict` **still writes** the model and diagnostic files, but returns exit code **1** if any
processed submodel has missing/partial geometry, floating parts or parts placed before their
estimated support. Other warnings (e.g., an unverified insertion direction) appear in the
explanation but do not automatically make strict mode fail. `--explain` requires `--report-json`.

### What you will find in diagnosis.json

The top level is a list, with one object per processed submodel. The familiar `units`, `steps`,
`missing_geometry`, `floating`, `unsupported`, `snap_links`, `fallback_links` and `notes` fields
are retained. New fields include:

| Field | Meaning |
|---|---|
| `geometry_stats` | Files parsed, transformed-bound evaluations, cache hits and evictions |
| `analysis_stats` | Candidate bounding-box and snap pairs compared with possible all-pairs checks; OBB rejections |
| `parts` (`--explain`) | 0-based unit ID, actual source line, target step, bounds, nested geometry issues, connector counts |
| `connections` (`--explain`) | Attachment endpoints, provenance, rigidity and snap-match count |
| `steps_detail` (`--explain`) | Per-step part IDs, selection reasons, previous/same-step neighbors, support and insertion attempts |
| `issues` (`--explain`) | Machine-readable issue codes, severities, related unit IDs and suggested next actions |

**Connection provenance** is particularly important. `snap` means a connector pair matched;
`contact` is a lower-confidence bounding-box fallback, and `component_bridge` means the planner
had to join otherwise disconnected snap components by geometric contact. The DOT diagram uses
solid blue edges for snap matches and dotted/dashed amber edges for approximations. Red-outlined
nodes indicate missing or partial geometry.

**Selection reasons** include `foundation`, `connected_insertion_verified`,
`connected_companion`, `mirror_companion`, `bonded_companion`, `insertion_unverified`,
`support_order_unverified` and `unconnected_proximity_fallback`. A reason explains *the planner's
heuristic decision*, not a proof that an assembly operation is physically possible. Final step
merging can place multiple individually chosen parts into one step.

### Diagnostic workflow

1. **Start with missing-geometry problems.** Inspect `parts[].geometry_issues`: errors include
   `missing_part`, `missing_subpart` (with the full dependency path), `geometry_cycle`, and
   `invalid_geometry_line`. Supply or repair the referenced `.dat` files.
2. **Check suspect attachments.** Filter `connections` for `contact` or `component_bridge`.
   These were inferred rather than established by matched connectors. Providing LDCad shadow
   data can eliminate false contacts.
3. **Check a difficult step.** Find the part ID in `steps_detail[].placements`. Look at
   `selection_reason`, `connected_to_earlier`, and `insertion.attempts[].blocked_by`. These
   contain the exact candidate unit IDs used by the diagnostics.
4. **Review the visual graph.** Look for islands, dashed bridges and parts with poor geometry
   coverage. Use `--contact-mode aabb` to compare against the older, less selective fallback.

Console output shows candidate counts and caps repetitive notes/issue examples so large models
are readable. The full records remain in the JSON file.

## What is more efficient, and what is more precise?

1. **Hierarchical geometry cache.** Part files are parsed only once. Rather than recursively
   expanding all nested vertices for every placed instance, the code retains local primitive
   vertices and child transformations. It computes exact extrema for transformed LDraw line,
   triangle, quad and conditional-line endpoints, caching orientation-dependent bounds in a
   bounded 4,096-entry LRU. Translated copies reuse those bounds.
2. **Missing-dependency tracing.** A partially readable part is no longer silently considered
   complete if some of its nested references are missing or cyclic.
3. **Spatial broad phase.** Sweep-and-prune finds candidate bounding-box and connector-segment
   pairs before detailed tests. This avoids the previous all-pairs floating-point overlap tensor
   and most comparisons between distant connectors.
4. **Conservative oriented-box rejection.** The default `--contact-mode obb` applies a separating-
   axis check to rotated local part boxes after their axis-aligned bounds overlap. This can
   reject false contacts caused solely by rotation. `--contact-mode aabb` disables that extra
   test to reproduce the earlier contact fallback behavior.
5. **Near-part fallback with incremental distances.** When no connection can be inferred,
   each new placement updates nearest-neighbor distances once, avoiding repeated nested Python
   distance searches. A union-find pass connects remaining contacting components.

These optimizations target common models with many repeated parts or spatially separated
connectors. **They do not make the geometry solver exact:** AABBs and OBBs are conservative
envelopes, not triangle-mesh collision shapes. The planner still stores some dense Boolean
relations (quadratic memory for extremely large submodels) and uses heuristic support and
insertion rules.

## Other options

| Option | Description |
|---|---|
| `-o`, `--output PATH` | Write the new model atomically (required) |
| `--max-step N` | Target number of parts per step (default `8`; one mirrored/bonded companion may exceed it) |
| `--ldraw DIR`, `--shadow-dir DIR` | Local LDraw and LDCad shadow library roots |
| `--cache DIR`, `--offline` | Change cache location; disable *all* downloads |
| `--no-shadow` | Disable LDCad snap matching and use geometric fallback only |
| `--contact-mode {obb,aabb}` | Rotated-box rejection (default) or AABB-only fallback |
| `--only NAME ...` | Process only named MPD submodels; leave the rest intact |
| `--subassemblies` | Experimental rigid-group extraction |
| `--sub-min N`, `--sub-max N` | Part-count range for extracted groups (defaults `3`, `40`) |
| `--report-json FILE`, `--explain` | Summary JSON; optional detailed per-part explanation |
| `--report-dot FILE` | Graphviz DOT file with each attachment's evidence |
| `--strict` | Nonzero exit on missing geometry, floating or unsupported units |
| `-q`, `--quiet` | Suppress console progress and summaries |

Files containing standalone raw LDraw geometry (types 2–5) are not reordered; they are not
independently placeable bricks. Assemblies that *only* reference MPD submodels are planned one
reference per step without loading part geometry. `--subassemblies` remains experimental.

## Testing

All standard tests use synthetic local parts and are **offline**. They cover exact hierarchical
bounds, caching and cycles, brute-force parity of spatial filtering, connector matching,
rotated-OBB rejection, clear diagnostic output, input fidelity and the supplied 5590 MPD.

```bash
python -m pip install pytest
python -m pytest tests -q
```

Optional integration tests require real LDraw and LDCad files. They may download assets if
local paths are not provided:

```bash
AUTOSTEP_REAL_LDRAW=1 python -m pytest tests/test_real_parts.py -q
```

Use `AUTOSTEP_LDRAW`, `AUTOSTEP_SHADOW`, and `AUTOSTEP_CACHE` to configure those tests. The
bundled `5590_-_whirl_n_wheel_super_truck_autostep.mpd` is the supplied example model,
**not** a fully regenerated, geometry-verified deliverable.
