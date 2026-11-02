# Precision Attachments — Nonstandard LEGO Connections

## Status and scope

This implementation adds a **source-auditable exact-pose attachment subsystem** to BrickMotion Studio. It augments the existing LDCad shadow/`SNAP_*` connector engine; it neither replaces nor fabricates LDCad connector records. The first reviewed pair is:

- **Host:** LDraw `19141.dat`, *Minifig Scabbard for Two Swords with Bar*.
- **Insert:** LDraw `30173.dat` (an identity-frame LDraw redirect to `30173a.dat`, the octagonal-guard katana). `30173b` and `21459` are deliberately **not** aliased.
- **Source:** the `0 !HELP Positioning of Swords` section of official `19141.dat`, providing **two LDraw type-1 placement examples**.
- **Placement type:** named friction-slot **reference placement**, not an LDCad cylindrical snap and not a physically simulated friction constraint.

This implementation improves coverage and auditability for these documented exceptional placements. It has **not** been benchmarked against a current BrickLink Studio installation, and no claim of comprehensive LEGO compatibility or superiority is implied.

## Source research

1. Official LDraw 19141 part source: <https://library.ldraw.org/parts/1388>. The two sword transforms are prefixed `0 !HELP`, not standalone type-1 model references and not snap connectors. Official file attributed to Gerald Lasser; released as UPDATE 2018-02 under CC BY 4.0.
2. LDraw official header specification: <https://www.ldraw.org/article/398.html>. `!HELP` is **optional free text**. Therefore it is not safe to interpret arbitrary such lines as machine-authoritative connections.
3. Official 30173 redirect: <https://library.ldraw.org/parts/4103>. Its type-1 reference to `30173a.dat` has an **identity transform**, supporting the narrowly scoped alias.
4. Roland Melkert's LDCad shadow-library architecture: <https://www.melkert.net/LDCad/tech/shadowLib>. Shadow metadata augments LDraw parts with snapping records in a distinct library.
5. BrickLink Studio Connect tool: <https://studiohelp.bricklink.com/hc/en-us/articles/6481651047319-Connect>. Studio exposes available connection points to the user. BrickLink PartDesigner supports editing a part's connectivity information: <https://studiohelp.bricklink.com/hc/en-us/articles/5872512112663-What-is-PartDesigner>.

These sources document **formats and user-visible behavior**, not equivalence of physical attachment constraints. No proprietary `.conn`/`.col` content is imported or copied.

## Significant detail: reflected second sword

The two examples in official `19141.dat` are:

```ldraw
0 !HELP 1 1 -.174 -9 35.1 0 -.01745 -.99985 -1 0 0 0 .99985 -.01745 30173.dat
0 !HELP 1 1 -35.1 -5 .174 0 -.99985 .01745 -1 0 0 0 .01745 .99985 30173.dat
```

The determinant of the first 3x3 transform is approximately **+1**. The determinant of the second is approximately **−1**: **it is a reflection, not an ordinary rigid-body rotation**. Treating both as physically rotatable joints would be inaccurate. The implementation:

- Parses, preserves, and matches both documented LDraw **display** poses.
- Offers the first pose by default for dragging the sword.
- Exposes the second only when the user checks **Parts → Attachment precision → Allow mirrored LDraw reference poses**.
- Shows an explicit mirror warning in the viewport while previewing the pose.
- Records a recognized reflected placement in the construction connection graph as **static-only reference evidence**, with **no physical support dependency** or swept-collision waiver.
- Never uses a reflected pose as evidence for a grounded/physically supported item in model validation.

A mirrored rendered sword may differ in handedness from a realizable injection-moulded sword. A future mechanically validated orientation for the second slot must be separately documented/bench-tested; **do not silently replace reflection with a guessed rotation**.

## Architecture and data flow

| Module | Responsibility |
|---|---|
| `src/ldraw/attachmentHints.ts` | Parse narrowly recognized type-1 lines embedded in `!HELP`. Validate orthogonal 3x3 matrices, source line, part filename, handedness; reject malformed/unsafe metadata. |
| `src/ldraw/parse.ts` | Preserve source hints separately from LDraw geometry and ordinary reference records. |
| `src/ldraw/library.ts` → `flatten.ts` → `metrics.ts` | Propagate host-level documentation into the part metrics without modifying the shadow snap data. |
| `src/ldraw/attachments.ts` | **Reviewed** compatibility registry, exact source poses, correct 30173 alias, profile registration, optional **unreviewed** hint suggestions. |
| `src/model/attachmentPlacements.ts` | Independent pure-math relative-pose matching, global one-to-one slot occupancy, canonical-part index, placement-target generation. |
| `src/plan/placementEngine.ts` | Include documented precision poses in existing cursor scoring, occlusion, hysteresis, floor and collision guards; `handle: -2`. |
| `src/state/placing.ts` | Gather targets for a single moving part, including occupied but hidden stationary slots; show only targets on visible hosts. |
| `src/model/validate.ts` | Count uniquely matched **nonmirrored reviewed** placements as support connections in floating diagnostics; never silence overlap/collision warnings. |
| `src/anim/construction/connections.ts` | Annotated `kind: 'placement'` graph edges and provenance; only nonmirrored reviewed placements create dependencies. |
| `src/state/appSettings.ts`, `src/storage/settings.ts`, `src/ui/PartsPanel.tsx` | Persist two opt-in controls; both off by default. |
| `src/ui/ViewportChrome.tsx` | Show slot ID, review status, reflection state and disabled collision state in the placement HUD. |

Every placement uses a **column-major 4x4** LDraw-space matrix. The host-space target is computed as:

```text
insertWorld = hostWorld × placementFromOfficialHelp
```

An existing part is recognized as seated only if:

1. Both part IDs map to an explicitly compatible pair (limited alias table).
2. Both world bases are orthogonal (reflected bases permitted for display alignment, scaling/shear not permitted).
3. Translation error is ≤ **0.45 LDU** and angle error ≤ **1.5°**; these tolerances cover authored float rounding, not mesh overlap.
4. Actual vs expected handedness matches; negative-determinant poses are never re-labelled proper rotations.
5. No more than one insert claims any host slot, and no insert claims more than one slot. Ambiguous claims receive **no** certified match.

These matching tolerances are **not** physical friction coefficients, contact constraints, collision clearances, or legal insertion paths.

## Using the feature

1. Install project dependencies and official LDraw data via the existing project setup instructions (`npm ci`, `npm run setup`, as applicable). The archive contains the source project; the full runtime LDraw part library is populated by its setup process, not by this feature.
2. Import/add `19141` and `30173` or `30173a` into a model. Leave **Collision ON**.
3. Drag a single sword toward the scabbard. Aim close to the desired slot. A valid precision pose shows **Reference alignment · 19141:sword:1** and seats the sword using the official position/rotation, even when no LDCad sword-slot snap exists.
4. For the reflected **second** official reference pose, explicitly check **Allow mirrored LDraw reference poses**. It is a model-display aid, **not** a physical-joint certificate.
5. To explore other parts' literal `!HELP` examples, check **Preview unreviewed part placement hints**. They remain **opt-in previews**, cannot create assembly dependencies or suppress floating checks, and do not validate physical compatibility.
6. Occupied slots cannot be targeted again, including occupancy by an item not visible at the current timeline step. An ambiguous duplicate insertion is not certified as a valid connection.

For a fully physical animation, validate the exact real-world geometry, compatible mould, and withdrawal/insertion route. Neither a `!HELP` pose nor a placement can make an impossible sweep safe.

## Adding reviewed attachment profiles

Application owners may register additional **human-reviewed, source-documented** pairs at initialization via `setReviewedAttachmentProfiles()` from `src/ldraw/attachments.ts`. Profiles have the schema `AttachmentSlot`:

```ts
import { setReviewedAttachmentProfiles, type AttachmentSlot } from './ldraw/attachments';

const profiles: AttachmentSlot[] = [{
  id: 'your-host:attachment:1',
  host: 'your-host-id',
  insert: 'compatible-part-id',
  pos: [0, 0, 0],
  m: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  mirrored: false,
  type: 'reference-placement',
  evidence: 'reviewed-profile',
  source: 'https://example.org/real-auditable-source',
  reviewer: 'Your actual reviewer',
  reviewedAt: '2026-11-02',
  line: 0,
  context: 'Reviewed geometry and placement reference',
}];
setReviewedAttachmentProfiles(profiles);
```

This is **example API shape only**. It must not be used to mark a physically unsupported fit as reviewed. Validation rejects duplicate slot keys, malformed/scale/shear bases, mismatched reflected flags, unreviewed-profile tags, missing reviewer/date metadata, and sources lacking HTTPS. Each review should record a test model, exact part revision, source URL and reviewer in the project's review process. To remove all registered external profiles, call `setReviewedAttachmentProfiles([])`.

For future wider coverage, introduce a **versioned review catalog** of independent pairs, build a data-import/verification pipeline, and maintain three trust bands (reviewed physical fits, reviewed display references, unreviewed hints) with actual geometry/contact evidence. This code supplies the extension points but does **not** claim those unknown parts already work.

## Test and verification status

```sh
npm run verify:attachments:offline  # runs without downloading npm dependencies
npm run test:attachments            # Vitest/three.js required
npm run typecheck                   # full app dependencies required
npm run build                       # full app + data/runtime requirements
```

`verify:attachments:offline` uses the local (or globally available) TypeScript compiler API to **typecheck the pure-core modules**, syntax-parse the modified application integration files, and run **14 native-Node assertions** for the real official 19141 transforms, reflections, aliases, rotated hosts, tolerances, occupancy, duplicates and review rules. The Vitest suites add placement-engine collision-gate and occlusion checks, but cannot execute until project dependencies are installed.

**Known limitations:** initial curated coverage is only 19141/30173[a]; the system does not infer arbitrary friction contacts from meshes; successful authored placement does not prove insertion motion; collision checks are subject to existing mesh fidelity and the user's collision toggle; the second source pose is a reflection; exact geometry/display may depend on an external LDraw part library; performance and actual behavior in BrickLink Studio have not been independently benchmarked. These are deliberate, documented boundaries, not fabricated claims of feature completeness.
