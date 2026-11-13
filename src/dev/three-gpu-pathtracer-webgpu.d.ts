/**
 * Minimal ambient types for `three-gpu-pathtracer/webgpu`, which ships no declarations
 * (only the WebGL entry has `index.d.ts`). Covers the surface the PathCache tracer uses.
 */
declare module 'three-gpu-pathtracer/webgpu' {
  export const RANDOM_PCG: object;
  export const RANDOM_SOBOL: object;
  export const RANDOM_BLUE_DITHER: object;

  export const TRANSMISSIVE_BACKGROUND_ENVIRONMENT: number;
  export const TRANSMISSIVE_BACKGROUND_OVERLAY: number;
  export const TRANSMISSIVE_BACKGROUND_TRANSPARENT: number;

  export type SampleCounts = { min: number; max: number; avg: number; samplesPerSecond: number };

  /** Open Image Denoise over a path-traced image; runs once the render settles. */
  export class OIDNDenoiser {
    constructor(options: {
      initUNetFromURL: Function;
      auxWeightsUrl: string;
      colorWeightsUrl?: string;
      useAuxiliaryBuffers?: boolean;
      maxTileSize?: number | null;
    });
    readonly texture: unknown;
    readonly complete: boolean;
    readonly running: boolean;
    dispose(): void;
  }

  /** FSR upscaler: render below the canvas size, upscale to it. */
  export class FSRUpscaler {
    constructor(options: { Upscaler: unknown; sharpness?: number });
    init(renderer: unknown): void;
    upscale(source: unknown, camera: unknown): unknown;
  }

  /** Progressive path tracer running on WebGPU. `setScene` once, then `renderSample` every frame. */
  export class WebGPUPathTracer {
    constructor(renderer: unknown);

    maxBounces: number;
    frameBudget: number;
    maxTransparentBounces: number;
    maxSamples: number;
    minSamples: number;
    renderDelay: number;
    fadeDuration: number;
    dynamicLowRes: boolean;
    lowResScale: number;
    renderScale: number;
    synchronizeRenderSize: boolean;
    stableNoise: boolean;
    pause: boolean;
    filterGlossyFactor: number;
    multipleImportanceSampling: boolean;
    clampDirect: number;
    clampIndirect: number;

    readonly lowResMode: boolean;
    readonly fadeState: number;
    readonly target: unknown;

    getMaterial(): { diffuseBrdf: unknown; [key: string]: unknown };
    setMaterial(material: unknown): void;
    renderSample(): void;
    setScene(scene: unknown, camera: unknown): void;
    setRandom(random: object): void;
    setDenoiser(denoiser: OIDNDenoiser | null): void;
    setUpscaler(upscaler: FSRUpscaler | null): void;
    setCamera(camera: unknown): void;
    updateCamera(): void;
    updateTransforms(): void;
    updateEnvironment(): void;
    updateLights(): void;
    updateMaterials(): void;
    setSize(x: number, y: number): void;
    reset(): void;
    getSampleCountsAsync(): Promise<SampleCounts>;
    getRenderTime(): number;
    dispose(): void;
  }
}

declare module 'three-gpu-pathtracer/src/webgpu/nodes/structs.wgsl.js' {
  export const surfaceRecordStruct: any;
  export const materialStruct: any;
}
