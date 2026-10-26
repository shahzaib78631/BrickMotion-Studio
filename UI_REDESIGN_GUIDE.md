# BrickMotion reference UI redesign

This project contains the original BrickMotion CAD/build-animation app with a new, reference-inspired editor interface. The reference image was used as a design target, not as a baked-in background. The underlying Three.js viewport, plan editing, project import/export, animation planning, and timeline remain part of the working application.

## Getting started

From this directory:

```bash
npm install
npm run setup
npm run dev
```

Open the localhost URL printed by Vite. `npm run setup` installs the full LDraw part library and builds the searchable part catalog. A *minimal color palette* is included so the editor can initialize without the full library, but actual brick meshes and part search **require** setup. A helicopter sample is included under `samples/helicopter/helicopter.mpd` and can be opened from **Projects → Import model or project**. Existing projects restore from the application's local browser storage.

For a production build: `npm run build`. For the project's tests: `npm test`.

## Design implementation

- **Header:** compact hexagon identity, Pro accent, Projects menu, editable project title, autosave indicator, command launcher (`Ctrl/⌘ K`), undo/redo, preview and export menus. The collaboration avatars and Share controls shown in the reference were deliberately omitted.
- **Navigation rail:** Models, Parts, Assembly, Animation, Render, Assets, Settings, with lavender active states. Model Checks remain available from command search and the viewport warning action.
- **Models browser:** filterable, expandable project/model hierarchy; model statistics, context menus, quick exports, New Model, New Submodule and From Selection actions. Core/Motion chips provide quick visual distinctions.
- **Canvas:** floating Top / 3D / Split display mode, selection and transform tools, configurable fine grid, fit view, orientation gizmo, fullscreen viewport, zoom controls, contextual selection action bar. Split shows an overview panel instead of duplicating the 3D renderer.
- **Inspector:** Selection, Part, and Submodule tabs, with context-sensitive selections, grouping/marks, extraction, moving across models, duplicate/delete, relative movement, rotation handles, color editing and part metadata. Controls invoke the project's existing edit functions.
- **Animation:** compact Build / Timeline / Motion selector, retained transport controls, draggable timeline resizing, reference-like teal build and lavender submodel clips.
- **Visual styling:** high-contrast light surfaces, 1px separators, soft inset shadows, violet gradients, accessible focus states, responsive breakpoints, optional dark theme, reduced-motion support.

The main design layer lives in `src/ui/reference.css`. New overlay controls live in `src/ui/ViewportChrome.tsx`. The top bar, model browser, inspector, and app shell are updated in their original components. `design-preview.html` is an optional **static mock-data fixture** for inspecting the reference styling with an example composition; it is not a replacement for the React app or a functional editor.

## Known environment limitation

The UI sources and CSS were checked for structural/syntax validity in the delivery environment, but the full Vite build and interactive browser QA could not be executed there because npm dependencies were not locally available and the package registry could not be reached. Run `npm install && npm run build` in your regular development environment to perform full TypeScript and bundle validation. No changes to the existing dependency list are required by the redesign.
