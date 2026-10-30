# Phase 4 — Gearbox Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recognise driving rings and clutch gears from measured geometry, build each gearbox's mode table (neutral, every gear, lock-ups) without running the solver, and let playback shift gears without any part jumping.

**Architecture:** A new `src/anim/motion/gearbox/` module holds three pure pieces: shift elements (ring + coaxial clutch gears + slide travel, from part seats), a body-rate network (meshes plus locked differentials), and the mode table (linear algebra over that network for every ring state). The solver's existing `clutch` transmission gains a phase offset and a dog-alignment check, so engaging mid-motion keeps the current pose. Suggestions offer one program per gear, and the Lab shows the ratio table and plays a shift track.

**Tech Stack:** TypeScript, three.js, vitest, React (Lab panel).

**Spec:** `docs/superpowers/specs/2026-10-30-mechanism-recognition-design.md` §4 (gearbox shifting), §7 (benchmarks: `shiftModes` check), §8 row 4 (acceptance).

## Global Constraints

- Acceptance (§8): "Ratio table matches the set's manual on the gearbox benchmark; a shift during playback never jumps".
- §4.1: the mode table is found "without running the solver".
- §4.3: a contradiction ("two gears engaged at once, or a lock-up") "is reported as a crash, not hidden".
- §4.4: "engagement only happens within half a tooth of alignment; otherwise the selector stalls at the boundary".
- Nothing hard-coded per part number: rings, clutches and travel come from measured seats and rods (`partFunctions`), as in Phase 3.
- Benchmark positions are world-box centres (LDU, LDraw axes, -Y up); `toleranceLdu` 6.
- Sources: model files are LDraw OMR (CC BY 2.0); Kinebrick (CC BY-SA 4.0) is used only as an oracle and credited.
- Commit on `feat/v8-review` only, never push; every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `tests/anim/minifigInsertion` fails before this work; leave it.

## Findings this plan is built on (8880 Super Car, `samples/8880-1.mpd`)

- Two driving rings `6539` at box centres [-20,-54,60] (body #12) and [20,-54,60] (#13) sit on axle joiners `6538a` of shafts #10 / #11, each between two clutch gears `6542a` at z=30 and z=90. The rings get **no joint**: the joiner's shadow data has no outer connector. Phase 4 pairs the ring with the joiner's measured rod instead.
- Measured seats (42000's identical `6539`/`6542b`): ring dogs = M seat r13, width 40 at the ring centre; clutch socket = F seat r15, width 12 centred 4 LDU along the gear's +z. So with the gears 30 LDU from the ring centre, the dogs just touch the sockets at rest (neutral), engage after 2 LDU of travel, and bottom out at 12 LDU.
- The engine reaches the gearbox through a chain (`3711` links, Phase 6) from the crank's `4019@[0,-134,390]` to `4019@[20,-54,390]` on shaft #11, 16:16. The ratio table is therefore measured from `4019@[20,-54,390]`, which turns 1:1 with the crank.
- By hand through the detected meshes (centre and rear differentials locked, as when driving straight), shaft #11 to rear differential `6573@[0,-54,500]` gives 2.25, 1.5, 0.75 and 0.5 input turns per output turn. That is Kinebrick's 8880 oracle (engine turns per wheel turn).
- **Model-file defect:** the 8T gear `3647@[-60,-14,-70]` (body #222) is on no axle. Nothing lies on its line between it and joiner `6538a@[-60,-14,80]`, so 2nd (1.5) and 4th (0.5) never reach the wheels. Fix in the file: an Axle 8 (`3707`) centred at (-60,-14,0) along z. The benchmark keeps the manual's four ratios and reports these two as misses with this reason; a test supplies the missing axle as a lock to prove the algorithm.
- The 4-speed lever `6549` (body #94) has only a ball joint to the frame. Its foot sits between the two rings with no connector to them (Kinebrick also marks it unjoined). Phase 4 therefore animates the rings directly as the selector (§4.2: "the selector … is an ordinary driver"). Driving the lever through the H-gate is out of scope.
- Phase 3 gaps seen in 8880 (scored by the new benchmark, not fixed here): both cylinder blocks `2850a` hang on one hinge each, so the engine reads as 8 suspensions; no steering suggestion; the rear rack `3743@[-40,-71,430]` has no pinion pair.

## Review Focus

1. A ring with a clutch gear on only one side (42000-style selector with one gear, or a gear removed) → the travel on the empty side matches the other side, and the table has neutral plus one gear. Owner: Task 1.
2. Two rings engaged at once whose paths disagree → mode state `locked`, never a made-up ratio; the solver refuses that engagement by name. Owners: Tasks 2 and 4.
3. Shifting while the dogs are misaligned → no engagement and no jump; the shift is reported as stalled and is retried until the shafts line up. Owner: Task 4.
4. Input or output not connected to the gearbox in any mode (wrong part picked, missing axle) → every row is `neutral`, and the benchmark says the output is not reached instead of crashing. Owners: Tasks 2 and 3.
5. Models with no gearbox (5590, 42000 drive trains) → no shift elements, no gearbox suggestions, and the Phase 3 benchmark scores unchanged (5590 17/17, 42000 phase 3 16/18). Owners: Tasks 1 and 5.

---

### Task 1: Shift elements from measured seats

**Files:**
- Create: `src/anim/motion/gearbox/shiftElements.ts`
- Test: `tests/anim/gearbox/shiftElements.test.ts`

**Interfaces:**
- Consumes: `partFunctions(part)` (`seats`, `rods`) from `parts/partFunctions.ts`; `Recognition` (`bodies`, `bodyOf`) from `mobility/recognise.ts`.
- Produces:
  ```ts
  export type Span = [number, number];                 // along the ring axis, LDU, at rest
  export const ENGAGE_MIN = 2;                          // LDU of dog overlap that counts as engaged
  export const DOGS = 4;                                // dogs per ring (pitch 2π/4)
  export function dogOverlap(dogs: Span, socket: Span, s: number): number;
  export function ringTravel(dogs: Span, sockets: readonly Span[]): Span;   // [min,max] slide, LDU
  export type ShiftCoupling = { gear: string; gearBody: number; side: 1 | -1; engageAt: number };
  export type ShiftElement = {
    ring: string; ringBody: number; shaftBody: number;
    axis: [number, number, number]; centre: [number, number, number];
    travel: Span; couplings: ShiftCoupling[]; dogs: number;
  };
  export function findShiftElements(asm: Assembly, rec: Recognition): ShiftElement[];
  ```

Rules (geometry the tests pin):
- **Ring:** a part with an M seat whose width is at least 30 (the dog sleeve). It lies coaxial (axes within 4°, centre within 2.5 LDU of the line) with a rod segment of a part in another body. That body is `shaftBody`.
- **Coupling:** a part in a third body with teeth and an F seat that is coaxial with the dogs, with `dogR ≤ socketR ≤ dogR + 4`. `side` is the sign of (socket centre − ring centre) along `axis`.
- `engageAt` = the smallest |s| on that side with `dogOverlap ≥ ENGAGE_MIN`.
- `ringTravel`: on a side with sockets, the slide ends where the dogs bottom out (`socket far end − dog end`). A side without a socket mirrors the other side.

- [ ] **Step 1: Write the failing tests**

```ts
describe('dog geometry', () => {
  it('overlap grows with travel and stops at the socket bottom', () => {
    expect(dogOverlap([-20, 20], [20, 32], 0)).toBe(0);
    expect(dogOverlap([-20, 20], [20, 32], 5)).toBe(5);
    expect(dogOverlap([-20, 20], [20, 32], 15)).toBe(12);
  });
  it('travel ends where the dogs bottom out, mirrored on an empty side', () => {
    expect(ringTravel([-20, 20], [[20, 32], [-32, -20]])).toEqual([-12, 12]);
    expect(ringTravel([-20, 20], [[20, 32]])).toEqual([-12, 12]);
  });
});
describe.skipIf(!partDataInstalled())('real gearboxes', () => {
  it('8880: two rings, each between two clutch gears, neutral at rest', async () => {
    // load samples/8880-1.mpd with loadRealModel, inspectMechanisms → rec
    const els = findShiftElements(asm, rec);
    expect(els.map(e => at(e.ring))).toEqual(expect.arrayContaining([[-20, -54, 60], [20, -54, 60]]));
    for (const e of els) {
      expect(e.couplings.map(c => c.side).sort()).toEqual([-1, 1]);
      expect(e.travel[0]).toBeCloseTo(-12, 0); expect(e.travel[1]).toBeCloseTo(12, 0);
      for (const c of e.couplings) expect(Math.abs(c.engageAt)).toBeCloseTo(2, 0);
      expect(rec.bodies[e.shaftBody]).toContain(key('6538a', [e.centre[0], -54, 60]));
    }
  });
  it('42000: the function selector ring on 6538b couples both 6542b gears', async () => {
    const [e] = findShiftElements(asm42000, rec42000);
    expect(at(e.ring)).toEqual([-100, -40, 450]);
    expect(e.couplings.map(c => at(c.gear)).sort()).toEqual([[-130, -40, 450], [-70, -40, 450]]);
  });
  it('5590 has no shift elements', async () => { expect(findShiftElements(asm5590, rec5590)).toEqual([]); });
});
```
(`at(key)` = rounded world-box centre; `key(part, at)` = instance key found by part and centre. Both are local test helpers.)

- [ ] **Step 2: Run to verify they fail**
Run: `npx vitest run tests/anim/gearbox/shiftElements.test.ts`
Expected: FAIL, cannot resolve `src/anim/motion/gearbox/shiftElements`.

- [ ] **Step 3: Implement `shiftElements.ts`** to the rules above. Seats and rods are in part space: transform their centres and axes by each instance's `world` matrix.

- [ ] **Step 4: Run to verify they pass**
Run: `npx vitest run tests/anim/gearbox/shiftElements.test.ts`
Expected: PASS (5 tests; the real-model ones skip without part data).

- [ ] **Step 5: Commit**
```bash
git add src/anim/motion/gearbox/shiftElements.ts tests/anim/gearbox/shiftElements.test.ts
git commit -m "feat(gearbox): recognise driving rings and clutch gears from measured seats"
```

### Task 2: Rate network and mode table

**Files:**
- Create: `src/anim/motion/gearbox/shiftModes.ts`
- Test: `tests/anim/gearbox/shiftModes.test.ts`

**Interfaces:**
- Consumes: `ShiftElement` (Task 1); `HigherPair`; `NamedMechanism` (kind `differential`: `drivers[0]` carrier, `outputs` sides); `projectLinearConstraints` and `LinearEquation` from `v4/transmissionNetwork.ts`.
- Produces:
  ```ts
  export type RateNetwork = {
    meshes: { a: number; b: number; teethA: number; teethB: number; pair: string }[];
    /** Bodies that turn together: locked differentials (driving straight). */
    locks: [number, number][];
  };
  export function rateNetwork(rec: Recognition, pairs: readonly HigherPair[], named: readonly NamedMechanism[]): RateNetwork;
  export type GearMode = {
    id: string; label: string;
    engaged: { ring: string; gear: string }[];
    state: 'drive' | 'neutral' | 'locked';
    /** Input turns per output turn, unsigned; only when state is 'drive'. */
    ratio?: number;
  };
  export function shiftModes(net: RateNetwork, shifts: readonly ShiftElement[], input: number, output: number): GearMode[];
  ```

Algorithm (decided here):
- **Unknowns:** one angular rate per recognition body.
- **Equations:**
  - per mesh `teethA·ωa + teethB·ωb = 0` (spur, bevel, crown; rack, worm and screw pairs are left out);
  - per lock `ωx − ωy = 0`;
  - per shift element `ω_ring − ω_shaft = 0` always;
  - per engaged coupling `ω_gear − ω_shaft = 0`;
  - `ω_input = 1`.
- **Modes:** enumerate every ring state (neutral or one coupling), the product over rings, capped at 4 rings (3⁴ = 81 rows). The all-neutral row comes first; drive rows follow, sorted by ratio, largest first.
- **State:** solve with `projectLinearConstraints`.
  - Residual above 1e-6 → `locked`.
  - Otherwise add `ω_output = 0` and solve again. Still consistent → `neutral` (the output is not tied to the input).
  - Else `drive`, with `ratio = 1/|ω_output|`.

- [ ] **Step 1: Write the failing tests**

```ts
// Synthetic two-speed box. Bodies: 0 input shaft, 1 low gear (30T, free on 0), 2 high gear (10T, free on 0),
// 3 output (low pinion 10T meshes 1; high gear 30T meshes 2), 4 ring on 0.
const net: RateNetwork = { meshes: [{ a: 1, b: 3, teethA: 30, teethB: 10, pair: 'p1' }, { a: 2, b: 3, teethA: 10, teethB: 30, pair: 'p2' }], locks: [] };
const ring = { ring: 'r', ringBody: 4, shaftBody: 0, couplings: [{ gear: 'g1', gearBody: 1, side: -1, engageAt: -2 }, { gear: 'g2', gearBody: 2, side: 1, engageAt: 2 }] } as ShiftElement;
it('neutral, then each gear with its ratio', () => {
  const m = shiftModes(net, [ring], 0, 3);
  expect(m[0]).toMatchObject({ state: 'neutral', engaged: [] });
  expect(m.filter(x => x.state === 'drive').map(x => x.ratio)).toEqual([3, 1 / 3].map(r => expect.closeTo(r, 9)));
});
it('two rings that disagree lock up', () => {
  const second = { ...ring, ring: 'r2', ringBody: 5, couplings: [{ ...ring.couplings[1], gear: 'g2b' }] } as ShiftElement;
  expect(shiftModes(net, [ring, second], 0, 3).find(x => x.engaged.length === 2 && x.engaged.some(e => e.gear === 'g1'))?.state).toBe('locked');
});
it('an output the gearbox never reaches is neutral in every row', () => {
  expect(shiftModes(net, [ring], 0, 99).every(x => x.state === 'neutral')).toBe(true);
});
describe.skipIf(!partDataInstalled())('8880 Super Car', () => {
  // input = body of 4019@[20,-54,390], output = body of 6573@[0,-54,500]
  it('as modelled: 1st and 3rd match the manual; 2nd and 4th stop at the axle-less 3647', async () => {
    const drive = modes.filter(m => m.engaged.length === 1 && m.state === 'drive').map(m => m.ratio);
    expect(drive).toEqual([expect.closeTo(2.25, 3), expect.closeTo(0.75, 3)]);
  });
  it('with the missing axle supplied, all four ratios match the manual', async () => {
    const fixed = { ...net, locks: [...net.locks, [bodyOf('3647', [-60, -14, -70]), bodyOf('6538a', [-60, -14, 80])]] };
    const drive = shiftModes(fixed, shifts, input, output).filter(m => m.engaged.length === 1 && m.state === 'drive').map(m => m.ratio);
    expect(drive).toEqual([2.25, 1.5, 0.75, 0.5].map(r => expect.closeTo(r, 3)));
  });
});
```

- [ ] **Step 2: Run to verify they fail**
Run: `npx vitest run tests/anim/gearbox/shiftModes.test.ts`
Expected: FAIL, cannot resolve `shiftModes`.

- [ ] **Step 3: Implement `rateNetwork` and `shiftModes`** in `src/anim/motion/gearbox/shiftModes.ts` as decided above.

- [ ] **Step 4: Run to verify they pass**
Run: `npx vitest run tests/anim/gearbox/shiftModes.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**
```bash
git add src/anim/motion/gearbox/shiftModes.ts tests/anim/gearbox/shiftModes.test.ts
git commit -m "feat(gearbox): mode table from the gear network, without the solver"
```

### Task 3: Lab report, benchmark checks and the 8880 benchmark

**Files:**
- Modify: `src/anim/motion/v4/mechanismLab.ts` (`LabReport`, `inspectMechanisms`)
- Modify: `src/anim/motion/benchmark/mechanismBenchmark.ts` (`BenchmarkCheck`, scorer)
- Create: `benchmarks/mechanisms/8880.expected.json`; results refreshed with `BENCH_WRITE=1`
- Modify: `benchmarks/mechanisms/README.md` (8880 source and the axle defect)
- Test: `tests/anim/mechanismBenchmark.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `LabReport.gearbox: { shifts: ShiftElement[]; network: RateNetwork }` (always present; empty lists without a gearbox).
  - Two new check types:
    ```ts
    | { type: 'shifts'; label: string; ring: PartRef; gears: PartRef[] }
    | { type: 'shiftMode'; label: string; input: PartRef; output: PartRef; ratio: number | null }
    ```
  - `shifts` hits when the ring is a shift element whose couplings include every gear.
  - `shiftMode` with a number hits when one single-ring drive row is within 2 % of `ratio`. With `null` it hits when the all-neutral row is `neutral`.
  - A miss gives one of these details:
    - the table's drive ratios;
    - "output not reached in any mode";
    - "no shift elements".

The 8880 benchmark (`model.file` `samples/8880-1.mpd`, sha256 `68c6bfffe183cdf552024dda7651dcfcdad2fbd99cbd47eb533234b5f9a6f3ce`, `toleranceLdu` 6):

- **notes:**
  - the OMR source (Orion Pobursky, CC BY 2.0, library.ldraw.org/omr/sets/908);
  - the Kinebrick oracle (`tests/sets/8880-super-car.test.ts`, CC BY-SA 4.0: engine turns 2.25, 1.5, 0.75 and 0.5 per wheel turn);
  - the chain from the crank to `4019@[20,-54,390]` (Phase 6), which is why the input is that gear;
  - the axle missing at `3647@[-60,-14,-70]`, with its fix.
- **`gearbox` (phase 4):**
  - `shifts` ×2: ring [-20,-54,60] → gears `6542a` [-20,-54,30] and [-20,-54,90]; ring [20,-54,60] → [20,-54,30] and [20,-54,90].
  - `shiftMode` ×5, input `4019` [20,-54,390], output `6573` [0,-54,500]: neutral `null`, then 1st 2.25, 2nd 1.5, 3rd 0.75, 4th 0.5.
- **`gearbox-meshes` (phase 3):**
  - `gearMesh` spur `6542a` [20,-54,30] ↔ [-20,-54,30];
  - `gearMesh` spur `3648a` [-20,-54,-10] ↔ `3647` [20,-54,-10];
  - `gearMesh` spur `4019` [30,-14,470] ↔ `6573` [0,-54,500].
- **`steering` (phase 3):**
  - `function` kinds `rack-steering`/`steering`, driver `2741` [120,-183,52], moves front rack `3743` [-40,-67,-110] and rear rack `3743` [-40,-71,430];
  - `rackPinion` `4019` [-30,-94,-110] → `3743` [-40,-67,-110];
  - `gearMesh` spur `3650c` [120,-122,-38] ↔ [60,-122,-39].
- **`engine` (phase 3):**
  - `rotates` `2853` [5,-134,440] axis [0,0,1];
  - `slides` `2851` [46,-159,440] axis [0.92,-0.4,0];
  - `function` kinds `piston-engine`, driver `2853` [5,-134,440], moves `2851` [46,-159,440] and [-30,-152,440].

- [ ] **Step 1: Write the failing scorer tests** (in the style of the existing file: a stub `LabReport` with a `gearbox` field)

```ts
it('scores a gear ratio from the mode table and a neutral row', () => {
  // asm stub with parts: input 3706@[0,0,0] body 0, output 3706@[0,0,40] body 3; gearbox = the synthetic two-speed box from Task 2
  const r = scoreMechanismBenchmark(specWith([
    { type: 'shiftMode', label: 'low', input: IN, output: OUT, ratio: 3 },
    { type: 'shiftMode', label: 'neutral', input: IN, output: OUT, ratio: null },
    { type: 'shiftMode', label: 'missing', input: IN, output: OUT, ratio: 2 }]), asm, report);
  expect(r.checks.map(c => c.status)).toEqual(['hit', 'hit', 'missing']);
  expect(r.checks[2].detail).toMatch(/3\.00.*0\.33/);
});
it('scores a recognised ring and its gears', () => { /* shifts check → 'hit'; with a gear it lacks → 'missing' */ });
```

- [ ] **Step 2: Run to verify they fail**
Run: `npx vitest run tests/anim/mechanismBenchmark.test.ts`
Expected: FAIL; the new check types are not handled (`status` undefined, or a type error).

- [ ] **Step 3: Implement.**
  - `inspectMechanisms` fills `gearbox` with `findShiftElements(asm, rec)` and `rateNetwork(rec, higherPairs, classify(...))`, reusing the classification already computed for suggestions.
  - The scorer resolves the input and output to bodies through `report.graph.recognition.bodyOf`, then calls `shiftModes`.
  - Write `8880.expected.json` exactly as listed, and add its README entry.

- [ ] **Step 4: Run the tests and the benchmark**
Run: `npx vitest run tests/anim/mechanismBenchmark.test.ts && npm run bench:mechanisms 2>&1 | grep -E "phase|8880|5590|42000"`
Expected:
- the scorer tests PASS;
- no `unresolved` checks;
- 8880 phase 4 hits `shifts` ×2, neutral, 1st and 3rd, and misses 2nd and 4th with detail "drive ratios 2.25, 0.75";
- 5590 stays 17/17 and 42000 phase 3 stays 16/18.

- [ ] **Step 5: Commit** (refresh the results first with `BENCH_WRITE=1 npm run bench:mechanisms`)
```bash
git add src/anim/motion/v4/mechanismLab.ts src/anim/motion/benchmark/mechanismBenchmark.ts tests/anim/mechanismBenchmark.test.ts benchmarks/mechanisms/
git commit -m "feat(bench): 8880 Super Car benchmark with shift and gear-ratio checks"
```

### Task 4: Clutch phase offset, dog alignment and lock-up in the solver

**Files:**
- Modify: `src/anim/motion/v4/mechanismProgram.ts` (clutch fields + validation)
- Modify: `src/anim/motion/v4/transmissionNetwork.ts` (`transmissionEquation` clutch rhs)
- Modify: `src/anim/motion/v4/mechanismSolver.ts` (new `shift`)
- Test: `tests/anim/transmissionV5.test.ts` (extend; reuse its `p(...)` / `assembly()` fixtures)

**Interfaces:**
- Produces:
  - The clutch transmission becomes `{ kind: 'clutch'; a; b; engaged: boolean; reversed?: boolean; phase?: number; dogs?: number }`. `phase` is in radians, default 0, and the engaged equation becomes `q_b − s·q_a = phase`.
  - ```ts
    /** Engage or release clutches at the current pose. Each newly engaged clutch keeps the
     * present angle between its shafts as its phase, so nothing jumps. One whose dogs are
     * more than a quarter pitch (2π/dogs/4, "half a tooth") from alignment is not engaged
     * and is returned in `stalled`. Throws `Gear lock-up: <ids>` when the engaged set has no solution. */
    shift(engagements: Readonly<Record<string, boolean>>): { engaged: string[]; stalled: string[] };
    ```
  - After `shift`, `solve` and `solveInputs` use the solver's own engagement state; an `engagements` option still overrides it per call.
- Ruling to record: "half a tooth" = half a dog's width = a quarter of the dog pitch, taking a dog to fill half its pitch. The pitch comes from `ShiftElement.dogs` (4).

- [ ] **Step 1: Write the failing tests**

```ts
it('engaging mid-motion keeps the output where it is', () => {
  const s = new MechanismSolver(assembly(), p({ id: 'c', source, kind: 'clutch', a: 'a', b: 'b', engaged: false, dogs: 4 }));
  s.solveInputs({ a: 0.5 }); // b stays at 0; 0.5 rad is 0.5 − 0 ≈ 0.5 mod π/2 → misaligned by 0.5 > π/8
  expect(s.shift({ c: true })).toEqual({ engaged: [], stalled: ['c'] });
  s.solveInputs({ a: Math.PI / 2 + 0.1 });  // within π/8 of alignment
  expect(s.shift({ c: true })).toEqual({ engaged: ['c'], stalled: [] });
  const before = s.solveInputs({ a: Math.PI / 2 + 0.1 }).joints.get('b')!;
  expect(before).toBeCloseTo(0, 8);                         // no jump at engagement
  expect(s.solveInputs({ a: Math.PI / 2 + 0.6 }).joints.get('b')).toBeCloseTo(0.5, 6);   // then follows
});
it('two clutches that disagree are a lock-up, by name', () => {
  // a gear pair a→b at 3:1 plus clutch a=b engaged
  expect(() => s.shift({ c: true })).toThrow(/Gear lock-up: c/);
});
it('a clutch phase outside [-π, π] or a dog count below 1 is rejected by validation', () => { /* validateMechanismProgram errors */ });
```

- [ ] **Step 2: Run to verify they fail**
Run: `npx vitest run tests/anim/transmissionV5.test.ts`
Expected: FAIL, `s.shift is not a function`.

- [ ] **Step 3: Implement** the fields, the rhs, validation and `shift`. Lock-up detection: `projectLinearConstraints` over all engaged equations plus the current joint values of the driven inputs; a residual above 1e-6 means a lock-up.

- [ ] **Step 4: Run to verify they pass, and that nothing else moved**
Run: `npx vitest run tests/anim/transmissionV5.test.ts && npm run verify:v8:all`
Expected: PASS; `verify:v8:all` passes.

- [ ] **Step 5: Commit**
```bash
git add src/anim/motion/v4/mechanismProgram.ts src/anim/motion/v4/transmissionNetwork.ts src/anim/motion/v4/mechanismSolver.ts tests/anim/transmissionV5.test.ts
git commit -m "feat(solver): clutch phase offset, dog alignment and lock-up on shift"
```

### Task 5: One suggestion per gear

**Files:**
- Modify: `src/anim/motion/classify/suggest.ts` (gearbox plans; coaxial bearings lifted to the frame)
- Modify: `src/anim/motion/classify/patterns.ts` (`MechanismKind` gains `'gearbox'`)
- Modify: `src/anim/motion/v4/autoMechanics.ts` (`WHOLE_FUNCTIONS` gains `'gearbox'`)
- Modify: `src/anim/motion/v4/mechanismLab.ts` (pass `report.gearbox` into `suggestMechanisms`)
- Test: `tests/anim/classifySuggest.test.ts`

**Interfaces:**
- Consumes: `ShiftElement`, `GearMode`, `shiftModes` (Tasks 1–2); clutch `phase`/`dogs` (Task 4).
- Produces:
  - `suggestMechanisms(asm, graph, named, pairs, screws, gearbox?: { shifts: ShiftElement[]; network: RateNetwork })`.
  - Each plan whose bodies include a shift element's shaft becomes one suggestion per drive mode:
    - title `Gearbox — <mode label> (<ratio, 2 decimals>:1)`;
    - `mechanism.kind 'gearbox'`;
    - the program has one clutch transmission per coupling (`id` `clutch:<ring>:<gear>`, `dogs` from the element), engaged as the mode says;
    - the ring is a rigid follower of its shaft.
  - A clutch gear's revolute on a moving shaft that is coaxial (same line, `ON_LINE` 2.5 LDU) with that shaft's revolute on the frame is rebuilt as a revolute on the frame. Its coordinate is then absolute, so the mesh and clutch laws apply.

- [ ] **Step 1: Write the failing tests**

```ts
it('42000: the selector knob drives the wing in one gear and the engine covers in the other', async () => {
  const gear = report.detection.suggestions.filter(s => s.mechanism?.kind === 'gearbox');
  const wing = gear.find(s => moves(s, '92693c01', [0, 0, 650]));
  const covers = gear.find(s => moves(s, '92693c01', [100, -81, 241]) && moves(s, '92693c01', [-100, -81, 241]));
  expect(wing).toBeDefined(); expect(covers).toBeDefined(); expect(wing).not.toBe(covers);
  expect(moves(wing!, '92693c01', [100, -81, 241])).toBe(false);
});
it('8880: a suggestion per gear that reaches the wheels, labelled with its ratio', async () => {
  const titles = report8880.detection.suggestions.filter(s => s.mechanism?.kind === 'gearbox').map(s => s.title);
  expect(titles.some(t => /\(2\.25:1\)/.test(t))).toBe(true);
  expect(titles.some(t => /\(0\.75:1\)/.test(t))).toBe(true);
});
it('5590 offers no gearbox suggestion', async () => { /* none with kind 'gearbox' */ });
```
(`moves(s, part, at)` drives the suggestion to both ends, as the benchmark's `functionVerdict` does, and reports whether that part moved more than 0.5 LDU. Add it as a test helper beside the existing ones.)

- [ ] **Step 2: Run to verify they fail**
Run: `npx vitest run tests/anim/classifySuggest.test.ts`
Expected: the 3 new tests FAIL (no `gearbox` suggestions); the existing ones pass.

- [ ] **Step 3: Implement** gearbox plans in `plans()` and the coaxial lift in `build()`, then run `npm run bench:mechanisms`.
Expected: 42000 phase 4 is 2/2; 5590 17/17 and 42000 phase 3 16/18 are unchanged.

- [ ] **Step 4: Run to verify they pass**
Run: `npx vitest run tests/anim/classifySuggest.test.ts tests/anim/drivetrainSuggestions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (refresh the results with `BENCH_WRITE=1`)
```bash
git add src/anim/motion/classify src/anim/motion/v4/autoMechanics.ts src/anim/motion/v4/mechanismLab.ts tests/anim/classifySuggest.test.ts benchmarks/mechanisms/
git commit -m "feat(gearbox): one ready-to-drive suggestion per gear"
```

### Task 6: Shift track playback and the Lab's gearbox section

**Files:**
- Create: `src/anim/motion/gearbox/shiftPlayback.ts`
- Modify: `src/anim/motion/v4/mechanismProgram.ts` (`shiftTrack`)
- Modify: `src/ui/MechanismLabPanel.tsx` (gearbox section)
- Test: `tests/anim/gearbox/shiftPlayback.test.ts`, `tests/ui/MechanismLabGearbox.test.tsx`

**Interfaces:**
- Consumes: `MechanismSolver.shift` (Task 4); gearbox suggestions (Task 5); `solveLabFrame`.
- Produces:
  - `MechanismProgram.shiftTrack?: { at: number /* 0..1 of duration */; engagements: Record<string, boolean>; label: string }[]`.
  - Gearbox suggestions carry a default track:
    - start in the suggestion's own gear;
    - neutral at 0.45;
    - the next drive mode at 0.55, or the previous one if this is the last.
  - ```ts
    export type ShiftFrame = { poses: Map<string, THREE.Matrix4>; mode: string; stalled: string[] };
    export function playShiftTrack(solver: MechanismSolver, t: number /* 0..1 */): ShiftFrame;
    ```
  - The driver follows the program's usual sweep. At each frame the latest track entry with `at ≤ t` is requested through `solver.shift`; a stalled request is retried every frame. Ring parts slide to the engaged coupling's `engageAt` + 2 LDU, or to 0 in neutral (the selector animation).
  - Lab panel: under a gearbox suggestion, a table of modes (label, ratio or "neutral" / "locks"), with buttons that shift at the current playback pose, and a strip of the shift track's marks.

- [ ] **Step 1: Write the failing tests**

```ts
it('a shift during playback never jumps', () => {
  // synthetic two-speed box program with shiftTrack [{at:0, low}, {at:0.5, high}]
  let last = playShiftTrack(solver, 0), worst = 0, steady = 0;
  for (let i = 1; i <= 400; i++) {
    const f = playShiftTrack(solver, i / 400);
    const step = maxBodyTurn(last.poses, f.poses);
    if (i < 150) steady = Math.max(steady, step); else worst = Math.max(worst, step);
    last = f;
  }
  expect(worst).toBeLessThanOrEqual(3 * steady + 1e-6);   // the output changes speed, never position
});
it('a misaligned shift stalls, then engages once the dogs line up', () => { /* mode stays, stalled ['…'], later engages */ });
// tests/ui/MechanismLabGearbox.test.tsx
it('lists the ratio table under a gearbox suggestion', () => { /* render with a stub report; rows "neutral", "3.00:1", "0.33:1" */ });
```

- [ ] **Step 2: Run to verify they fail**
Run: `npx vitest run tests/anim/gearbox/shiftPlayback.test.ts tests/ui/MechanismLabGearbox.test.tsx`
Expected: FAIL, cannot resolve `shiftPlayback`, and no table rendered.

- [ ] **Step 3: Implement** `shiftPlayback.ts`, `shiftTrack` validation (`at` within 0..1, ascending), and the panel section. The panel plays a gearbox suggestion through `playShiftTrack` and any other suggestion through `solveLabFrame` as now.

- [ ] **Step 4: Run to verify they pass**
Run: `npx vitest run tests/anim/gearbox tests/ui/MechanismLabGearbox.test.tsx`
Expected: PASS.

- [ ] **Step 5: Check in the app**
Run the dev server through the preview tools. Load `samples/8880-1.mpd` in the Mechanism Lab, open the 2.25:1 suggestion, play it, and shift with the table buttons.
Expected: the ring slides, the output's speed changes with no jump, and the console is clean. Take a screenshot.

- [ ] **Step 6: Commit**
```bash
git add src/anim/motion/gearbox/shiftPlayback.ts src/anim/motion/v4/mechanismProgram.ts src/ui/MechanismLabPanel.tsx tests/anim/gearbox/shiftPlayback.test.ts tests/ui/MechanismLabGearbox.test.tsx
git commit -m "feat(lab): gear ratio table and shift track playback"
```

### Task 7: Spec, results and full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-10-30-mechanism-recognition-design.md` (§8 row 4 ✓ with numbers; a *Phase 4* note under §4)
- Modify: `benchmarks/mechanisms/README.md` (Results: the 8880 numbers, the axle defect, the chain input)

- [ ] **Step 1: Full verification**
Run: `npx vitest run > .superpowers/p4-suite.txt 2>&1; tail -5 .superpowers/p4-suite.txt; npx tsc --noEmit -p . && npx vite build && npm run verify:v8:all`
Expected: only `minifigInsertion` fails; tsc, the build and `verify:v8:all` are clean.

- [ ] **Step 2: Refresh the results and write the numbers into the spec row and the README**
Run: `BENCH_WRITE=1 npm run bench:mechanisms`
Expected:
- 8880 phase 4 5/7 (2nd and 4th missed: model-file axle);
- 42000 phase 4 2/2;
- 5590 17/17;
- 42000 phase 3 16/18.

- [ ] **Step 3: Commit**
```bash
git add docs/superpowers/specs benchmarks/mechanisms
git commit -m "docs: phase 4 gearbox modes results"
```
