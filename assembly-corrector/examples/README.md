# Offline diagnosis demonstration

`demo.ldr` contains a matching LDCad connector pair and one deliberately missing
part. The tiny local library makes the example reproducible without downloading
LDraw assets. These files illustrate diagnostics only; they are not full LEGO meshes.

Run from the project root:

```bash
python ldraw_autostep.py examples/demo.ldr -o examples/demo_steps.ldr \
  --ldraw examples/ldraw --shadow-dir examples/shadow --offline \
  --report-json examples/demo_diagnosis.json --explain \
  --report-dot examples/demo_connections.dot --max-step 1 --strict
```

`--strict` returns **1 intentionally**, because `absent_demo.dat` does not exist.
Inspect `issues` for `missing_part`, `connections` for a `snap` edge, and
`steps_detail` for placement explanations. Remove the final line and rerun to
get a geometry-resolved, two-part demonstration.

The example already includes a generated JSON report, DOT diagram, SVG rendering,
and planned LDR output so the diagnostic format can be inspected immediately.
