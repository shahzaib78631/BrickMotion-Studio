import { describe, expect, it } from 'vitest';
import { buildLayerAt, buildTimeAt, linkBuildLayer, unlinkBuildLayer, updateBuildLayer } from '../../src/anim/buildLayer';
import { emptyAnimation, insertKeys } from '../../src/anim/keyframes';

describe('editable procedural Build layer', () => {
  it('links a generated Build without destroying or replacing existing object keys', () => {
    const authored = insertKeys(emptyAnimation(), 12, [{ model: '', target: 'brick', channel: 'rotation.y', value: 90 }]);
    const linked = linkBuildLayer(authored, '', 20);
    expect(linked.tracks).toBe(authored.tracks);
    expect(linked.endFrame).toBe(481); // frame 1 + 20s * 24fps
    expect(buildLayerAt(linked, '')).toEqual({ speed: 1, startFrame: 1 });
    expect(buildTimeAt(linked, '', 13)).toBeCloseTo(0.5);
    expect(buildTimeAt(linked, '', -50)).toBe(0);
    expect(buildTimeAt(linked, 'other', 13)).toBeNull();
    expect(authored.buildLayers).toBeUndefined();
  });
  it('supports speed/offset retiming and retains authored keys and other model layers', () => {
    const main = linkBuildLayer(emptyAnimation(), '', 10);
    const other = linkBuildLayer(main, 'wheel', 4);
    const edited = updateBuildLayer(other, '', { startFrame: 11, speed: 2 }, 10);
    expect(buildTimeAt(edited, '', 35)).toBeCloseTo(2);
    expect(buildLayerAt(edited, 'wheel')).toEqual({ startFrame: 1, speed: 1 });
    expect(unlinkBuildLayer(edited, '').buildLayers).toEqual({ wheel: { startFrame: 1, speed: 1 } });
    expect(unlinkBuildLayer(edited, '').tracks).toBe(other.tracks);
  });
  it('rejects impossible or corrupt timing rather than silently cropping', () => {
    const original = emptyAnimation();
    expect(() => linkBuildLayer(original, '', 1e6)).toThrow('20,000');
    expect(() => linkBuildLayer(original, '', -1)).toThrow('valid Build');
    expect(() => updateBuildLayer(original, '', { startFrame: 1, speed: 0 }, 10)).toThrow('between');
    expect(() => updateBuildLayer(original, '', { startFrame: -1, speed: 1 }, 10)).toThrow('scene');
  });
});
