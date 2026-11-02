import { describe, expect, it } from 'vitest';
import { orbitDegreesOf, orbitTurn, roundDegrees } from '../../src/anim/cameraTrack/orbit';

/** what the editor writes, read back the way the sampler reads it */
const roundTrip = (degrees: number) => {
  const turn = orbitTurn(20, degrees);
  return roundDegrees(orbitDegreesOf(20, turn.azimuth, turn));
};

describe('total orbit of a camera move', () => {
  it('expresses any total the user asks for', () => {
    expect([90, 180, 270, -90, -270, 450, 0].map(roundTrip)).toEqual([90, 180, 270, -90, -270, 450, 0]);
  });

  it('takes three quarters the long way round, not as a quarter the short way', () => {
    const turn = orbitTurn(20, 270);
    expect(turn.orbit).toBe('cw');
    expect(turn.extraTurns).toBe(0);
    expect(turn.azimuth).toBeCloseTo(290, 6);
    // a negative total turns the other way, and the same short end azimuth means the other side
    const back = orbitTurn(20, -270);
    expect(back.orbit).toBe('ccw');
    expect(back.azimuth).toBeCloseTo(-250, 6);
  });

  it('carries whole turns and leaves a standing still move alone', () => {
    const full = orbitTurn(20, 450);
    expect([full.orbit, full.extraTurns]).toEqual(['cw', 1]);
    expect(full.azimuth).toBeCloseTo(110, 6);
    expect(orbitTurn(20, 0)).toEqual({ azimuth: 20, orbit: 'shortest', extraTurns: 0 });
  });
});
