import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Studio } from '../render/studio';
import { imagesOf, quaternionOf, referenceImage, rotationOf, updateImage, type ReferenceImage } from '../render/referenceImages';
import { sceneSetupOf, type SceneSetup, type XYZ } from '../render/sceneSetup';
import { useStudio } from '../state/store';
import { useReferenceView } from './referenceViewState';

export type ReferenceController = {
  sync(setup?: SceneSetup): void;
  /** the id of the unlocked image under the ray, or null */
  pick(ray: THREE.Raycaster): string | null;
  isHandlingPointer(): boolean;
  dispose(): void;
};

type Entry = { mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; src: string; texture: THREE.Texture | null };

/**
 * Draws the project's reference images in the editor view as flat, see-through panels, and
 * gives the selected one move and rotate handles. Only in the editor: the group is hidden
 * outside Edit mode, and previews, captures and videos draw their own scene without it.
 */
export function createReferenceImages(studio: Studio, orbit: OrbitControls, canvas: HTMLCanvasElement): ReferenceController {
  const group = new THREE.Group();
  group.name = 'reference-images';
  studio.scene.add(group);
  const proxy = new THREE.Object3D();
  studio.scene.add(proxy);
  const transform = new TransformControls(studio.camera, canvas);
  transform.setSize(0.72);
  transform.setSpace('world');
  transform.enabled = false;
  studio.scene.add(transform.getHelper());
  const entries = new Map<string, Entry>();
  const loader = new THREE.TextureLoader();
  let setup: SceneSetup | undefined;
  let dragging = false;
  let lastCamera: THREE.Camera = studio.camera;

  const commit = (patch: Partial<ReferenceImage>, id: string) => {
    const current = sceneSetupOf(useStudio.getState().plan.sceneSetup);
    useStudio.getState().apply((plan) => ({ ...plan, sceneSetup: updateImage(current, id, patch) }));
  };
  const selected = () => referenceImage(setup, useReferenceView.getState().selectedId);

  const attach = () => {
    if (dragging) return;
    const image = selected();
    if (!image || image.locked || !image.visible || useStudio.getState().mode !== 'edit') { transform.detach(); transform.enabled = false; return; }
    if (lastCamera !== studio.camera) { transform.camera = studio.camera; lastCamera = studio.camera; }
    proxy.position.fromArray(image.position);
    proxy.quaternion.copy(quaternionOf(image.rotation));
    transform.setMode(useReferenceView.getState().mode);
    transform.enabled = true;
    transform.attach(proxy);
  };
  transform.addEventListener('dragging-changed', (e) => {
    dragging = !!e.value;
    orbit.enabled = !dragging;
    if (dragging) useStudio.getState().beginGesture();
    else { useStudio.getState().endGesture(); attach(); }
  });
  transform.addEventListener('objectChange', () => {
    const image = selected();
    if (!dragging || !image) return;
    commit({ position: proxy.position.toArray().map((n) => Math.round(n * 1000) / 1000) as XYZ, rotation: rotationOf(proxy.quaternion) }, image.id);
  });
  const unsubscribe = useReferenceView.subscribe(() => attach());

  const sync = (next?: SceneSetup) => {
    setup = next;
    const edit = useStudio.getState().mode === 'edit';
    group.visible = edit;
    const images = imagesOf(next);
    const live = new Set(images.map((i) => i.id));
    for (const [id, entry] of entries) if (!live.has(id)) {
      group.remove(entry.mesh);
      entry.mesh.geometry.dispose(); entry.mesh.material.dispose(); entry.texture?.dispose();
      entries.delete(id);
    }
    for (const image of images) {
      let entry = entries.get(image.id);
      if (!entry) {
        const material = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
        mesh.renderOrder = -2;
        mesh.userData.referenceImage = image.id;
        group.add(mesh);
        entries.set(image.id, (entry = { mesh, src: '', texture: null }));
      }
      if (entry.src !== image.src) {
        entry.src = image.src;
        const mine = image.src;
        loader.load(image.src, (texture) => {
          const e = entries.get(image.id);
          if (!e || e.src !== mine) { texture.dispose(); return; }
          texture.colorSpace = THREE.SRGBColorSpace;
          e.texture?.dispose();
          e.texture = texture;
          e.mesh.material.map = texture;
          e.mesh.material.needsUpdate = true;
        });
      }
      const { mesh } = entry;
      mesh.visible = image.visible;
      mesh.position.fromArray(image.position);
      mesh.quaternion.copy(quaternionOf(image.rotation));
      mesh.scale.set(image.width, image.width / image.aspect, 1);
      mesh.material.opacity = image.opacity;
    }
    if (useReferenceView.getState().selectedId && !referenceImage(next, useReferenceView.getState().selectedId))
      useReferenceView.setState({ selectedId: null });
    attach();
  };

  return {
    sync,
    pick(ray) {
      if (!group.visible) return null;
      const hits = ray.intersectObjects([...entries.values()].filter((e) => e.mesh.visible).map((e) => e.mesh), false);
      for (const hit of hits) {
        const image = referenceImage(setup, hit.object.userData.referenceImage as string);
        if (image && !image.locked && image.opacity > 0.02) return image.id;
      }
      return null;
    },
    isHandlingPointer() { return dragging || !!transform.axis; },
    dispose() {
      unsubscribe();
      transform.detach();
      studio.scene.remove(transform.getHelper());
      transform.dispose();
      studio.scene.remove(proxy);
      for (const entry of entries.values()) { entry.mesh.geometry.dispose(); entry.mesh.material.dispose(); entry.texture?.dispose(); }
      entries.clear();
      studio.scene.remove(group);
    },
  };
}
