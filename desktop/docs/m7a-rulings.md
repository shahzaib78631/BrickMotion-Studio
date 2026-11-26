# M7a rulings (Assembly Tools)

## Approved mockup (Task 1, 2026-11-26)

Mockup: `desktop/docs/m7a-tools-mockup.html`. Adopted the three recommended plan defaults (all three ribbon placements and labels live cleanly in `commands.rs` and can be adjusted in one edit if needed):

- **Model Checks and Seat Loose sit on the `Inspect` ribbon tab** (group `Checks`: `Model Checks`, `Seat Loose`).
- **What Fits sits on the `Suggest` ribbon tab** (group `Compatible`: `What Fits`), ready for M7b's ghosts and techniques to join it.
- **Ribbon labels stay short** (`"Model Checks"`, `"Seat Loose"`, `"What Fits"`, `"Inventory"`), while the floating panels use the Swift headers (`"Model Checks"`, `"Seat Loose Pieces"`, `"Compatible Parts"`).
- **Floating panels** (`PanelKind::Checks`, `PanelKind::Loose`, `PanelKind::Fits`) open below the axis navigator (`navigator::CLEARANCE`) using `float_panel::show` and `chrome/widgets.rs` inset groups.
- **File menu:** `Import Parts Inventory…` (`file.import_inventory`) sits in File's first group right after `Open Recent` (matching Swift's File menu group 0), and `model.inventory` on Model › Insert runs the same action.

## Milestone checks (Task 8, 2026-11-26)

| Check | Result |
|---|---|
| `cargo clippy --workspace --all-targets -- -D warnings` | Clean (0 warnings) |
| `cargo test --workspace` | 357 passed, 0 failed (11 ignored) |
| `M7A_SHOTS=... cargo test -p brickmotion --test inspect m7a_screenshots -- --ignored` | Passed (`desktop/docs/m7a-checks.png`, `m7a-loose.png`, `m7a-fits.png`) |
| `native/build-rust/app/bmapp/bmapp_tests` | 48,417 assertions in 191 test cases passed |
| `native/build-rust/bmffi/bmffi_tests` | 1,778 assertions in 91 test cases passed |
| `nm -gU native/build-rust/bmffi/libbmffi.dylib` (non-`_bm_*` symbols) | 0 |
| `ctest --test-dir native/build -j8` | 475 / 475 passed |
| `ctest --test-dir native/build-app -j8` | 676 / 676 passed |
| `desktop/scripts/bundle.sh` | Built `desktop/target/BrickMotion.app` with `Contents/Resources/Suggest/habits.json` (1.3 MB) |

### Screenshots reviewed
- `desktop/docs/m7a-checks.png`: Model Checks panel on `Inspect` tab showing Last Refused Edit card, Overlaps, Unsupported Parts, and working Frame buttons.
- `desktop/docs/m7a-loose.png`: Seat Loose Pieces panel showing offset detail (`3.0 LDU off · on Blue Brick 2 x 4`), checkbox, Frame button, and pinned `Seat Piece` footer.
- `desktop/docs/m7a-fits.png`: Compatible Parts panel on `Suggest` tab showing rendered thumbnails, `What Builders Put Here` habit lines (`In 360 of 67,185 BrickNet models`, …), search box, and pinned `Add Part` footer.
