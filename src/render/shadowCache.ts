import * as THREE from 'three';

/** Native shadow maps depend on casters and lights, not the viewing camera.
 * Keep each light's map until a model pose, material, or light changes. AO's
 * temporary renders disable the global shadow pass, so they cannot consume the
 * per-light dirty flag before the beauty render. */
export class ShadowCache {
  private previous = new WeakMap<THREE.LightShadow, number[]>();
  update(scene: THREE.Scene, root: THREE.Object3D, structure: number, pose: number, revision: number): void {
    scene.updateMatrixWorld(true);
    scene.traverse(object => {
      const light = object as THREE.DirectionalLight;
      if (!light.isLight || !light.castShadow || !light.shadow) return;
      const shadow = light.shadow;
      light.target?.updateMatrixWorld(true);
      const values = [structure, pose, revision, Number(root.visible), Number(light.visible),
        ...root.matrixWorld.elements, ...light.matrixWorld.elements, ...(light.target?.matrixWorld.elements ?? []),
        ...shadow.camera.projectionMatrix.elements, shadow.mapSize.x, shadow.mapSize.y,
        shadow.bias, shadow.normalBias, shadow.radius, light.intensity,
      ];
      const previous = this.previous.get(shadow);
      if (!previous || values.some((value, i) => value !== previous[i]) || values.length !== previous.length) {
        shadow.needsUpdate = true;
        this.previous.set(shadow, values);
      }
      shadow.autoUpdate = false;
    });
  }
}
