/** Selected-piece OBB (cyan as in Studio), independent of editor gizmo and
 * invisible to exported videos. A group of rotated parts is boxed in the
 * first selected part's local frame, not an inaccurate world-space AABB.
 * No raycast target and no per-frame geometry reconstruction during dragging. */
import * as THREE from 'three';
import type { Box } from '../ldraw/flatten';
import type { MotionGuide } from '../plan/smartJoints';

export type CagedPart = { matrix: THREE.Matrix4; body: Box };
const TO_VIEW = new THREE.Matrix4().makeScale(1 / 20,-1 / 20,-1 / 20);
const axisY = new THREE.Vector3(0,1,0);

export function orientedSelectionFrame(parts:readonly CagedPart[]):{center:THREE.Vector3;size:THREE.Vector3;rotation:THREE.Quaternion}|null {
  if(!parts.length)return null;
  const e=TO_VIEW.clone().multiply(parts[0].matrix).elements;
  const x=new THREE.Vector3(e[0],e[1],e[2]).normalize();
  const y=new THREE.Vector3(e[4],e[5],e[6]).addScaledVector(x,-x.dot(new THREE.Vector3(e[4],e[5],e[6]))).normalize();
  if(x.lengthSq()<.9 || y.lengthSq()<.9)return null;
  const z=new THREE.Vector3().crossVectors(x,y).normalize();
  // This explicitly chooses a proper SO(3) frame even for reflected LDraw
  // instances; the OBB still uses all eight transformed corners.
  const q=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,y,z));
  const inv=q.clone().invert();
  const local=new THREE.Box3();
  for(const {matrix,body} of parts){
    const world=TO_VIEW.clone().multiply(matrix),p=new THREE.Vector3();
    for(let n=0;n<8;n++) {
      p.set(n&1?body.max[0]:body.min[0],n&2?body.max[1]:body.min[1],n&4?body.max[2]:body.min[2]);
      p.applyMatrix4(world).applyQuaternion(inv);
      local.expandByPoint(p);
    }
  }
  if(local.isEmpty())return null;
  const center=local.getCenter(new THREE.Vector3()).applyQuaternion(q);
  const size=local.getSize(new THREE.Vector3()).addScalar(.075);
  size.set(Math.max(.09,size.x),Math.max(.09,size.y),Math.max(.09,size.z));
  return {center,size,rotation:q};
}

export class SelectionCage {
  readonly group=new THREE.Group();
  private readonly wire:THREE.LineSegments;
  private readonly pivotGroup=new THREE.Group();
  private readonly marker:THREE.Mesh;
  private readonly axisLine:THREE.LineSegments;
  private base=new THREE.Matrix4();
  constructor(){
    this.group.name='Editor selection OBB (not exported)';
    const cyan=new THREE.LineBasicMaterial({color:0x58f0f2,transparent:true,opacity:.95,depthTest:false,depthWrite:false,toneMapped:false});
    this.wire=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1,1,1)),cyan);
    this.wire.renderOrder=1000;
    this.wire.frustumCulled=false;
    this.group.add(this.wire);
    const pointMat=new THREE.MeshBasicMaterial({color:0xffc758,depthTest:false,depthWrite:false,toneMapped:false});
    this.marker=new THREE.Mesh(new THREE.SphereGeometry(.065,12,8),pointMat);
    this.marker.renderOrder=1002;
    this.pivotGroup.add(this.marker);
    const geometry=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,-1,0),new THREE.Vector3(0,1,0)]);
    this.axisLine=new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({color:0xffb658,depthTest:false,depthWrite:false,toneMapped:false}));
    this.axisLine.renderOrder=1001;
    this.pivotGroup.add(this.axisLine);
    this.group.add(this.pivotGroup);
    this.group.visible=false;
    this.pivotGroup.visible=false;
  }
  /** Reused geometry, only matrices/scales change on selection updates. */
  update(parts:readonly CagedPart[], guide?:MotionGuide|null, displayPlacement?:THREE.Matrix4|null):void {
    const frame=orientedSelectionFrame(parts);
    if(!frame){this.clear();return;}
    this.group.visible=true;
    this.group.position.copy(frame.center);
    this.group.quaternion.copy(frame.rotation);
    this.group.scale.setScalar(1);
    this.wire.scale.copy(frame.size);
    this.group.updateMatrix();
    this.base.copy(this.group.matrix);
    // Pivot guide belongs to a separate world frame; convert to the cage's
    // local coordinates so updating the cage via one delta is exact.
    const constrained=guide && (guide.kind==='revolute'||guide.kind==='prismatic'||guide.kind==='cylindrical'||guide.kind==='ball');
    this.pivotGroup.visible=!!(constrained&&guide?.pivot);
    if(constrained&&guide?.pivot){
      const v=new THREE.Vector3(...guide.pivot).applyMatrix4(
        TO_VIEW.clone().multiply(displayPlacement ?? new THREE.Matrix4()));
      this.pivotGroup.position.copy(v.sub(frame.center).applyQuaternion(frame.rotation.clone().invert()));
      const a=guide.axis ?? [0,1,0];
      const sourceAxis=new THREE.Vector3(...a);
      const worldAxis=sourceAxis.transformDirection(TO_VIEW.clone().multiply(displayPlacement ?? new THREE.Matrix4()));
      const localAxis=worldAxis.applyQuaternion(frame.rotation.clone().invert());
      this.pivotGroup.quaternion.setFromUnitVectors(axisY,localAxis);
      this.axisLine.visible=guide.kind!=='ball';
      this.axisLine.scale.set(1,Math.max(.45,Math.min(3.6,frame.size.length()*.55)),1);
    }
  }
  /** Follow the same world delta applied to the selected LEGO pieces. */
  preview(delta:THREE.Matrix4):void {
    if(!this.group.visible)return;
    this.group.matrix.copy(delta).multiply(this.base);
    this.group.matrix.decompose(this.group.position,this.group.quaternion,this.group.scale);
  }
  clear():void{this.group.visible=false;this.pivotGroup.visible=false;}
  dispose():void{
    this.wire.geometry.dispose();(this.wire.material as THREE.Material).dispose();
    this.marker.geometry.dispose();(this.marker.material as THREE.Material).dispose();
    this.axisLine.geometry.dispose();(this.axisLine.material as THREE.Material).dispose();
  }
}
