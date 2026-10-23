import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { buildTimeline, poseAt } from "../../src/anim/timeline";
import { importLDraw } from "../../src/io/ldrawImport";
import { PartLibrary } from "../../src/ldraw/library";
import { measurePart, type PartMetrics } from "../../src/ldraw/metrics";
import { assemble, transformBox, type Metrics } from "../../src/model/assemble";
import { ensureIds } from "../../src/plan/ids";
import type { Plan } from "../../src/plan/types";
import type { ColorDef } from "../../src/ldraw/colors";
import { shadowLookupFrom } from "../../src/ldraw/shadow";

// Real 61-piece LDraw demo car, including its hollow wheel rims and tyres.
// This is a trimmed, redistributable copy of the LDraw files that accompanied
// the app; dependent subparts are needed to measure REAL part body bounds.
// The car fixture can live next to the tests or come from the local LDraw library
// (public/ldraw, installed by `npm run setup`). Without either, the test is skipped.
const fixtureRoot = join(__dirname, "..", "fixtures", "car-ldraw");
const libraryRoot = join(__dirname, "..", "..", "public", "ldraw");
const root = existsSync(join(fixtureRoot, "models", "car.ldr")) ? fixtureRoot : libraryRoot;
const hasCar = existsSync(join(root, "models", "car.ldr"));
const boxIntersects = (
  a: { min: number[]; max: number[] },
  b: { min: number[]; max: number[] },
) =>
  [0, 1, 2].every(
    (axis) =>
      Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]) >
      2,
  );

const colors = new Map<number, ColorDef>(
  [0, 4, 7, 36, 39, 46].map((code) => [
    code,
    {
      code,
      name: `${code}`,
      hex: "#eeeeee",
      edge: "#333333",
      alpha: 255,
      finish: "solid",
    },
  ]),
);

async function carFixture(): Promise<{
  metrics: Metrics;
  asm: ReturnType<typeof assemble>;
}> {
  const text = readFileSync(join(root, "models", "car.ldr"), "utf8");
  const plan = ensureIds(importLDraw(text, "car.ldr"));
  // Connector metadata, when installed (npm run setup:shadow), as the app uses it.
  const pack = join(__dirname, "..", "..", "public", "data", "ldcad-shadow.json");
  const shadow = existsSync(pack) ? shadowLookupFrom(JSON.parse(readFileSync(pack, "utf8")).files) : undefined;
  const lib = new PartLibrary(async (name) => {
    for (const prefix of ["parts", "p", "models", ""]) {
      const file = join(root, prefix, name);
      if (existsSync(file)) return readFileSync(file, "utf8");
    }
    return null;
  }, shadow);
  const ids = [
    ...new Set(
      plan.steps.flatMap((s) =>
        s.pieces.flatMap((p) => ("part" in p ? [p.part] : [])),
      ),
    ),
  ];
  const map = new Map<string, PartMetrics>();
  for (const id of ids) map.set(id, measurePart(await lib.loadPart(id), id));
  const metrics: Metrics = (id) => map.get(id)!;
  return { metrics, asm: assemble(plan, metrics, colors) };
}

test.skipIf(!hasCar)("LDraw car tyres enter from the axle side and NEVER go through the assembled body", async () => {
  const { asm, metrics } = await carFixture();
  expect(asm.instances).toHaveLength(61);
  const tl = buildTimeline(asm, metrics, {
    targetSeconds: 18,
    heroOrbit: true,
  });
  expect(tl.units.filter((u) => u.hidden)).toHaveLength(0);
  const tyres = asm.instances.filter((i) => i.part === "3641");
  expect(tyres).toHaveLength(4);
  for (const tyre of tyres) {
    const move = tl.tracks.get(tyre.key)!.moves[0];
    const unit = tl.units[move.unit];
    const nearAxle = poseAt(tl, unit.start + unit.dur * 0.73)(tyre.key)!;
    const sideX = nearAxle.elements[12];
    const finalX = tyre.world.elements[12];
    // With the shadow library the tyre arrives already on its rim (they are paired
    // as one wheel), so it only has to come in along the axle, clear of the holder.
    expect(Math.abs(sideX)).toBeGreaterThan(Math.abs(finalX) + 10);
    for (let f = 0; f <= 120; f++) {
      const ratio = f / 120;
      const t = unit.start + unit.dur * ratio;
      const at = poseAt(tl, t);
      const tyrePose = at(tyre.key);
      expect(tyrePose).not.toBeNull();
      const current = transformBox(metrics(tyre.part).body, tyrePose!);
      for (const other of asm.instances) {
        if (other.key === tyre.key) continue;
        // its own rim flies with it as one rigid wheel
        if (tl.tracks.get(other.key)?.moves[0].unit === move.unit) continue;
        // LDraw bricks genuinely fit together (e.g. rim inside the tyre).
        // Bounding boxes of holes/pegs therefore overlap at their targets;
        // that is permissible ONLY during the final aligned insertion.
        if (ratio >= 0.8 && boxIntersects(tyre.worldBox, other.worldBox))
          continue;
        const otherPose = at(other.key);
        if (!otherPose) continue;
        const obstacle = transformBox(metrics(other.part).body, otherPose);
        expect(
          boxIntersects(current, obstacle),
          `Tyre ${tyre.key} crossed ${other.part} (${other.key}) at ${t.toFixed(3)}s`,
        ).toBe(false);
      }
    }
  }
});

test("an overhanging roof forces a side insertion instead of a vertical plunge", () => {
  const basis: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const plan: Plan = ensureIds({
    format: "brickmotion-plan",
    version: 1,
    name: "Tyre under a roof",
    steps: [
      { pieces: [{ part: "roof", color: 4, ldu: [0, 0, 0], matrix: basis }] },
      {
        pieces: [{ part: "tyre", color: 4, ldu: [-40, 20, 0], matrix: basis }],
      },
    ],
  });
  const boxes = new Map([
    [
      "roof",
      {
        min: [-50, -50, -50] as [number, number, number],
        max: [50, -20, 50] as [number, number, number],
      },
    ],
    [
      "tyre",
      {
        min: [-6, -16, -16] as [number, number, number],
        max: [6, 16, 16] as [number, number, number],
      },
    ],
  ]);
  const metrics: Metrics = (part) => ({
    id: part,
    body: boxes.get(part)!,
    full: boxes.get(part)!,
    heightPlates: 3,
    footprint: { w: 2, d: 2 },
    placeholder: false,
  });
  const asm = assemble(plan, metrics, colors);
  const tl = buildTimeline(asm, metrics, {
    targetSeconds: 15,
    heroOrbit: true,
  });
  const tyre = asm.instances.find((i) => i.part === "tyre")!;
  const roof = asm.instances.find((i) => i.part === "roof")!;
  const unit = tl.units[tl.tracks.get(tyre.key)!.moves[0].unit];
  expect(unit.hidden).toBeFalsy();
  for (let f = 0; f <= 120; f++) {
    const t = unit.start + (unit.dur * f) / 120;
    const pose = poseAt(tl, t);
    const tyreMat = pose(tyre.key)!;
    const roofMat = pose(roof.key)!;
    expect(
      boxIntersects(
        transformBox(metrics("tyre").body, tyreMat),
        transformBox(metrics("roof").body, roofMat),
      ),
    ).toBe(false);
  }
});
