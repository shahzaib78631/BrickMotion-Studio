import type { CSSProperties, ReactNode } from 'react';
import { useAppSettings } from '../state/appSettings';
import { AO_RADIUS_RANGE, AO_STRENGTH_RANGE, ENVIRONMENTS, FINISHES, FLOORS, SCENES, TEXTURES, aoFor, finishOf, sceneOf, type AOChoice, type FloorSurface, type Materials, type ScenePreset } from '../render/looks';

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
  reflective: 'linear-gradient(180deg, #e6e6ea 52%, #f4f4f7 52%), linear-gradient(0deg, #b3261e33, transparent)',
  matte: 'linear-gradient(180deg, #ececef 50%, #dcdce0 50%)',
  wood: 'repeating-linear-gradient(0deg, #c9a172 0 9px, #b98f60 9px 10px), repeating-linear-gradient(90deg, #00000008 0 2px, transparent 2px 5px)',
  concrete: 'radial-gradient(circle at 30% 40%, #9d9d99 0 2%, transparent 3%), radial-gradient(circle at 70% 70%, #a4a4a0 0 2%, transparent 3%), linear-gradient(135deg, #b9b9b5, #a9a9a5)',
  none: 'repeating-conic-gradient(#e9e9ee 0 25%, #fff 0 50%) 0 0 / 12px 12px',
};

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

/** Materials: the scene around the model, how the plastic looks and the floor. The viewport, preview, MP4 and stills all use these. */
export function MaterialsPanel() {
  const s = useAppSettings();
  const m = s.materials;
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
        <label className="bm-mat-slider">Contact shadow <span>{m.contactShadows === 0 ? 'Off' : `${Math.round(m.contactShadows * 100)}%`}</span>
          <input type="range" min={0} max={1} step={0.05} value={m.contactShadows} aria-label="Contact shadow" onChange={(e) => setMaterials({ contactShadows: Number(e.target.value) })} />
        </label>
        <span className="nx-hint">A soft, blurred shadow pooled right under the model, on top of the lights' own shadows, so it sits on the floor instead of floating.</span>
      </Section>

    </div>
  );
}
