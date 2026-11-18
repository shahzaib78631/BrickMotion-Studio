import { expect, test } from 'vitest';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ensureGlassThickness } from '../../src/render/glassThickness';
import { applyGlassOptics, glassTint, transportGlass, transmittedFraction } from '../../src/render/glassOptics';
import { materialFor, setBrickMaterials } from '../../src/render/materials';
import { tracedMaterial } from '../../src/export/pathTracedStill';
import { DEFAULT_MATERIALS, type GlassLook } from '../../src/render/looks';
import type { ColorDef } from '../../src/ldraw/colors';
const blue: ColorDef = {code:43,name:'Trans_Light_Blue',hex:'#AEE9EF',edge:'#59D1DE',alpha:128,finish:'trans'};
const optics = (m: THREE.MeshPhysicalMaterial) => [m.color.toArray(),m.attenuationColor.toArray(),m.attenuationDistance,m.ior,m.roughness,m.transmission,m.thickness];

test.each(['soft','clear','milky'] as GlassLook[])('%s has identical optics in viewport, interactive transport, and still export', look => {
 setBrickMaterials({finish:'eyesight',palette:'studio',texture:'none',glass:look});
 const viewport=materialFor(blue,false) as THREE.MeshPhysicalMaterial;
 const interactive=transportGlass(viewport);
 const still=tracedMaterial(viewport,{...DEFAULT_MATERIALS,glass:look}) as THREE.MeshPhysicalMaterial;
 expect(optics(interactive)).toEqual(optics(viewport));
 expect(optics(still)).toEqual(optics(viewport));
 expect(viewport.color.toArray()).toEqual([1,1,1]);
 expect(viewport.attenuationColor.equals(glassTint(blue,'studio'))).toBe(true);
 interactive.dispose();still.dispose();
});
test('absorption compounds with optical distance, keeping the clear channel clear',()=>{
 const tint=new THREE.Color().setRGB(.3,.7,1);
 const one=transmittedFraction(tint,.2),two=transmittedFraction(tint,.4);
 two.toArray().forEach((v,i)=>expect(v).toBeCloseTo(one.toArray()[i]**2,12));
 expect(transmittedFraction(tint,0).toArray()).toEqual([1,1,1]);
 expect(two.b).toBe(1);
});
test('wall thickness follows each face of a solid slab in LDU and is cached',()=>{
 const geometry=new THREE.BoxGeometry(40,8,20).toNonIndexed();
 const stats=ensureGlassThickness(geometry),attribute=geometry.getAttribute('bmGlassThickness');
 expect(stats.fallback).toBe(0);
 const normal=geometry.getAttribute('normal');
 for(let i=0;i<attribute.count;i++)expect(attribute.getX(i)).toBeCloseTo(normal.getX(i)?40:normal.getY(i)?8:20,4);
 expect(ensureGlassThickness(geometry)).toBe(stats);
 expect(geometry.getAttribute('bmGlassThickness')).toBe(attribute);
 geometry.dispose();
});
test('a cavity measures its wall rather than the full outer bounding box',()=>{
 const outer=new THREE.BoxGeometry(20,20,20).toNonIndexed();
 const inner=new THREE.BoxGeometry(16,16,16).toNonIndexed();
 const p=inner.getAttribute('position');
 // Reverse the inner boundary winding: its outward normal faces the air cavity.
 for(let i=0;i<p.count;i+=3)for(let k=0;k<3;k++){
  const v=p.getComponent(i+1,k);p.setComponent(i+1,k,p.getComponent(i+2,k));p.setComponent(i+2,k,v);
 }
 const geometry=mergeGeometries([outer,inner]);
 const stats=ensureGlassThickness(geometry);
 expect(stats.fallback).toBe(0);
 expect(stats.minLdu).toBeCloseTo(2,4);expect(stats.maxLdu).toBeCloseTo(2,4);
 geometry.dispose();outer.dispose();inner.dispose();
});
test('geometry edits invalidate the measured wall cache',()=>{
 const geometry=new THREE.BoxGeometry(20,8,20).toNonIndexed();
 const before=ensureGlassThickness(geometry);
 geometry.scale(1,2,1);
 const after=ensureGlassThickness(geometry);
 expect(after).not.toBe(before);
 const n=geometry.getAttribute('normal'),t=geometry.getAttribute('bmGlassThickness');
 for(let i=0;i<t.count;i++)if(n.getY(i))expect(t.getX(i)).toBeCloseTo(16,4);
 geometry.dispose();
});
test('unknown/open geometry reports its fallback explicitly',()=>{
 const geometry=new THREE.PlaneGeometry(20,20).toNonIndexed();
 const stats=ensureGlassThickness(geometry);
 expect(stats.measured).toBe(0);expect(stats.fallback).toBe(2);
 expect(stats.minLdu).toBe(1.2);
 geometry.dispose();
});
