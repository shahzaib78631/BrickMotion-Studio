import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { orientedSelectionFrame, SelectionCage } from '../../src/ui/SelectionCage';

const body = { min: [-20,-5,-10] as [number,number,number], max: [20,5,10] as [number,number,number] };
describe('orientation-aware cyan selection frame',()=>{
  it('fits the selected part in its own rotated axes',()=>{
    const matrix=new THREE.Matrix4().makeRotationY(Math.PI/4);
    const obb=orientedSelectionFrame([{matrix,body}])!;
    expect(obb).not.toBeNull();
    expect(obb.size.x).toBeCloseTo(2.075,5);
    expect(obb.size.y).toBeCloseTo(.575,5);
    expect(obb.size.z).toBeCloseTo(1.075,5);
    // the frame turns with the part: its local x runs 45° across the view, not axis-aligned
    const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(obb.rotation);
    expect(Math.abs(axis.x)).toBeCloseTo(Math.SQRT1_2, 5);
    expect(Math.abs(axis.z)).toBeCloseTo(Math.SQRT1_2, 5);
  });
  it('includes all members in one first-part local group frame',()=>{
    const second=new THREE.Matrix4().makeTranslation(60,0,0);
    const obb=orientedSelectionFrame([{matrix:new THREE.Matrix4(),body},{matrix:second,body}])!;
    expect(obb.size.x).toBeGreaterThan(4.8);
  });
  it('uses a proper orthogonal frame even when an imported part is mirrored',()=>{
    const obb=orientedSelectionFrame([{matrix:new THREE.Matrix4().makeScale(-1,1,1),body}])!;
    expect(obb.size.x).toBeCloseTo(2.075,5);
    const rot=new THREE.Matrix4().makeRotationFromQuaternion(obb.rotation);
    expect(rot.determinant()).toBeCloseTo(1,5);
  });
  it('can be created and disposed without adding invisible collision targets',()=>{
    const cage=new SelectionCage();
    cage.update([{matrix:new THREE.Matrix4(),body}]);
    expect(cage.group.visible).toBe(true);
    expect(cage.group.children.some(c=>c instanceof THREE.LineSegments)).toBe(true);
    cage.clear(); expect(cage.group.visible).toBe(false);
    cage.dispose();
  });
});
