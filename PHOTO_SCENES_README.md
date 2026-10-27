# BrickMotion — reference-inspired photo scenes

## What's included

Open **Materials → Scene → Photo tabletop scenes** to choose six photographic
looks. Each look controls the seamless background, floor-shadow tint and
opacity, environment, exposure, directional key, fill and rim lighting:

| Look | Intended use |
| --- | --- |
| Reference grey | Reference screenshot's medium-grey product-photography style |
| Slate blue | Blue-background image tiles with a cool rim |
| Porcelain | Light, high-key tabletop with restrained shadows |
| Sage paper | Olive/sage-colored paper set |
| Warm catalog | Beige studio and warm key light |
| Graphite | Dark matte set with bright edge lighting |

The looks are selectable in **Video → Look & sound → Studio** too. The same
`createStudio` rendering path is used by the editor, Preview, still capture,
and MP4 export. Existing looks and the default **Soft studio** remain available.
All photo looks use the `Shadows only` floor by default, so there is no
hard horizon line. If you previously set a non-auto floor in Materials, choose
**Floor → Scene default** to see the photographic floor and shadows.

For editable lights, open **Scene → Photo scene + editable lighting** in the 3D
viewport and choose **Grey softbox**, **Blue editorial**, **Warm catalog**, or
**Dark rim light**. This replaces the project's current custom scene lights
(after confirmation), sets the matching photo backdrop, and creates four
editable objects: shadow-casting key, fill, rim, and ambient. It keeps the
active scene camera, region crop, and staging positions intact. To return to
lightweight automatic lighting, toggle off *Use scene lights in Preview & MP4*
in Scene; choose any look from Materials to customize the built-in studio rig.

For the closest composition to the supplied example: use **Staging → Camera
frame** (or **Showcase**), **All parts at once**, **All around**, a **9:16**
output format, and an overhead/three-quarter camera angle. The camera-frame
mode changes the shape of staged rows by output aspect ratio; it **does not**
measure the projected position of every part against the camera frustum, and
thus cannot yet guarantee all waiting pieces are in shot.

## Implementation notes / limits

- Lighting is real Three.js directional/ambient lighting with one shadow map,
  not baked textures or a path-traced softbox. Softness depends on shadow-map
  filtering and may differ from a photographed studio.
- Built-in looks apply key/fill/rim and camera-relative shadow positioning at
  the subject's fitted bounds. Editable photo rigs derive scale and target
  from the editor's current orbit view.
- Custom project lights intentionally replace built-in lighting when
  **Keep default studio lights** is off. A color/background preset will not
  silently delete or overwrite a user's authored lights.
- Scene/light style changes do not change the underlying assembly planner or
  piece placements. They are safe to preview without rebuilding the timeline.

Run `npm test -- tests/render/photoScenes.test.ts tests/anim/cameraFrameStaging.test.ts`
for targeted tests when dependencies are available, and `npm run build` for
TypeScript + Vite. Browser QA (real WebGL shadows/MP4 encoding) remains necessary.
