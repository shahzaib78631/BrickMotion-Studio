# BrickMotion Studio — Native Electron UI

A complete desktop Electron interface for the BrickMotion native C++/Metal engine (`native/`), with **100% parity with the web Studio UI**.

## Architecture

- **`addon/`** — Zero-dependency C++20/Obj-C++ Node-API native addon (`bm_native.node`) linked directly against `libbmapp.a`, `libbmcore.a`, `libbmrender.a`, `libbmfilm.a`, `libbmsound.a`, and Apple's Metal / QuartzCore / AppKit frameworks.
- **`electron/`** — Electron Main Process (`main.ts`), ContextBridge Preload (`preload.ts`), Native Bridge & CLI runner (`nativeBridge.ts`), and shared IPC types (`types.ts`). Provides native macOS menu bar, native file dialogs (`.brickmotion`, `.mpd`, `.ldr`, `.io`, `.json`), and direct access to `bm`, `bmshot`, and `bmexport`.
- **`src/`** — React 18 + Vite renderer that hosts the entire BrickMotion web UI (all 16 panels, Toolbar, Inspector, Build Timeline, Keyframe/Motion Dope Sheet, Dialogs, and Themes) plus:
  - **Native Metal Viewport** (`NativeMetalViewport.tsx`) backed by `bmapp::Viewport` with live Metal rendering, orbit/pan/zoom, picking, view presets, Shaded/Clay/Wireframe styles, Shadows/AO/Edges/Floor toggles, and native build playback scrubbing.
  - **Seamless Metal / WebGL Switcher** in the viewport bar.
  - **Native Engine Panel** (`NativeEnginePanel.tsx`) for C++ construction planning, assembly joint & overlap inspection, motion collision auditing, Metal path-traced still rendering (`bmshot`), and native video/sound export (`bmexport`).

## Prerequisites

1. Build the native libraries once from the repository root:
   ```bash
   cmake -S native -B native/build-app -G Ninja -DBM_APP=ON
   cmake --build native/build-app --target bmapp bm bmshot bmexport
   ```
2. Install Electron dependencies in `native-electron-ui/`:
   ```bash
   cd native-electron-ui
   npm install
   ```

## Build & Run

```bash
cd native-electron-ui

# Build the C++/Metal Node-API addon (addon/build/bm_native.node)
npm run build:addon

# Development mode (Vite HMR + Electron window)
npm run dev

# Production build & launch
npm run build
npm run start
```
