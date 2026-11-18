import { expect, test } from 'vitest';
import { progressReporter, type PlanningProgress } from '../../src/anim/planning';

test('routing bursts have bounded UI traffic; phase changes and completion remain immediate', () => {
 let time=0;const sent:PlanningProgress[]=[];
 const report=progressReporter(p=>sent.push(p),()=>time);
 for(let i=0;i<1000;i++){time=i;report({phase:'routing',completed:i,total:1001});}
 expect(sent).toHaveLength(10);
 report({phase:'validation',completed:0,total:1001});
 expect(sent.at(-1)?.phase).toBe('validation');
 report({phase:'validation',completed:1001,total:1001});
 expect(sent.at(-1)?.completed).toBe(1001);
});
