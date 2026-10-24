import { describe, expect, test } from 'vitest';
import type { ANode } from '../../src/model/assemblyTypes';
import type { Mat3 } from '../../src/ldraw/parse';
import type { PartMetrics } from '../../src/ldraw/metrics';
import type { Snap } from '../../src/ldraw/shadow';
import { modelFromNodes } from '../../src/anim/construction/input';
import { MeshOracle } from '../../src/anim/construction/collision';
import { certifiedMechanicalContact } from '../../src/anim/construction/mechanicalContacts';

const mat: Mat3 = [1,0,0,0,1,0,0,0,1];
const points: [number,number,number][] = [
  [-.5,-.5,-.5],[.5,-.5,-.5],[.5,.5,-.5],[-.5,.5,-.5],
  [-.5,-.5,.5],[.5,-.5,.5],[.5,.5,.5],[-.5,.5,.5],
];
const faces = [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5];
const mesh = Float32Array.from(faces.flatMap(i => points[i]));
const body = { min: [-.5,-.5,-.5] as [number,number,number], max: [.5,.5,.5] as [number,number,number] };
const snap = (gender: 'M'|'F'): Snap => ({kind:'cyl',gender,start:[-1,0,0],axis:[1,0,0],length:2,radius:.55,shapes:['R'],slide:true});
const metrics = (part: string): PartMetrics => ({ id:part,body,full:body,mesh,placeholder:false,studs:[],heightPlates:1,footprint:{w:1,d:1},snaps: part==='male'?[snap('M')]:part==='female'?[snap('F')]:[] });
const piece = (itemId: string, part: string, pos: [number,number,number]=[0,0,0]): ANode => ({kind:'piece',itemId,model:'',part,step:0,order:0,body,local:{pos,m:mat},color:16,grid:false,placeholder:false});
const stats = () => ({ states:0,candidates:0,backtracks:0,meshPairs:0,trianglePairs:0,cacheHits:0,milliseconds:0 });

describe('Construction V2: localized mechanical final contacts', () => {
  test('only the measured mating cylinders explain the final contact; the policy stays static-only', () => {
    const model = modelFromNodes([piece('a','male'),piece('b','female')], metrics);
    const oracle = new MeshOracle(model,stats());
    expect(oracle.clear('a','b',[0,0,0],[0,0,0],[0,0,0])).toBe(false);
    const certificate = certifiedMechanicalContact(model,model.parts.get('a')!,model.parts.get('b')!,oracle);
    expect(certificate?.kind).toBe('mechanical');
    expect(certificate?.staticOnly).toBe(true);
    expect(certificate?.regions?.length).toBe(1);
    expect(oracle.clear('a','b',[0,0,0],[0,0,0],[0,0,0],certificate)).toBe(true);
    // A valid completed contact is NOT an exemption to move through the box.
    expect(oracle.clear('a','b',[-3,0,0],[0,0,0],[6,0,0],certificate)).toBe(false);
  });

  test('nearby but unmated parts cannot obtain the mechanical certificate', () => {
    const model = modelFromNodes([piece('a','male'),piece('b','other')],metrics);
    const oracle = new MeshOracle(model,stats());
    expect(certifiedMechanicalContact(model,model.parts.get('a')!,model.parts.get('b')!,oracle)).toBeUndefined();
  });

  test('valid snap axes cannot exempt an intersection outside the narrow mating region', () => {
    const offset = (part: string): PartMetrics => ({...metrics(part),snaps:part==='male'?[{...snap('M'),start:[-1,0,0],radius:.05}]:[{...snap('F'),start:[-1,0,0],radius:.05}]});
    const model = modelFromNodes([piece('a','male'),piece('b','female')],offset);
    const oracle = new MeshOracle(model,stats());
    expect(certifiedMechanicalContact(model,model.parts.get('a')!,model.parts.get('b')!,oracle)).toBeUndefined();
  });
});
