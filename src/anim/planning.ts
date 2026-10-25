/** Lightweight worker protocol: no renderer or part-library imports. */
export type PlanningProgress = {
  phase: 'preparing' | 'routing' | 'camera' | 'connections' | 'disassembly' | 'validation';
  completed: number;
  total: number;
  item?: string;
};

export type PlannerReply<T> =
  | { id: number; progress: PlanningProgress }
  | { id: number; ok: true; result: T }
  | { id: number; ok: false; error: string };

export function planningLabel(p: PlanningProgress | null): string {
  if (!p || p.phase === 'preparing') return 'Preparing assembly dependencies...';
  if (p.phase === 'connections') return 'Discovering connections and work areas...';
  if (p.phase === 'disassembly') return `Searching assembly order ${p.completed} / ${p.total}${p.item ? ` (${p.item})` : ''}`;
  if (p.phase === 'validation') return `Replaying construction ${p.completed} / ${p.total}`;
  if (p.phase === 'camera') return 'Preparing camera and playback...';
  return `Checking assembly paths: ${p.completed} / ${p.total}${p.item ? ` (${p.item})` : ''}`;
}
