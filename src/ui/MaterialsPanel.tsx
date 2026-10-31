import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { useAppSettings } from '../state/appSettings';
import { geometryOf, getColors } from '../state/partService';
import type { ModelState } from '../state/useModel';
import { AO_RADIUS_RANGE, AO_STRENGTH_RANGE, ENVIRONMENTS, FINISHES, FLOORS, GLASS_LOOKS, GLOW_STRENGTH_RANGE, LENS_BLURS, SCENES, TEXTURES, aoFor, finishOf, floorFor, sceneOf, takesFloorColor, type AOChoice, type FloorSurface, type Materials, type ScenePreset } from '../render/looks';

const css = (rgb: readonly number[]) => `rgb(${rgb.join(',')})`;
/** The backdrop as CSS: the same stops (and pool of light) the renderer uses. */
function sceneBackground(scene: ScenePreset): string {
  const stops = [...scene.stops].reverse().map((s) => `${css(s.rgb)} ${Math.round((1 - s.at) * 100)}%`).join(', ');
  const linear = `linear-gradient(180deg, ${stops})`;
  if (!scene.spot) return linear;
  const { x, y, radius, rgb } = scene.spot;
  return `radial-gradient(ellipse ${radius * 100}% ${radius * 80}% at ${x * 100}% ${y * 100}%, ${css(rgb)}, transparent 100%), ${linear}`;
}

/** A brick-red ball lit like each finish. */
function finishBall(id: string): CSSProperties {
  const f = finishOf(id);
  const base = f.tint ?? '#b3261e';
  const spec = Math.round(255 * (0.35 + f.clearcoat * 0.6));
  const size = Math.round(18 + f.roughness * 55);
  const sheen = f.iridescence ? `, conic-gradient(from 200deg at 60% 60%, #ffd6f566, #b7f0ff66, #fff6b766, #ffd6f566)` : '';
  return {
    background: `radial-gradient(circle at 34% 30%, rgba(${spec},${spec},${spec},${0.55 + f.clearcoat * 0.4}) 0, transparent ${size}%)${sheen}, radial-gradient(circle at 50% 55%, ${base} 0, color-mix(in srgb, ${base} 55%, #000) 100%)`,
  };
}

const ENV_SWATCH: Record<string, string> = {
  room: 'linear-gradient(180deg, #f4f4f6 0 45%, #c9c9cf 45% 100%)',
  studio: 'radial-gradient(ellipse 30% 25% at 30% 35%, #fff, transparent 70%), radial-gradient(ellipse 30% 25% at 72% 35%, #fff, transparent 70%), linear-gradient(180deg, #d8d8dc, #9d9da3)',
  city: 'linear-gradient(180deg, #9fc4e8 0 40%, #8a8d93 40% 48%, #b9a98f 48% 60%, #6e7178 60% 100%)',
  sunset: 'radial-gradient(circle at 50% 58%, #ffe3a0 0 8%, transparent 20%), linear-gradient(180deg, #6f7fb5 0%, #f2a65e 55%, #3c3530 60%, #241f1c 100%)',
  night: 'radial-gradient(circle at 25% 30%, #fff 0 1%, transparent 2%), radial-gradient(circle at 70% 20%, #fff 0 1%, transparent 2%), radial-gradient(circle at 55% 45%, #ffd 0 1%, transparent 2%), linear-gradient(180deg, #0c1230 0 60%, #1b1b22 60% 100%)',
  warehouse: 'linear-gradient(90deg, transparent 0 20%, #f6f3e8 20% 32%, transparent 32% 60%, #f6f3e8 60% 72%, transparent 72%) 0 20% / 100% 40% no-repeat, linear-gradient(180deg, #7b766c, #4a4740)',
};

const TEXTURE_SWATCH: Record<string, string> = {
  none: 'linear-gradient(135deg, #c7362b, #9e2219)',
  grain: 'repeating-radial-gradient(circle at 30% 40%, #b52c22 0 1px, #a8271e 1px 2px)',
  worn: 'radial-gradient(circle at 30% 30%, #c46b63 0 12%, transparent 30%), linear-gradient(120deg, transparent 45%, #d8857d 46% 48%, transparent 49%), linear-gradient(135deg, #b9332a, #8f2018)',
  speckle: 'radial-gradient(circle at 20% 30%, #3b0e0a 0 4%, transparent 5%), radial-gradient(circle at 65% 60%, #3b0e0a 0 5%, transparent 6%), radial-gradient(circle at 80% 20%, #3b0e0a 0 3%, transparent 4%), radial-gradient(circle at 40% 80%, #3b0e0a 0 4%, transparent 5%), linear-gradient(135deg, #c7362b, #9e2219)',
  glitter: 'radial-gradient(circle at 25% 35%, #fff 0 3%, transparent 4%), radial-gradient(circle at 70% 25%, #fff 0 2%, transparent 3%), radial-gradient(circle at 55% 70%, #ffe 0 3%, transparent 4%), radial-gradient(circle at 15% 80%, #fff 0 2%, transparent 3%), linear-gradient(135deg, #c7362b, #9e2219)',
};
/** A stud seen from above, with or without a hint of the logo. */
/** A brick corner: a light rim along the edge when rounded. */
const EDGE_SWATCH = (rounded: boolean) => rounded
  ? 'linear-gradient(135deg, #c9cbd3 0 44%, #ffffff 47% 51%, #9a9ca6 54% 100%)'
  : 'linear-gradient(135deg, #c9cbd3 0 49.5%, #9a9ca6 50.5% 100%)';

const STUD_SWATCH = (logo: boolean) =>
  `${logo ? 'linear-gradient(90deg, transparent 38%, #ffffff55 38% 62%, transparent 62%) 50% 50% / 40% 12% no-repeat, ' : ''}radial-gradient(circle at 50% 50%, #d23a2e 0 34%, #8f2018 35% 40%, #c7362b 41%)`;
const FLOOR_SWATCH: Record<FloorSurface, string> = {
  auto: 'linear-gradient(180deg, #d9d9df 50%, #c9c9d0 50%)',
  shadow: 'radial-gradient(ellipse 45% 18% at 50% 70%, #00000055, transparent), linear-gradient(180deg, #d2d2d8, #c4c4cc)',
  // a floor that curves up into the wall: a soft vertical gradient with a light band where it bends
  sweep: 'radial-gradient(ellipse 40% 14% at 50% 78%, #00000040, transparent), linear-gradient(180deg, #c6c6cd 0%, #dedee3 58%, #ececf0 70%, #d6d6dc 100%)',
  reflective: 'linear-gradient(180deg, #e6e6ea 52%, #f4f4f7 52%), linear-gradient(0deg, #b3261e33, transparent)',
  matte: 'linear-gradient(180deg, #ececef 50%, #dcdce0 50%)',
  wood: 'repeating-linear-gradient(0deg, #c9a172 0 9px, #b98f60 9px 10px), repeating-linear-gradient(90deg, #00000008 0 2px, transparent 2px 5px)',
  concrete: 'radial-gradient(circle at 30% 40%, #9d9d99 0 2%, transparent 3%), radial-gradient(circle at 70% 70%, #a4a4a0 0 2%, transparent 3%), linear-gradient(135deg, #b9b9b5, #a9a9a5)',
  none: 'repeating-conic-gradient(#e9e9ee 0 25%, #fff 0 50%) 0 0 / 12px 12px',
};

/** Studio paper colours, from white to black and a few backdrop tints. */
const FLOOR_COLORS: { hex: string; name: string }[] = [
  { hex: '#f4f4f2', name: 'White' }, { hex: '#d9d9d6', name: 'Light grey' }, { hex: '#a0a2a5', name: 'Mid grey' },
  { hex: '#3a3d43', name: 'Charcoal' }, { hex: '#15161a', name: 'Black' }, { hex: '#e9dcc6', name: 'Warm beige' },
  { hex: '#9fc5ee', name: 'Powder blue' }, { hex: '#f5bfa5', name: 'Peach' }, { hex: '#abb39e', name: 'Sage' }, { hex: '#9883e8', name: 'Lavender' },
];

/** Floor colour for the curved sweep and the matte table: the scene's own, a studio paper colour, or any colour. */
function FloorColor({ m, kind, sceneColor, set }: { m: Materials; kind: FloorSurface; sceneColor: string; set(p: Partial<Materials>): void }) {
  const usable = takesFloorColor(kind);
  const current = m.floorColor ?? sceneColor;
  return (
    <div className={`bm-floor-color${usable ? '' : ' off'}`}>
      <div className="bm-mat-row"><span>Floor colour</span><span className="nx-fine">{m.floorColor ? current : 'Scene colour'}</span></div>
      <div className="bm-floor-swatches" role="group" aria-label="Floor colour">
        <button type="button" className={`bm-floor-swatch scene${m.floorColor ? '' : ' selected'}`} title={`Scene colour (${sceneColor})`} aria-label="Scene colour"
          disabled={!usable} style={{ background: sceneColor }} onClick={() => set({ floorColor: null })}>S</button>
        {FLOOR_COLORS.map((c) => (
          <button key={c.hex} type="button" className={`bm-floor-swatch${m.floorColor === c.hex ? ' selected' : ''}`} title={c.name} aria-label={c.name}
            disabled={!usable} style={{ background: c.hex }} onClick={() => set({ floorColor: c.hex })} />
        ))}
        <label className={`bm-floor-swatch custom${m.floorColor && !FLOOR_COLORS.some((c) => c.hex === m.floorColor) ? ' selected' : ''}`} title="Any colour">
          <input type="color" aria-label="Custom floor colour" disabled={!usable} value={current}
            onChange={(e) => set({ floorColor: e.target.value.toLowerCase() })} />
        </label>
      </div>
      {!usable && <span className="nx-hint">Pick Curved sweep or Matte table to colour the floor; the other floors show the scene backdrop, a texture or a mirror.</span>}
    </div>
  );
}

export function Section({ title, value, children }: { title: string; value?: string; children: ReactNode }) {
  return (
    <details className="nx-group bm-vsec bm-mat-sec" open>
      <summary>{title}{value && <span className="bm-vsec-val">{value}</span>}</summary>
      {children}
    </details>
  );
}

export function Card({ selected, label, hint, swatch, onClick }: { selected: boolean; label: string; hint: string; swatch: ReactNode; onClick(): void }) {
  return (
    <button className={`bm-mat-card${selected ? ' selected' : ''}`} aria-pressed={selected} title={hint} onClick={onClick}>
      {swatch}
      <span className="bm-mat-label">{label}</span>
    </button>
  );
}

const GLASS_SWATCH: Record<string, string> = {
  soft: 'radial-gradient(circle at 35% 30%, #ffffffaa 0 12%, transparent 30%), linear-gradient(135deg, #9fd3ffaa, #5aa7e6cc)',
  clear: 'radial-gradient(circle at 30% 25%, #fff 0 6%, transparent 12%), linear-gradient(160deg, transparent 40%, #ffffff99 42% 46%, transparent 48%), linear-gradient(135deg, #d9f0ff, #7cc3f5 70%, #3d8fd1)',
};
const LENS_SWATCH: Record<string, string> = {
  off: 'radial-gradient(circle at 50% 60%, #c7362b 0 18%, transparent 19%), radial-gradient(circle at 22% 35%, #3a7bd5 0 10%, transparent 11%), radial-gradient(circle at 78% 30%, #f2c230 0 10%, transparent 11%), #e6e6ea',
  subtle: 'radial-gradient(circle at 50% 60%, #c7362b 0 18%, transparent 19%), radial-gradient(circle at 22% 35%, #3a7bd5 0 7%, #3a7bd544 12%, transparent 15%), radial-gradient(circle at 78% 30%, #f2c230 0 7%, #f2c23044 12%, transparent 15%), #e6e6ea',
  medium: 'radial-gradient(circle at 50% 60%, #c7362b 0 18%, transparent 19%), radial-gradient(circle at 22% 35%, #3a7bd5aa 0 4%, #3a7bd533 14%, transparent 20%), radial-gradient(circle at 78% 30%, #f2c230aa 0 4%, #f2c23033 14%, transparent 20%), #e6e6ea',
  strong: 'radial-gradient(circle at 50% 60%, #c7362b 0 18%, transparent 19%), radial-gradient(circle at 22% 35%, #3a7bd566 0 2%, #3a7bd522 18%, transparent 26%), radial-gradient(circle at 78% 30%, #f2c23066 0 2%, #f2c23022 18%, transparent 26%), #e6e6ea',
};

/** The LDraw colours used by the model (its own and the fixed colours inside parts), transparent ones first. */
function useModelColors(model: ModelState | undefined): { code: number; name: string; hex: string; trans: boolean }[] {
  const instances = model?.assembly.instances;
  return useMemo(() => {
    const colors = getColors();
    const codes = new Set<number>();
    for (const i of instances ?? []) {
      codes.add(i.color);
      for (const f of geometryOf(i.part)?.fixed ?? []) codes.add(f.color);
    }
    return [...codes].flatMap((code) => {
      const c = colors.get(code);
      return c ? [{ code, name: c.name.replace(/_/g, ' '), hex: c.hex, trans: c.finish === 'trans' }] : [];
    }).sort((a, b) => Number(b.trans) - Number(a.trans) || a.name.localeCompare(b.name));
  }, [instances]);
}

/** Materials: the scene around the model, how the plastic looks and the floor. The viewport, preview, MP4 and stills all use these. */
export function MaterialsPanel({ model }: { model?: ModelState }) {
  const s = useAppSettings();
  const m = s.materials;
  const modelColors = useModelColors(model);
  const glowSet = new Set(m.glow.colors);
  const toggleGlow = (code: number) => {
    // read the stored choice, not this render's: quick clicks must not undo each other
    const now = useAppSettings.getState().materials;
    const colors = now.glow.colors.includes(code) ? now.glow.colors.filter((c) => c !== code) : [...now.glow.colors, code];
    s.set({ materials: { ...now, glow: { ...now.glow, colors } } });
  };
  const setMaterials = (patch: Partial<Materials>) => s.set({ materials: { ...m, ...patch } });
  const scene = sceneOf(s.studioLook);
  const setAO = (patch: Partial<AOChoice>) => setMaterials({ ao: { ...m.ao, ...patch } });
  // what the sliders show: the user's values, or the scene's own when not overridden
  const aoScene = aoFor(s.studioLook, { enabled: true, strength: null, radius: null });
  const aoNow = { strength: m.ao.strength ?? aoScene.intensity, radius: m.ao.radius ?? aoScene.radius };
  // a scene can suggest edge lines on or off when it is picked; the toggle stays in charge after that
  const pickScene = (sc: (typeof SCENES)[number]) => s.set(sc.id === s.studioLook ? {} : { studioLook: sc.id, ...(sc.outlines === false ? { edgeLines: false } : {}) });
  return (
    <div className="nx-pane bm-materials" aria-label="Materials">
      <div className="nx-pane-head"><h3>Materials</h3></div>

      <Section title="Scene" value={scene.label}>
        <div className="nx-sub">Photo tabletop scenes</div>
        <div className="bm-mat-grid bm-mat-scenes">
          {SCENES.filter((sc) => sc.collection === 'photo').map((sc) => (
            <Card key={sc.id} selected={s.studioLook === sc.id} label={sc.label} hint={sc.hint} onClick={() => pickScene(sc)}
              swatch={<span className="bm-mat-swatch bm-mat-scene bm-mat-photo-scene" style={{ background: sceneBackground(sc) }}>
                <em className="bm-photo-part-a" /><em className="bm-photo-part-b" /><em className="bm-photo-part-c" />
              </span>} />
          ))}
        </div>
        <div className="nx-sub">Render studio scenes</div>
        <div className="bm-mat-grid bm-mat-scenes">
          {SCENES.filter((sc) => sc.collection === 'render').map((sc) => (
            <Card key={sc.id} selected={s.studioLook === sc.id} label={sc.label} hint={sc.hint} onClick={() => pickScene(sc)}
              swatch={<span className="bm-mat-swatch bm-mat-scene bm-mat-photo-scene" style={{ background: sceneBackground(sc) }}>
                <em className="bm-photo-part-a" /><em className="bm-photo-part-b" /><em className="bm-photo-part-c" />
              </span>} />
          ))}
        </div>
        <div className="nx-sub">Classic studio scenes</div>
        <div className="bm-mat-grid bm-mat-scenes">
          {SCENES.filter((sc) => !sc.collection).map((sc) => (
            <Card key={sc.id} selected={s.studioLook === sc.id} label={sc.label} hint={sc.hint} onClick={() => pickScene(sc)}
              swatch={<span className="bm-mat-swatch bm-mat-scene" style={{ background: sceneBackground(sc) }}><i style={{ background: sc.floor === 'none' ? 'transparent' : sc.floorColor }} /></span>} />
          ))}
        </div>
        <span className="nx-hint">{scene.hint}. Photo and render scenes include a directional key, a color-tuned fill and a rim light. Custom Scene lights can replace this rig.</span>
      </Section>

      <Section title="Environment" value={ENVIRONMENTS.find((e) => e.id === m.environment)?.label}>
        <div className="bm-mat-grid">
          {ENVIRONMENTS.map((e) => (
            <Card key={e.id} selected={m.environment === e.id} label={e.label} hint={e.hint} onClick={() => setMaterials({ environment: e.id })}
              swatch={<span className="bm-mat-swatch" style={{ background: ENV_SWATCH[e.id] }} />} />
          ))}
        </div>
        <span className="nx-hint">What the plastic reflects and is softly lit by. The photo environments give glossy bricks varied, real-world highlights; the backdrop and lights stay the scene's own.</span>
      </Section>

      <Section title="Brick finish" value={finishOf(m.finish).label}>
        <div className="bm-mat-grid">
          {FINISHES.map((f) => (
            <Card key={f.id} selected={m.finish === f.id} label={f.label} hint={f.hint} onClick={() => setMaterials({ finish: f.id })}
              swatch={<span className="bm-mat-swatch bm-mat-ball" style={finishBall(f.id)} />} />
          ))}
        </div>
        <span className="nx-hint">Transparent, chrome and rubber parts keep their own surface.</span>
      </Section>

      <Section title="Surface texture" value={TEXTURES.find((t) => t.id === m.texture)?.label}>
        <div className="bm-mat-grid">
          {TEXTURES.map((t) => (
            <Card key={t.id} selected={m.texture === t.id} label={t.label} hint={t.hint} onClick={() => setMaterials({ texture: t.id })}
              swatch={<span className="bm-mat-swatch" style={{ background: TEXTURE_SWATCH[t.id] }} />} />
          ))}
        </div>
        <span className="nx-hint">Textures are drawn on each part and move with it. Look closely: they are meant to be subtle.</span>
      </Section>

      <Section title="Studs" value={m.studLogos ? 'LEGO logo' : 'Plain'}>
        <div className="bm-mat-grid">
          <Card selected={m.studLogos} label="LEGO logo" hint="The raised logo on every stud, like real bricks" onClick={() => setMaterials({ studLogos: true })}
            swatch={<span className="bm-mat-swatch" style={{ background: STUD_SWATCH(true) }} />} />
          <Card selected={!m.studLogos} label="Plain" hint="Smooth studs: lighter for very large models" onClick={() => setMaterials({ studLogos: false })}
            swatch={<span className="bm-mat-swatch" style={{ background: STUD_SWATCH(false) }} />} />
        </div>
        <span className="nx-hint">Logos add detail to every stud. Switch to plain if a very large model gets slow.</span>
      </Section>

      <Section title="Part detail" value={m.detail === 'high' ? 'High' : 'Standard'}>
        <div className="bm-mat-grid">
          <Card selected={m.detail !== 'high'} label="Standard" hint="The LDraw shapes as they are: fastest" onClick={() => setMaterials({ detail: 'standard' })}
            swatch={<span className="bm-mat-swatch" style={{ background: EDGE_SWATCH(false) }} />} />
          <Card selected={m.detail === 'high'} label="High" hint="Smooth round parts and real rounded edges, like product renders" onClick={() => setMaterials({ detail: 'high' })}
            swatch={<span className="bm-mat-swatch" style={{ background: EDGE_SWATCH(true) }} />} />
        </div>
        <span className="nx-hint">High uses 48-segment curves and rounds every sharp outside edge in the geometry, so it also shows in path-traced stills. It is heavier: use Standard if a very large model gets slow. Snapping and the build animation are not affected.</span>
      </Section>

      <Section title="Edges" value={`${m.roundedEdges ? 'Rounded' : 'Sharp'}${s.edgeLines ? ' · lines' : ''}`}>
        <div className="bm-mat-grid">
          <Card selected={m.roundedEdges} label="Rounded" hint="A thin highlight on every outside corner, like moulded plastic" onClick={() => setMaterials({ roundedEdges: true })}
            swatch={<span className="bm-mat-swatch" style={{ background: EDGE_SWATCH(true) }} />} />
          <Card selected={!m.roundedEdges} label="Sharp" hint="The exact sharp corners of the LDraw parts" onClick={() => setMaterials({ roundedEdges: false })}
            swatch={<span className="bm-mat-swatch" style={{ background: EDGE_SWATCH(false) }} />} />
        </div>
        <label className="nx-check"><input type="checkbox" checked={s.edgeLines} onChange={(e) => s.set({ edgeLines: e.target.checked })} /> Edge lines</label>
        <span className="nx-hint">Rounded edges are a lighting effect, not new geometry. Edge lines draw the thin LDraw outlines; render scenes start with them off.</span>
      </Section>

      <Section title="Glowing parts" value={m.glow.colors.length ? `${m.glow.colors.length} colour${m.glow.colors.length === 1 ? '' : 's'}` : 'None'}>
        {modelColors.length ? (
          <div className="bm-glow-list" role="group" aria-label="Colours that glow">
            {modelColors.map((c) => (
              <button key={c.code} type="button" className={`bm-glow-chip${glowSet.has(c.code) ? ' on' : ''}`} aria-pressed={glowSet.has(c.code)}
                title={`${c.name} (${c.code})`} onClick={() => toggleGlow(c.code)}>
                <i style={{ background: c.hex, boxShadow: glowSet.has(c.code) ? `0 0 8px 2px ${c.hex}` : undefined }} />
                <span>{c.name}</span>
              </button>
            ))}
          </div>
        ) : <span className="nx-hint">Open a model to choose which of its colours glow.</span>}
        <label className="bm-mat-slider">Brightness <span>{Math.round(m.glow.strength * 100)}%</span>
          <input type="range" min={GLOW_STRENGTH_RANGE[0]} max={GLOW_STRENGTH_RANGE[1]} step={0.05} value={m.glow.strength} disabled={!m.glow.colors.length}
            aria-label="Glow brightness" onChange={(e) => setMaterials({ glow: { ...m.glow, strength: Number(e.target.value) } })} />
        </label>
        <span className="nx-hint">Pick the colours of lamps, windows or screens. Every part in that colour gives off its own light; in path-traced stills and videos it also lights the parts around it. Transparent colours are listed first.</span>
      </Section>

      <Section title="Glass" value={GLASS_LOOKS.find((g) => g.id === m.glass)?.label}>
        <div className="bm-mat-grid">
          {GLASS_LOOKS.map((g) => (
            <Card key={g.id} selected={m.glass === g.id} label={g.label} hint={g.hint} onClick={() => setMaterials({ glass: g.id })}
              swatch={<span className="bm-mat-swatch" style={{ background: GLASS_SWATCH[g.id] }} />} />
          ))}
        </div>
        <span className="nx-hint">Clear glass bends and tints the light passing through transparent parts, like real windshields and bottles. It shows in path-traced stills and videos; the viewport keeps the soft look.</span>
      </Section>

      <Section title="Camera lens" value={LENS_BLURS.find((b) => b.id === m.lens.blur)?.label}>
        <div className="bm-mat-grid">
          {LENS_BLURS.map((b) => (
            <Card key={b.id} selected={m.lens.blur === b.id} label={b.label} hint={b.hint} onClick={() => setMaterials({ lens: { ...m.lens, blur: b.id } })}
              swatch={<span className="bm-mat-swatch" style={{ background: LENS_SWATCH[b.id] }} />} />
          ))}
        </div>
        <label className="bm-mat-slider">Focus <span>{m.lens.focus < 0.15 ? 'Front' : m.lens.focus > 0.85 ? 'Back' : m.lens.focus < 0.4 ? 'Front half' : m.lens.focus > 0.6 ? 'Back half' : 'Middle'}</span>
          <input type="range" min={0} max={1} step={0.05} value={m.lens.focus} disabled={m.lens.blur === 'off'}
            aria-label="Focus depth" onChange={(e) => setMaterials({ lens: { ...m.lens, focus: Number(e.target.value) } })} />
        </label>
        <span className="nx-hint">Depth of field: the model stays sharp at the focus and the background and foreground soften, like a close-up photo. Focus runs from the nearest point of the model to the farthest. Applies to final renders (opaque) and MP4 exports, not the viewport.</span>
      </Section>

      <Section title="Ambient occlusion" value={!m.ao.enabled ? 'Off' : m.ao.strength === null && m.ao.radius === null ? 'Scene' : 'Custom'}>
        <div className="bm-mat-row">
          <label className="nx-check"><input type="checkbox" checked={m.ao.enabled} onChange={(e) => setAO({ enabled: e.target.checked })} /> On</label>
          <button type="button" className="nx-btn" disabled={m.ao.strength === null && m.ao.radius === null} onClick={() => setAO({ strength: null, radius: null })}>Use scene values</button>
        </div>
        <label className="bm-mat-slider">Strength <span>{Math.round(aoNow.strength * 100)}%{m.ao.strength === null ? ' · scene' : ''}</span>
          <input type="range" min={AO_STRENGTH_RANGE[0]} max={AO_STRENGTH_RANGE[1]} step={0.05} value={aoNow.strength} disabled={!m.ao.enabled}
            aria-label="Ambient occlusion strength" onChange={(e) => setAO({ strength: Number(e.target.value) })} />
        </label>
        <label className="bm-mat-slider">Reach <span>{aoNow.radius.toFixed(2)} stud{m.ao.radius === null ? ' · scene' : ''}</span>
          <input type="range" min={AO_RADIUS_RANGE[0]} max={AO_RADIUS_RANGE[1]} step={0.05} value={aoNow.radius} disabled={!m.ao.enabled}
            aria-label="Ambient occlusion reach" onChange={(e) => setAO({ radius: Number(e.target.value) })} />
        </label>
        <span className="nx-hint">The soft darkening where parts touch the floor and each other. Strength is how dark it gets; reach is how far it spreads from the contact. Each scene has its own values until you change them.</span>
      </Section>

      <Section title="Floor" value={FLOORS.find((f) => f.id === m.floor)?.label}>
        <div className="bm-mat-grid">
          {FLOORS.map((f) => (
            <Card key={f.id} selected={m.floor === f.id} label={f.label} hint={f.hint} onClick={() => setMaterials({ floor: f.id })}
              swatch={<span className="bm-mat-swatch" style={{ background: FLOOR_SWATCH[f.id] }} />} />
          ))}
        </div>
        <FloorColor m={m} kind={floorFor(s.studioLook, m.floor)} sceneColor={scene.floorColor} set={setMaterials} />
        {floorFor(s.studioLook, m.floor) === 'sweep' && <>
          <label className="bm-mat-slider">Curve <span>{(m.sweepCurve ?? 0.6) < 0.34 ? 'Tight' : (m.sweepCurve ?? 0.6) > 0.7 ? 'Long and soft' : 'Medium'}</span>
            <input type="range" min={0} max={1} step={0.05} value={m.sweepCurve ?? 0.6} aria-label="Sweep curve" onChange={(e) => setMaterials({ sweepCurve: Number(e.target.value) })} />
          </label>
          <span className="nx-hint">How the floor bends up into the wall: a tight corner, or a long soft curve that starts just behind the model. The sweep turns with the camera, so it is always behind the model.</span>
        </>}
        <label className="bm-mat-slider">Contact shadow <span>{m.contactShadows === 0 ? 'Off' : `${Math.round(m.contactShadows * 100)}%`}</span>
          <input type="range" min={0} max={1} step={0.05} value={m.contactShadows} aria-label="Contact shadow" onChange={(e) => setMaterials({ contactShadows: Number(e.target.value) })} />
        </label>
        <span className="nx-hint">A soft, blurred shadow pooled right under the model, on top of the lights' own shadows, so it sits on the floor instead of floating.</span>
      </Section>

    </div>
  );
}
