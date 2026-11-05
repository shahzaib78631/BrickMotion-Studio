import { beforeEach, describe, expect, it } from 'vitest';
import { useStudio } from '../../src/state/store';

describe('Build / Animate workspace', () => {
  beforeEach(() => useStudio.setState({ workspace: 'build', mode: 'edit', timelineEditor: 'build' }));

  it('opens in Build mode', () => {
    expect(useStudio.getState().workspace).toBe('build');
  });

  it('going back to Build leaves the keyframe editor', () => {
    const s = useStudio.getState();
    s.setWorkspace('animate');
    s.setTimelineEditor('timeline');
    useStudio.getState().setWorkspace('build');
    expect(useStudio.getState()).toMatchObject({ workspace: 'build', timelineEditor: 'build', mode: 'edit' });
  });

  it('a preview switches to Animate, since only Animate has an animation', () => {
    useStudio.getState().setMode('preview');
    expect(useStudio.getState()).toMatchObject({ workspace: 'animate', mode: 'preview' });
  });
});
