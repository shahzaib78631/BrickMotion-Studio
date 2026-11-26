# M7a rulings (Assembly Tools)

## Approved mockup (Task 1, 2026-11-26)

Mockup: `desktop/docs/m7a-tools-mockup.html`. Adopted the three recommended plan defaults (all three ribbon placements and labels live cleanly in `commands.rs` and can be adjusted in one edit if needed):

- **Model Checks and Seat Loose sit on the `Inspect` ribbon tab** (group `Checks`: `Model Checks`, `Seat Loose`).
- **What Fits sits on the `Suggest` ribbon tab** (group `Compatible`: `What Fits`), ready for M7b's ghosts and techniques to join it.
- **Ribbon labels stay short** (`"Model Checks"`, `"Seat Loose"`, `"What Fits"`, `"Inventory"`), while the floating panels use the Swift headers (`"Model Checks"`, `"Seat Loose Pieces"`, `"Compatible Parts"`).
- **Floating panels** (`PanelKind::Checks`, `PanelKind::Loose`, `PanelKind::Fits`) open below the axis navigator (`navigator::CLEARANCE`) using `float_panel::show` and `chrome/widgets.rs` inset groups.
- **File menu:** `Import Parts Inventory…` (`file.import_inventory`) sits in File's first group right after `Open Recent` (matching Swift's File menu group 0), and `model.inventory` on Model › Insert runs the same action.
