/**
 * The planner's output version. Bump it whenever a change to planning can change the animation
 * for a plan that has not changed — a new way-in candidate, a different route, a retimed flight.
 *
 * It is stamped into saved projects and into the browser's timeline cache, so an animation
 * planned by an older planner is planned again instead of being replayed from the file. Without
 * it, a fix to how pieces come in is invisible in every project that was saved before it.
 */
export const PLANNER_VERSION = 8;
