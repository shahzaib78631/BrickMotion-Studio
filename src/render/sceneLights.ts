import * as THREE from 'three';
import type { SceneSetup, SceneLight, SceneCamera } from './sceneSetup';

/** Editor helper objects never enter export's render; lights do. Reusing light
 * instances avoids reallocating shadow maps on every gizmo drag. */
export class SceneLighting {
  private lights = new Map<string, { light: THREE.Light; target?: THREE.Object3D }>();
  private markers = new Map<string, { mesh: THREE.Mesh; helper?: THREE.Object3D; camera?: THREE.PerspectiveCamera }>();
  private helpersVisible = false;
  private selection: string | null = null;
  constructor(private scene: THREE.Scene, private editor = true) {}

  private createLight(source: SceneLight) {
    let light: THREE.Light;
    switch (source.type) {
      case 'sun': light = new THREE.DirectionalLight(); break;
      case 'point': light = new THREE.PointLight(); break;
      case 'spot': light = new THREE.SpotLight(); break;
      default: light = new THREE.AmbientLight();
    }
    this.scene.add(light);
    let target: THREE.Object3D | undefined;
    if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
      target = light.target;
      this.scene.add(target);
    }
    return { light, target };
  }
  private createMarker(source: SceneCamera | SceneLight) {
    const geometry = source.kind === 'camera' ? new THREE.BoxGeometry(0.7, 0.45, 0.7) : new THREE.IcosahedronGeometry(0.34, 1);
    const material = new THREE.MeshBasicMaterial({ color: source.kind === 'camera' ? 0x5ebcf1 : source.type === 'sun' ? 0xffc75e : 0xffe8a1,
      depthTest: false, transparent: true, opacity: 0.92 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 900;
    mesh.userData.sceneObjectId = source.id;
    this.scene.add(mesh);
    let helper: THREE.Object3D | undefined;
    let camera: THREE.PerspectiveCamera | undefined;
    if (source.kind === 'camera') {
      camera = new THREE.PerspectiveCamera(source.fov, 1.5, source.near, Math.min(75, source.far));
      helper = new THREE.CameraHelper(camera);
      this.scene.add(helper);
    }
    return { mesh, helper, camera };
  }
  apply(setup?: SceneSetup, helpersVisible = this.helpersVisible, selectedId = this.selection, frameAspect = 16 / 9) {
    this.helpersVisible = helpersVisible;
    this.selection = selectedId;
    const all = [...(setup?.cameras ?? []), ...(setup?.lights ?? [])];
    const live = new Set(all.map((o) => o.id));
    for (const [id, entry] of this.lights) if (!live.has(id) || !setup?.lights.some((o) => o.id === id)) {
      this.scene.remove(entry.light);
      if (entry.target) this.scene.remove(entry.target);
      (entry.light as THREE.DirectionalLight).shadow?.map?.dispose();
      this.lights.delete(id);
    }
    for (const [id, entry] of this.markers) if (!live.has(id)) {
      this.scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      (entry.mesh.material as THREE.Material).dispose();
      if (entry.helper) { this.scene.remove(entry.helper); (entry.helper as THREE.CameraHelper).dispose?.(); }
      this.markers.delete(id);
    }
    for (const source of setup?.lights ?? []) {
      let entry = this.lights.get(source.id);
      if (!entry) { entry = this.createLight(source); this.lights.set(source.id, entry); }
      const { light, target } = entry;
      light.color.set(source.color);
      light.intensity = source.enabled && setup?.useLightsForVideo ? source.intensity : 0;
      light.position.fromArray(source.position);
      if (target) target.position.fromArray(source.target);
      if (light instanceof THREE.DirectionalLight || light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
        light.castShadow = source.enabled && source.castShadow && setup?.useLightsForVideo === true;
        light.shadow.mapSize.set(768, 768);
        light.shadow.bias = -0.0004;
        light.shadow.normalBias = 0.015;
      }
      if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
        light.distance = source.distance;
        light.decay = 2;
      }
      if (light instanceof THREE.SpotLight) {
        light.angle = THREE.MathUtils.degToRad(source.angle / 2);
        light.penumbra = 0.25;
      }
    }
    if (!this.editor) return;
    for (const source of all) {
      let entry = this.markers.get(source.id);
      if (!entry) { entry = this.createMarker(source); this.markers.set(source.id, entry); }
      entry.mesh.visible = helpersVisible;
      entry.mesh.position.fromArray(source.position);
      entry.mesh.scale.setScalar(source.id === selectedId ? 1.55 : 1);
      if (source.kind === 'camera') {
        const cam = entry.camera!;
        cam.position.fromArray(source.position);
        cam.lookAt(new THREE.Vector3(...source.target));
        cam.aspect = frameAspect;
        cam.fov = source.fov;
        cam.near = source.near;
        cam.far = Math.min(75, source.far);
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld(true);
        entry.mesh.quaternion.copy(cam.quaternion);
        entry.helper!.visible = helpersVisible && source.id === selectedId;
        (entry.helper as THREE.CameraHelper).update();
      } else {
        const direction = new THREE.Vector3(...source.target).sub(new THREE.Vector3(...source.position));
        if (direction.lengthSq() > 0.0001) entry.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), direction.normalize());
      }
    }
  }
  /** Size authored sun shadow volumes around the current model, not the tiny
   * Three.js default [-5,5] square, which clips helicopter-sized assemblies. */
  fitTo(box: THREE.Box3) {
    if (box.isEmpty()) return;
    const radius = Math.max(8, box.getSize(new THREE.Vector3()).length() * 0.7);
    for (const entry of this.lights.values()) {
      if (!(entry.light instanceof THREE.DirectionalLight)) continue;
      const shadow = entry.light.shadow.camera;
      shadow.left = shadow.bottom = -radius;
      shadow.right = shadow.top = radius;
      shadow.near = 0.1;
      shadow.far = Math.max(100, radius * 6);
      shadow.updateProjectionMatrix();
    }
  }
  setHelpersVisible(on: boolean) {
    this.helpersVisible = on;
    for (const [id, m] of this.markers) {
      m.mesh.visible = on;
      if (m.helper) m.helper.visible = on && id === this.selection;
    }
  }
  pick(ray: THREE.Raycaster): string | null {
    const hits = ray.intersectObjects([...this.markers.values()].map((m) => m.mesh).filter((m) => m.visible), false);
    return (hits[0]?.object.userData.sceneObjectId as string | undefined) ?? null;
  }
  dispose() {
    this.apply(undefined, false, null);
    for (const [id, entry] of this.markers) { // also handles removal after project has no scene setup
      this.scene.remove(entry.mesh); entry.mesh.geometry.dispose(); (entry.mesh.material as THREE.Material).dispose();
      if (entry.helper) { this.scene.remove(entry.helper); (entry.helper as THREE.CameraHelper).dispose?.(); }
      this.markers.delete(id);
    }
  }
}
