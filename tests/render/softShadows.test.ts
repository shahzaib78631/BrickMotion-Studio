import { expect, it } from 'vitest';
import * as THREE from 'three';
import { useSmoothSoftShadows } from '../../src/render/softShadows';

it('widens the directional PCF shadow filter to 16 samples', () => {
  useSmoothSoftShadows();
  useSmoothSoftShadows(); // idempotent
  const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  expect(chunk).toContain('vogelDiskSample( i, 16, phi )');
  expect(chunk.match(/vogelDiskSample\( i, 16, phi \)/g)).toHaveLength(1);
  // the 2D shadow filter no longer uses the 5-sample sum
  const pcf = chunk.slice(chunk.indexOf('float getShadow( sampler2DShadow'), chunk.indexOf('#elif defined( SHADOWMAP_TYPE_VSM )'));
  expect(pcf).not.toContain('vogelDiskSample( 0, 5, phi )');
});
