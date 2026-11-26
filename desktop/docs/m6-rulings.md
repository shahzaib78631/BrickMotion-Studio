# M6 rulings (Render & Export)

## Approved mockup (Task 1, 2026-11-26)

Mockup: `desktop/docs/m6-render-mockup.html` (copy of `.superpowers/brainstorm/65433-1795584607/content/m6-render.html`). The owner answered the four gate questions with the recommendations and raised nothing on the screens, so v1 is the approved design.

- **Export Video and Export Still are floating panels** (`PanelKind::Movie`, `PanelKind::Still`), like the M5 editors. The Export Video panel changes state in place: settings → Waiting to Render → Frame n of N with Cancel → Export Complete with Show in Finder / Done, or the failure.
- **The Render Queue is a floating panel** (`PanelKind::Queue`), opened from Output → Render Queue and Window → Render Queue. Header subtitle counts "n rendering · n waiting · n finished". Queueing a still closes Export Still and opens the queue.
- **Look opens from the ribbon's Look button and View → Look… only** (no viewbar popover). Header "Look · Project"; the first line of the body is "Saved with the project and used by every video.". Scenes are 30-px swatches (selected: 2-px accent outline), the hovered or chosen scene's name and hint under them; shading is a list of six rows (title + description, chosen row accent-tinted); Detail is one inset group of switch rows; Path tracing Samples is a pill slider shown only with Path Traced.
- **The recording chip sits bottom left**, in the selection chip's place: red dot, "m:ss" in mono, Stop.
- Ribbon: Animate → Output tab holds the Output group (Export Movie, Export Still, Render Queue) and a View group (Look, Record).
- File menu: Export Movie…, Export Still…, Export All Submodel Videos…, Export LDraw… ⇧⌘E, Export Plan…. Model row menu: Export Video…, Export Project…, Export LDraw….
- Frame shapes are four tiles (outline of the shape, name, ratio); the chosen tile is accent-outlined and tinted.
