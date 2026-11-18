import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { finiteFresnelShader } from '../../src/render/pathTracerNumerics';

test('installed tracer Fresnel is patched at its known numerical hazards', () => {
 const source=readFileSync('node_modules/three-gpu-pathtracer/src/shader/common/fresnel_functions.glsl.js','utf8');
 expect(source).toContain('return pow( ( 1.0 - eta ) / ( 1.0 + eta ), 2.0 );');
 expect(source.match(/pow\( 1\.0 - cosine, 5\.0 \)/g)).toHaveLength(3);
 const patched=finiteFresnelShader(source);
 expect(patched).toContain('return r * r;');
 expect(patched).not.toContain('sqrt( 1.0 - cosTheta * cosTheta )');
 expect(patched).not.toContain('pow( 1.0 - cosine, 5.0 )');
 expect(patched).toContain('float sinThetaISq = max( 0.0, 1.0 - cosThetaI * cosThetaI );');
 expect(finiteFresnelShader(patched)).toBe(patched);
});
test('exit-interface reflectance is finite and reciprocal at normal incidence', () => {
 const f0=(eta:number)=>{const r=(1-eta)/(1+eta);return r*r;};
 expect(f0(1.52)).toBeCloseTo(.042579995,8);
 expect(f0(1.52)).toBeCloseTo(f0(1/1.52),14);
 expect(f0(1)).toBe(0);
});
