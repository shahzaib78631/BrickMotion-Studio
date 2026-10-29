/** V8 ideal machine laws. These equations describe positions, not forces.
 * Their outputs are rest-relative so adding an authored law cannot move a
 * correctly assembled model at zero input.
 *
 * Slider-crank geometry: (x-r*cos t)^2 + (offset-r*sin t)^2 = rod^2.
 * An indexer is deliberately a C1 design curve WITH DWELL, not an exact
 * Geneva pin/contact force model. Sampled cam lift is a C1 interpolation,
 * not a physical follower-contact or spring simulation.
 */
const TWOPI=2*Math.PI;
export function sliderCrankTravel(angle:number,crankRadius:number,rodLength:number,offset=0):number {
 const x=(t:number)=>crankRadius*Math.cos(t)+Math.sqrt(Math.max(0,
  rodLength*rodLength-(offset-crankRadius*Math.sin(t))**2));
 return x(angle)-x(0);
}
/** Scotch yoke has pure harmonic displacement around its rest position. */
export function scotchYokeTravel(angle:number,radius:number,phase=0):number {
 return radius*(Math.sin(angle+phase)-Math.sin(phase));
}
function frac(x:number):number{return x-Math.floor(x);}
function smoothstep(x:number):number {
 const t=Math.max(0,Math.min(1,x));return t*t*(3-2*t);
}
export function camProfileTravel(angle:number,profile:readonly number[],phase=0,lobes=1):number {
 const curve=(a:number)=>{
  const x=frac(a/TWOPI)*profile.length,i=Math.floor(x),t=x-i;
  return profile[i]+(profile[(i+1)%profile.length]-profile[i])*smoothstep(t);
 };
 return curve(phase+lobes*angle)-curve(phase);
}
/** A deliberately idealized intermittent/indexing drive. One full input turn
 * advances a single output slot. The phase may shift engagement windows.
 * This law is not an exact Geneva drive contact formulation. */
export function intermittentIndexTravel(angle:number,slots:number,activeFraction:number,phase=0):number {
 const cumulative=(a:number)=>{
  const cycle=a/TWOPI,part=frac(cycle),start=(1-activeFraction)/2;
  return Math.floor(cycle)+smoothstep((part-start)/activeFraction);
 };
 return TWOPI/slots*(cumulative(angle+phase)-cumulative(phase));
}
/** Ideal differential-drive odometry in body coordinates (increments, not a
 * global planar pose for curving trajectories; no load/slip/contact). */
export function differentialDriveTravel(leftAngle:number,rightAngle:number,
 wheelRadius:number,trackWidth:number):{forward:number;yaw:number}{
 return {forward:wheelRadius*(leftAngle+rightAngle)/2,
  yaw:wheelRadius*(rightAngle-leftAngle)/trackWidth};
}
