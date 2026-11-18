/** Pinned ThreeRT browser exports (upstream renderer/web/src/lib.rs). */
export interface ThreeRTEngine {
  default(options: { module_or_path: string }): Promise<unknown>;
  geometry(id: number, positions: Float32Array, normals: Float32Array, uv: Float32Array, indices: Uint32Array, groups?: Uint32Array, colors?: Float32Array): void;
  material(id: number, json: string): void;
  object(id: number, json: string): void;
  transform(id: number, trs: Float32Array): void;
  instances(id: number, count: number, matrices: Float32Array): void;
  visible(id: number, visible: boolean): void;
  remove(id: number): void;
  camera(id: number, json: string): void;
  environment(json: string): void;
  settings(json: string): void;
  start(canvas: HTMLCanvasElement, width: number, height: number, info: string, scale: number, fps: number, guard: number): Promise<string>;
  frameBegin(dt: number): boolean;
  frameEnd(dt: number): string;
  markSubmitted(): void;
  frameIdle(): boolean;
  stopView(): void;
  resetEngine(): void;
}

let loaded: Promise<ThreeRTEngine> | undefined;
let queue: Promise<void> = Promise.resolve();

/** Upstream has one world/view per WASM module: serialize ownership, including initialization. */
export async function acquireThreeRT(): Promise<{ engine: ThreeRTEngine; release(): void }> {
  const previous = queue;
  let unlock!: () => void;
  queue = new Promise<void>(resolve => { unlock = resolve; });
  await previous;
  try {
    if (!loaded) loaded = (async () => {
      const base = `${import.meta.env.BASE_URL}threert/`;
      const module: ThreeRTEngine = await import(/* @vite-ignore */ `${base}threert_web.js`);
      await module.default({ module_or_path: `${base}threert_web_bg.wasm` });
      return module;
    })().catch(error => { loaded = undefined; throw error; });
    const engine = await loaded;
    let released = false;
    return { engine, release() {
      if (released) return;
      released = true;
      try { engine.resetEngine(); } finally { unlock(); }
    } };
  } catch (error) { unlock(); throw error; }
}
