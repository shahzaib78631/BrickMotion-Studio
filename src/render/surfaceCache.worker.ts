import { bakeSurfaceVisibility, type SurfaceBakeInput } from './surfaceCacheCore';

self.onmessage = (event: MessageEvent<SurfaceBakeInput>) => {
  try {
    const result = bakeSurfaceVisibility(event.data, (done, total) => self.postMessage({ type: 'progress', done, total }));
    self.postMessage({ type: 'complete', result }, { transfer: result.values.map((v) => v.buffer as ArrayBuffer) });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
