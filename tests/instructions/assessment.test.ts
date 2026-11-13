import { expect, test } from 'vitest';
import { assessExtraction, matchForStep } from '../../src/instructions/assessment';
import { orderBooklets } from '../../src/instructions/booklets';
import type { Booklet, Matches } from '../../src/instructions/types';

const booklet = (id = 'b'): Booklet => ({id, pages: 2, textHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', rasterPages: [1,2],
  steps: [1,2].map(page => ({page,number:1,picture:'page.png',callout:[],substeps:[]})), inventory:[]});

test('different raster booklets with identical counts and no text are retained', () => {
  expect(orderBooklets([booklet('boat'),booklet('farm')]).booklets).toHaveLength(2);
});

test('new extraction hashes distinguish different art with identical text', () => {
  const a = {...booklet('a'), rasterPages: [], textHash: 'same', sourceHash: 'a', visualHash: 'art-a'};
  const b = {...a,id:'b',sourceHash:'b',visualHash:'art-b'};
  expect(orderBooklets([a,b]).booklets).toHaveLength(2);
  expect(orderBooklets([a,{...b,visualHash:'art-a'}]).booklets).toHaveLength(1);
});

test('restarted numbers match on page and ambiguous legacy matches are rejected', () => {
  const matches: Matches = {matches:[1,2].map(page=>({booklet:'b',step:1,page,index:0,element:`E${page}`,score:1,alternatives:[]})),overUse:[],unused:[]};
  expect(matchForStep(matches,'b',2,1,0)?.element).toBe('E2');
  matches.matches.forEach(m=>delete m.page);
  expect(matchForStep(matches,'b',2,1,0)).toBeUndefined();
  matches.matches.pop();
  expect(matchForStep(matches,'b',2,1,0)?.element).toBe('E1');
});

test('extraction assessment preserves uncertainty and never certifies a model', () => {
  const b = booklet(); b.steps[1].picture = null;
  b.diagnostics = [{page:1,code:'inferred-step',message:'Review inferred number'}];
  b.unparsedPages = [3];
  const result = assessExtraction([b]);
  expect(result.completeModel).toBe(false);
  expect(result.issues.map(i=>i.code)).toEqual(['inferred-step','missing-picture','step-sequence']);
  expect(result.unparsedPages).toEqual([{booklet:'b',page:3}]);
});
