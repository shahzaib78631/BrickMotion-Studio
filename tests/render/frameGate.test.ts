import { expect, test } from 'vitest';
import { FrameGate } from '../../src/render/frameGate';

test('idle scenes stop full-rate rendering and keep an async-resource heartbeat', () => {
 const gate=new FrameGate(), scene={};
 expect(gate.shouldRender(0,[scene,1])).toBe(true);
 for(let time=16;time<250;time+=16)expect(gate.shouldRender(time,[scene,1])).toBe(false);
 expect(gate.shouldRender(250,[scene,1])).toBe(true);
});
test('camera, pose, editor changes and input redraw immediately', () => {
 const gate=new FrameGate();gate.shouldRender(0,[1]);
 expect(gate.shouldRender(1,[2])).toBe(true);
 gate.invalidate();expect(gate.shouldRender(2,[2])).toBe(true);
 expect(gate.shouldRender(3,[2])).toBe(false);
});
test('progressive path tracing keeps sampling on every frame', () => {
 const gate=new FrameGate();
 for(let time=0;time<100;time+=16)expect(gate.shouldRender(time,[1],true)).toBe(true);
});
