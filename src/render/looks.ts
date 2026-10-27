/** Scenes (backdrop, floor and lighting) and brick materials. Pure data, shared by
 * the viewport, the preview, MP4 export and still capture so they always agree. */

/** A scene preset: the studio around the model. */
export type StudioLook = 'soft' | 'classic' | 'white' | 'dark' | 'warm' | 'sky' | 'night' | 'chroma';
/** What the model stands on. 'auto' is the scene's own choice. */
export type FloorSurface = 'auto' | 'shadow' | 'reflective' | 'matte' | 'wood' | 'concrete' | 'none';
/** How the plastic itself responds to light. */
export type BrickFinish = 'studio' | 'glossy' | 'satin' | 'matte' | 'pearl' | 'clay';
/** A fine surface detail drawn on every part (procedural: it moves with the part). */
export type BrickTexture = 'none' | 'grain' | 'worn' | 'speckle' | 'glitter';

export type Materials = { finish: BrickFinish; texture: BrickTexture; floor: FloorSurface };
export const DEFAULT_MATERIALS: Materials = { finish: 'studio', texture: 'none', floor: 'auto' };

type RGB = readonly [number, number, number];
export type ScenePreset = {
  id: StudioLook;
  label: string;
  hint: string;
  /** Screen-space backdrop: bottom (0) to top (1) colour stops, sRGB bytes. */
  stops: readonly { at: number; rgb: RGB }[];
  /** An optional soft pool of light on the backdrop (0..1 screen coordinates, top-left origin). */
  spot?: { x: number; y: number; radius: number; rgb: RGB };
  /** The floor colour of matte, wood-tinted and reflective floors (sRGB hex). */
  floorColor: string;
  /** Floor used when the material's floor is 'auto'. */
  floor: Exclude<FloorSurface, 'auto'>;
  shadowColor: string;
  shadowOpacity: number;
  hemi: number;
  hemiGround: string;
  key: number;
  keyColor: string;
  fill: number;
  env: number;
  exposure: number;
  /** How strongly a reflective floor mirrors the model. */
  reflection: number;
};

export const SCENES: readonly ScenePreset[] = [
  { id: 'soft', label: 'Soft studio', hint: 'Neutral grey, soft contact shadows',
    stops: [{ at: 0, rgb: [172, 171, 180] }, { at: 0.3, rgb: [179, 178, 187] }, { at: 0.58, rgb: [184, 183, 192] }, { at: 0.83, rgb: [199, 198, 207] }, { at: 1, rgb: [207, 206, 214] }],
    floorColor: '#b8b7c0', floor: 'shadow', shadowColor: '#262630', shadowOpacity: 0.42,
    hemi: 0.85, hemiGround: '#c5c6ce', key: 2.35, keyColor: '#ffffff', fill: 0.38, env: 0.75, exposure: 1, reflection: 0.3 },
  { id: 'classic', label: 'Bright studio', hint: 'Plain light backdrop, lit floor',
    stops: [{ at: 0, rgb: [237, 237, 239] }, { at: 1, rgb: [237, 237, 239] }],
    floorColor: '#ededef', floor: 'matte', shadowColor: '#262630', shadowOpacity: 0.42,
    hemi: 1.1, hemiGround: '#c5c6ce', key: 2.2, keyColor: '#ffffff', fill: 0, env: 0.6, exposure: 1.05, reflection: 0.25 },
  { id: 'white', label: 'White seamless', hint: 'Product-shot white with a glossy floor',
    stops: [{ at: 0, rgb: [238, 238, 241] }, { at: 0.55, rgb: [246, 246, 248] }, { at: 1, rgb: [252, 252, 253] }],
    floorColor: '#f3f3f5', floor: 'reflective', shadowColor: '#30303a', shadowOpacity: 0.3,
    hemi: 1.05, hemiGround: '#dcdce2', key: 2.1, keyColor: '#ffffff', fill: 0.45, env: 0.85, exposure: 1.04, reflection: 0.22 },
  { id: 'dark', label: 'Dark spotlight', hint: 'Charcoal backdrop with a pool of light',
    stops: [{ at: 0, rgb: [60, 61, 66] }, { at: 0.5, rgb: [42, 43, 48] }, { at: 1, rgb: [30, 31, 35] }],
    spot: { x: 0.62, y: 0.3, radius: 0.75, rgb: [150, 151, 158] },
    floorColor: '#55565c', floor: 'reflective', shadowColor: '#08080a', shadowOpacity: 0.55,
    hemi: 0.45, hemiGround: '#3a3b40', key: 3.1, keyColor: '#fff6ec', fill: 0.25, env: 0.45, exposure: 1.05, reflection: 0.34 },
  { id: 'warm', label: 'Warm paper', hint: 'Soft beige, gentle warm light',
    stops: [{ at: 0, rgb: [226, 214, 196] }, { at: 0.6, rgb: [236, 227, 212] }, { at: 1, rgb: [245, 239, 228] }],
    floorColor: '#e4d8c6', floor: 'shadow', shadowColor: '#3b2e22', shadowOpacity: 0.38,
    hemi: 0.95, hemiGround: '#d7c8b0', key: 2.25, keyColor: '#fff1dc', fill: 0.3, env: 0.7, exposure: 1.02, reflection: 0.25 },
  { id: 'sky', label: 'Sky blue', hint: 'Fresh light-blue gradient',
    stops: [{ at: 0, rgb: [176, 203, 230] }, { at: 0.55, rgb: [203, 222, 241] }, { at: 1, rgb: [231, 240, 250] }],
    floorColor: '#c3d7ec', floor: 'shadow', shadowColor: '#1d2c40', shadowOpacity: 0.36,
    hemi: 0.95, hemiGround: '#b9cbe0', key: 2.2, keyColor: '#ffffff', fill: 0.4, env: 0.75, exposure: 1.02, reflection: 0.25 },
  { id: 'night', label: 'Midnight', hint: 'Deep navy with a cool spotlight',
    stops: [{ at: 0, rgb: [26, 32, 52] }, { at: 0.5, rgb: [17, 21, 36] }, { at: 1, rgb: [11, 13, 24] }],
    spot: { x: 0.5, y: 0.35, radius: 0.7, rgb: [70, 86, 128] },
    floorColor: '#28304a', floor: 'reflective', shadowColor: '#03040a', shadowOpacity: 0.6,
    hemi: 0.4, hemiGround: '#1f2538', key: 3.0, keyColor: '#e8eeff', fill: 0.35, env: 0.4, exposure: 1.08, reflection: 0.36 },
  { id: 'chroma', label: 'Green screen', hint: 'Flat chroma green for compositing, no floor',
    stops: [{ at: 0, rgb: [0, 177, 64] }, { at: 1, rgb: [0, 177, 64] }],
    floorColor: '#00b140', floor: 'none', shadowColor: '#000000', shadowOpacity: 0,
    hemi: 1.0, hemiGround: '#c5c6ce', key: 2.2, keyColor: '#ffffff', fill: 0.38, env: 0.75, exposure: 1, reflection: 0 },
];

export const sceneOf = (id: string | undefined): ScenePreset => SCENES.find((s) => s.id === id) ?? SCENES[0];
export const isStudioLook = (v: unknown): v is StudioLook => typeof v === 'string' && SCENES.some((s) => s.id === v);

export type FinishPreset = {
  id: BrickFinish; label: string; hint: string;
  roughness: number; clearcoat: number; clearcoatRoughness: number; metalness: number;
  /** Paint every opaque part this colour (a clay render). */
  tint?: string;
  iridescence?: number;
};
export const FINISHES: readonly FinishPreset[] = [
  { id: 'studio', label: 'Studio plastic', hint: 'Soft, broad highlights', roughness: 0.42, clearcoat: 0.16, clearcoatRoughness: 0.36, metalness: 0 },
  { id: 'glossy', label: 'Glossy ABS', hint: 'New, shiny bricks', roughness: 0.2, clearcoat: 0.65, clearcoatRoughness: 0.08, metalness: 0 },
  { id: 'satin', label: 'Satin', hint: 'Between glossy and matte', roughness: 0.55, clearcoat: 0.06, clearcoatRoughness: 0.5, metalness: 0 },
  { id: 'matte', label: 'Matte', hint: 'No shine, flat colour', roughness: 0.86, clearcoat: 0, clearcoatRoughness: 1, metalness: 0 },
  { id: 'pearl', label: 'Pearlescent', hint: 'A soft rainbow sheen', roughness: 0.32, clearcoat: 0.5, clearcoatRoughness: 0.15, metalness: 0.25, iridescence: 0.55 },
  { id: 'clay', label: 'Clay render', hint: 'Every part one neutral colour', roughness: 0.9, clearcoat: 0, clearcoatRoughness: 1, metalness: 0, tint: '#dad7d1' },
];
export const finishOf = (id: string | undefined): FinishPreset => FINISHES.find((f) => f.id === id) ?? FINISHES[0];

export const TEXTURES: readonly { id: BrickTexture; label: string; hint: string }[] = [
  { id: 'none', label: 'Smooth', hint: 'Clean, flawless surfaces' },
  { id: 'grain', label: 'Molded grain', hint: 'The fine texture of real injection-moulded parts' },
  { id: 'worn', label: 'Played-with', hint: 'Scuffs and dull patches' },
  { id: 'speckle', label: 'Speckled', hint: 'Granite-like dark speckles' },
  { id: 'glitter', label: 'Glitter', hint: 'Tiny sparkling flakes' },
];

export const FLOORS: readonly { id: FloorSurface; label: string; hint: string }[] = [
  { id: 'auto', label: 'Scene default', hint: 'Whatever the scene uses' },
  { id: 'shadow', label: 'Shadows only', hint: 'Seamless backdrop with contact shadows' },
  { id: 'reflective', label: 'Glossy reflective', hint: 'A soft mirror of the model' },
  { id: 'matte', label: 'Matte table', hint: 'A lit floor in the scene colour' },
  { id: 'wood', label: 'Wood', hint: 'Light oak planks' },
  { id: 'concrete', label: 'Concrete', hint: 'Smooth grey concrete' },
  { id: 'none', label: 'No floor', hint: 'No floor or shadows' },
];

const has = <T extends string>(list: readonly { id: T }[], v: unknown): v is T => typeof v === 'string' && list.some((x) => x.id === v);
/** Accepts anything from storage and returns valid materials. */
export function sanitizeMaterials(v: unknown): Materials {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof Materials, unknown>>;
  return {
    finish: has(FINISHES, o.finish) ? o.finish : DEFAULT_MATERIALS.finish,
    texture: has(TEXTURES, o.texture) ? o.texture : DEFAULT_MATERIALS.texture,
    floor: has(FLOORS, o.floor) ? o.floor : DEFAULT_MATERIALS.floor,
  };
}
export const floorFor = (look: StudioLook, floor: FloorSurface): Exclude<FloorSurface, 'auto'> =>
  floor === 'auto' ? sceneOf(look).floor : floor;

/** Backdrop pixels, RGBA, `width` × `height`, bottom row first (DataTexture order). */
export function scenePixels(scene: ScenePreset, width = 64, height = 128): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  const stops = scene.stops;
  for (let y = 0; y < height; y++) {
    const t = height === 1 ? 0 : y / (height - 1); // 0 bottom, 1 top
    let next = 1;
    while (next < stops.length - 1 && t > stops[next].at) next++;
    const a = stops[Math.max(0, next - 1)], b = stops[Math.min(stops.length - 1, next)];
    const f = b.at === a.at ? 0 : Math.max(0, Math.min(1, (t - a.at) / (b.at - a.at)));
    for (let x = 0; x < width; x++) {
      const rgb = [0, 1, 2].map((c) => a.rgb[c] + (b.rgb[c] - a.rgb[c]) * f);
      if (scene.spot) {
        const u = width === 1 ? 0.5 : x / (width - 1);
        const v = 1 - t; // top-left origin, like the spot
        const d = Math.hypot(u - scene.spot.x, (v - scene.spot.y) * 1.25) / scene.spot.radius;
        const k = Math.max(0, 1 - d);
        const w = k * k * (3 - 2 * k);
        for (let c = 0; c < 3; c++) rgb[c] += (scene.spot.rgb[c] - rgb[c]) * w;
      }
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(Math.max(0, Math.min(255, rgb[c])));
      px[o + 3] = 255;
    }
  }
  return px;
}
