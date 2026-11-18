# ThreeRT integration and Rust migration

The viewport selector offers **ThreeRT (experimental)**. It runs the real
[meshy-dev/ThreeRT](https://github.com/meshy-dev/ThreeRT) Rust/wgpu browser engine,
pinned to `10fdc7738835d5b4c19438141fe28009a1d66d6b`. It is not a shader approximation
or a renamed instance of our existing path tracer. The engine's MIT license ships
beside its assets in `public/threert`.

## Scope

This is an optional perspective studio viewport, with ThreeRT's preview preset,
temporal denoiser, adaptive resolution targeting 30 fps, and UE filmic post chain.
Model instances retain full affine world matrices: reflected/sheared LDraw poses
are not decomposed into TRS. Zero-scale hidden instances remain hidden. Animation
changes update the instance tables; they do not reupload geometry. Geometry is
shared by source buffer geometry, and materials by source material.

The original canvas continues handling editing and drawing selection/gizmo
overlays. Wire, orthographic, and cropped views use the current renderer. Errors
show a status message and restore the current renderer. Renderer preferences
persist independently of video export preferences. The existing export engines
remain the export choices; this integration does not introduce ThreeRT video or
final-still export.

ThreeRT uses a different lighting/material model. This first adapter uses a fixed
neutral four-light studio rig and a plain floor, not the custom scene lamps,
HDR environment, floor textures, procedural material hooks or logos of the live
renderer. Basic physical material fields cross the bridge; texture maps do not.
In particular, upstream's material descriptor has transmission and IOR but no
volume attenuation distance/thickness. Colored glass maps to upstream's surface
tint approximation. It is **not** a replacement for our calibrated volumetric
glass transport or a claim of material parity. The viewport status labels glass
experimental.

## Ownership and rebuilds

Upstream exposes a singleton WASM world/view and no teardown. `host.rs` adds only
explicit view/world teardown and GPU submission completion tracking. No upstream
rendering algorithm or shader is changed. The adapter admits one GPU submission
at a time and picks up the newest camera/animation pose when it completes, avoiding
an increasingly stale queue on slower GPUs. Ownership is serialized across async
initialization and renderer switches; disposing during initialization waits before
releasing the module.

The WASM module itself is cached for reuse. Dropping a scene frees its GPU
resources and Rust allocations, but the browser's WASM linear memory keeps its
high-water capacity. This optional backend adds an engine to the web application;
it is not a reduction in its download or memory footprint.

Size, structure, material and floor changes reopen the view, releasing its previous
device/world resources. Resize changes are debounced for 150 ms; the raster
viewport displays while rebuilding. This can pause the ThreeRT preview briefly.
Incremental resizing would require a larger upstream host change.

## Build

The checked-in WASM asset needs no Rust toolchain on the user's machine and loads
only when this renderer is selected (about 18 MiB uncompressed). To rebuild:

```sh
rustup toolchain install 1.100.0 --profile minimal --target wasm32-unknown-unknown
cargo +1.100.0 install wasm-bindgen-cli --version 0.2.130 --locked
npm run build:threert
```

`WASM_BINDGEN` can point to a preinstalled 0.2.130 executable. The build script
obtains the pinned upstream source under `.cache/ThreeRT`, appends the tracked
host additions, builds the locked browser crate, and generates its JS bindings,
license and manifest. The manifest records source revision, compiler/bindgen
versions, host source hash and asset hashes. Normal app builds use these assets.

## Validation on Apple M1 Pro

`threert-verify.html` exercises the actual WebGPU/WASM engine: rendering, reflected
and hidden instances, camera and pose updates, resize, teardown and reopen.
Additional browser checks exercised the viewport controller's wire/orthographic
fallback, status cleanup and switching back to raster.

Both supplied models rendered and accepted live pose updates: Diner (2,599 parts)
and House (828 parts). At 640×400, Diner initialized in approximately 3.46 s;
its short smoke run reported approximately 42 ms GPU at 85% resolution. House
initialized in 2.14 s and reported 18–56 ms GPU at 75% resolution. These are
short-run telemetry snapshots before the host queue limit was added, not stable
performance comparisons or a guarantee of frame rate. GPU screenshots and logs
are local under `.cache/threert/`.

The final Diner check, with queue backpressure enabled, waited for 35 actual GPU
submissions and then 10 further submissions after a pose change. Initialization
was 3.78 s; reported GPU times were 33.8 ms before and 41.2 ms after the pose
change at 77% resolution. The 45-frame check completed without shader errors.

## Rust direction

The current collision kernel already runs Rust compiled to WASM inside the planner
worker. The Diner smooth-planner JS/WASM comparison was approximately 864 s versus
289 s with identical encoded timelines; see `planner-research.md`. Moving the UI
to Rust would not remove GPU shading, shadow, transparency or geometry costs.

Recommended progression: retain the React editor; move measured CPU bottlenecks
into reusable Rust crates; optionally add a Tauri desktop host for native threads,
files and memory ownership; evaluate native ThreeRT/Metal rendering separately.
[Tauri's architecture](https://v2.tauri.app/concept/process-model/) explicitly
supports a Rust core and webview UI. Wrapping the current UI alone does not change
its rendering costs. Native scene data should stay in Rust, with batched edits,
rather than serializing the whole model across IPC for every animation frame.

The browser engine uses software BVH traversal on WebGPU. Native ThreeRT can use
hardware ray queries on supported GPUs; Apple M1 Pro has no hardware RT units
(Apple introduced hardware ray tracing with M3). A native rewrite cannot create
that hardware capability. This integration therefore establishes an optional
renderer and a Rust boundary, not evidence that rewriting the entire application
would be faster or smaller.
