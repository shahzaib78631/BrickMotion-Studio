import { describe, expect, it } from 'vitest';
import { useStudio } from '../../src/state/store';

describe('camera selection', () => {
  it('selecting a camera key keeps it until pieces are selected', () => {
    useStudio.getState().selectCamera({ kind: 'key', clock: 'build', id: 'k1' });
    expect(useStudio.getState().cameraSelection).toEqual({ kind: 'key', clock: 'build', id: 'k1' });
    useStudio.getState().select([]);
    expect(useStudio.getState().cameraSelection).not.toBeNull();
    useStudio.getState().select(['piece-1']);
    expect(useStudio.getState().cameraSelection).toBeNull();
  });
  it('can be cleared', () => {
    useStudio.getState().selectCamera({ kind: 'transition', clock: 'timeline', id: 'k2' });
    useStudio.getState().selectCamera(null);
    expect(useStudio.getState().cameraSelection).toBeNull();
  });
});

describe('several camera keys', () => {
  it('selectedKeyIds lists every chosen key of a clock (one key when only one is chosen)', async () => {
    const { selectedKeyIds } = await import('../../src/state/store');
    expect(selectedKeyIds({ kind: 'key', clock: 'build', id: 'a' }, 'build')).toEqual(['a']);
    expect(selectedKeyIds({ kind: 'key', clock: 'build', id: 'b', ids: ['a', 'b'] }, 'build')).toEqual(['a', 'b']);
    expect(selectedKeyIds({ kind: 'key', clock: 'build', id: 'b', ids: ['a', 'b'] }, 'timeline')).toEqual([]);
    expect(selectedKeyIds({ kind: 'transition', clock: 'build', id: 'a' }, 'build')).toEqual([]);
    expect(selectedKeyIds(null, 'build')).toEqual([]);
  });
});
