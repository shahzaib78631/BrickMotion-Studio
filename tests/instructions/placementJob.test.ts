import { expect, test } from 'vitest';
import { placementJob } from '../../src/instructions/placementJob';
import type { Booklet, Matches } from '../../src/instructions/types';

test('placement evidence retains unknowns, repeated subbuilds and unassigned foundations', () => {
  const b: Booklet = {id:'b',textHash:'',sourceHash:'source',pages:2,inventory:[],steps:[1,2].map(page=>({
    page,number:1,picture:'picture.png',substeps:[1,2],repeat:2,
    callout:[{count:2,countFound:page===1,crop:'part.png',box:[0,0,1,1]}],
  }))};
  const matches: Matches = {matches:[{booklet:'b',page:1,step:1,index:0,element:'known',score:.9,alternatives:[]}],
    overUse:[],unused:[{element:'foundation',left:1}]};
  const job = placementJob('unit',[[b]],matches,element=>({part:element,color:4,flags:[]}),'/booklets');
  expect(job.completeModel).toBe(false);
  expect(job.models[0].steps.map(s=>s.id)).toEqual(['b:p1:s1','b:p2:s1']);
  expect(job.models[0].steps[0]).toMatchObject({repeat:2,image:'/booklets/b/picture.png',parts:[{part:'known',count:2}]});
  expect(job.models[0].steps[1].parts[0]).toMatchObject({part:null,color:null,countVerified:false,issues:['unidentified part','unverified quantity']});
  expect(job.unassignedInventory[0]).toMatchObject({part:'foundation',left:1});
});
