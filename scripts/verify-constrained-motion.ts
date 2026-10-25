/** Standalone regression checks; compile with tsc and run in Node. */
import { strict as assert } from 'node:assert';
import { findCertifiedDetour } from '../src/anim/construction/configurationSpace';
import { shiftBox, sweptBox, add, sub, type V3 } from '../src/anim/construction/math';
import type { Box } from '../src/ldraw/flatten';

const mover: Box = { min: [-1,-1,-1], max: [1,1,1] };
const obstacles: Box[] = [
  { min:[3,-3,-4], max:[6,2,8] },
  { min:[5,-3,8], max:[20,2,11] },
  { min:[-3,-3,11], max:[8,2,13] },
];
const origin: V3 = [0,0,0], goal: V3 = [15,0,15];
function fixture(shift:V3=[0,0,0]) {
  const solids = obstacles.map(b => shiftBox(b,shift));
  const box = shiftBox(mover,shift);
  const start=add(origin,shift), destination=add(goal,shift);
  const clear=(a:V3,b:V3): boolean => !solids.some(o=>sweptBox(shiftBox(box,sub(a,start)),o,sub(b,a),-1e-6));
  const run=(maxExpanded=64,maxEdges=210) => {
    let report;
    const found=findCertifiedDetour({ start, moving: box, obstacles:solids,
      scope:shiftBox({min:[-10,-10,-10],max:[20,2,20]},shift),
      sky: -8+shift[1],floor:3+shift[1], clearEdge:clear,
      complete:at=>clear(at,destination)?[destination]:null,
      maxExpanded, maxEdges, report:stats=>{report=stats;} });
    return {found,report};
  };
  return {run, clear, start, destination};
}
const one=fixture();
assert.equal(one.clear(one.start,one.destination),false,'direct diagonal route must be blocked');
const {found}=one.run();
assert.ok(found,'bounded roadmap should find a detour around the elbow obstacles');
assert.ok(found.waypoints.length>=4,'route needs several waypoints');
for(let i=1;i<found.waypoints.length;i++)
  assert.equal(one.clear(found.waypoints[i-1],found.waypoints[i]),true,`uncertified segment ${i}`);
assert.equal(found.waypoints.at(-1)!.join(','),one.destination.join(','));
const other=fixture([31,-20,-43]);
const translated=other.run();
assert.ok(translated.found,'moving the entire scene must preserve detour feasibility');
const relative=translated.found!.waypoints.map(p=>sub(p,[31,-20,-43]));
assert.deepEqual(relative,found.waypoints,'global translation invariance');
assert.deepEqual(one.run().found?.waypoints,found.waypoints,'deterministic route');
const bounded=one.run(2,4);
assert.equal(bounded.found,null,'budget exhaustion is an unknown, not a clearance approval');
assert.ok(bounded.report);
let cancelled=false;
assert.throws(()=>findCertifiedDetour({
  start:origin,moving:mover,obstacles,scope:{min:[-10,-10,-10],max:[20,2,20]},
  floor:3,sky:-8,clearEdge:one.clear,complete:()=>null,
  pulse:()=>{cancelled=true;throw new Error('cancelled');},
}),/cancelled/);
assert.ok(cancelled);
// Engaged-departure fixture: the moving body starts inside the mate's
// permitted connector contact. ONLY its initial +Z disengagement may use that
// narrowly scoped policy. The rest of the multi-turn route uses strict sweeps.
// This is intentionally an AABB-only *search* fixture, not a mechanical-mate
// certification; the real planner uses its continuous triangle oracle.
const sleeve: Box = {min:[-.5,-2,-.5],max:[.5,2,1]};
const wall: Box = {min:[2,-3,1],max:[4,2,5]};
const joined: Box[] = [sleeve,wall];
const installed: V3 = [0,0,0], releasedGoal: V3 = [8,0,8];
let initialExceptionUsed=false;
const checkedFirstOnly=(a:V3,b:V3): boolean => {
  const first = norm3(sub(a,installed)) < 1e-7;
  const delta=sub(b,a);
  return !joined.some((o,index)=> {
    // A connector release can clear its exact mating contact only on the
    // initial movement. After departure the identical contact is forbidden.
    if(index===0 && first && delta[2]>=2.5 && Math.abs(delta[0])<1e-8 && Math.abs(delta[1])<1e-8) {
      initialExceptionUsed=true;
      return false;
    }
    return sweptBox(shiftBox(mover,a),o,delta,-1e-6);
  });
};
const norm3=(v:V3):number=>Math.hypot(...v);
assert.equal(checkedFirstOnly(installed,releasedGoal),false,'a diagonal straight route cannot cheat the sleeve or wall');
const engaged=findCertifiedDetour({start:installed,moving:mover,obstacles:joined,
  scope:{min:[-10,-10,-10],max:[10,2,10]},floor:3,sky:-8,
  clearEdge:checkedFirstOnly,
  complete:at=>checkedFirstOnly(at,releasedGoal)?[releasedGoal]:null,
  maxExpanded:128,maxEdges:400,maxFinishChecks:64,maxMilliseconds:1000});
assert.ok(engaged,'bounded search should find a bent path after the permitted first connector release');
assert.ok(initialExceptionUsed,'connector exception must be needed for its first leg');
assert.deepEqual(engaged.waypoints.at(-1),releasedGoal);
assert.ok(engaged.waypoints.length>=4,'departure requires a multi-segment escape');
for(let i=1;i<engaged.waypoints.length;i++)
  assert.equal(checkedFirstOnly(engaged.waypoints[i-1],engaged.waypoints[i]),true,`unsafe engaged segment ${i}`);
assert.equal(checkedFirstOnly(engaged.waypoints[1],installed),false,
  'returning to the engaged pose may not reuse the initial contact exception');
console.log(JSON.stringify({passed:true, checks:14, detourWaypoints:found.waypoints,
  engagedWaypoints:engaged.waypoints, expanded:found.stats.expanded, edges:found.stats.edges}));
