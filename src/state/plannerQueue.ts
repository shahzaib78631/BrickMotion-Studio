import type { PlannerReply, PlanningProgress } from '../anim/planning';

/** Deliberately small interface, also implemented by the offline test worker. */
export interface PlannerPort<T> {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<PlannerReply<T>>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}

type Job<Q, R> = {
  request: Q;
  resolve(result: R): void;
  reject(error: Error): void;
  progress?: (value: PlanningProgress) => void;
};
const abandoned = () => Object.assign(new Error('Animation request superseded.'), { name: 'AbortError' });
const asError = (e: unknown) => e instanceof Error ? e : new Error(String(e));

/** Every submitted job must resolve, reject, time out, or be explicitly replaced. */
export class PlannerQueue<Q extends object, R> {
  private worker: PlannerPort<R> | null = null;
  private active: { id: number; job: Job<Q, R> } | null = null;
  private queue: Job<Q, R>[] = [];
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private totalTimer: ReturnType<typeof setTimeout> | undefined;
  private lastProgress: PlanningProgress | null = null;

  constructor(
    private createWorker: () => PlannerPort<R>,
    private replace = true,
    // A stalled plan is caught by the idle limit (no progress for 30 s). The total
    // limit only bounds big models that keep making progress: a whole train set
    // with every submodel built aside plans for a few minutes.
    private limits = { idleMs: 30_000, totalMs: 600_000 },
  ) {}

  run(request: Q, progress?: (value: PlanningProgress) => void): Promise<R> {
    return new Promise((resolve, reject) => {
      if (this.replace) {
        for (const old of this.queue) old.reject(abandoned());
        this.queue = [];
        if (this.active) {
          const old = this.active;
          this.active = null;
          this.clearTimers();
          this.destroyWorker();
          old.job.reject(abandoned());
        }
      }
      this.queue.push({ request, progress, resolve, reject });
      this.pump();
    });
  }

  private clearTimers(): void {
    clearTimeout(this.idleTimer);
    clearTimeout(this.totalTimer);
    this.idleTimer = this.totalTimer = undefined;
  }

  private destroyWorker(): void {
    const w = this.worker;
    this.worker = null;
    if (w) {
      w.onmessage = w.onerror = w.onmessageerror = null;
      try { w.terminate(); } catch { /* Promise settlement must not depend on teardown. */ }
    }
  }

  private fail(error: unknown): void {
    const current = this.active;
    this.active = null;
    this.clearTimers();
    this.destroyWorker();
    current?.job.reject(asError(error));
    this.pump();
  }

  private watchIdle(): void {
    clearTimeout(this.idleTimer);
    const id = this.active!.id;
    this.idleTimer = setTimeout(() => {
      if (this.active?.id === id) this.timeout('stopped responding');
    }, this.limits.idleMs);
  }

  private timeout(reason: string): void {
    const at = this.lastProgress;
    const detail = at ? ` Last stage: ${at.phase}, ${at.completed}/${at.total}${at.item ? `, item ${at.item}` : ''}.` : '';
    this.fail(new Error(`Animation planning ${reason}.${detail} The worker was stopped; the model is still editable. Retry planning or open the affected submodel to inspect it.`));
  }

  private pump(): void {
    if (this.active || !this.queue.length) return;
    const id = this.nextId++;
    this.active = { id, job: this.queue.shift()! };
    this.lastProgress = null;
    try {
      if (!this.worker) {
        const worker = this.createWorker();
        this.worker = worker;
        worker.onmessage = ({ data }) => {
          if (worker !== this.worker || !this.active || data?.id !== this.active.id) return;
          if ('progress' in data) {
            this.lastProgress = data.progress;
            this.watchIdle();
            // A UI observer must not interrupt worker lifecycle handling.
            try { this.active.job.progress?.(data.progress); } catch { /* observer only */ }
            return;
          }
          if (data.ok === false) { this.fail(new Error(data.error)); return; }
          if (data.ok !== true || !('result' in data)) {
            this.fail(new Error('Invalid animation worker response. Reload the app after rebuilding.'));
            return;
          }
          const done = this.active;
          this.active = null;
          this.clearTimers();
          done.job.resolve(data.result);
          this.pump();
        };
        worker.onerror = (event) => {
          if (worker !== this.worker) return;
          const error = event.error instanceof Error ? event.error : null;
          const message = event.message?.trim() || error?.message || 'Animation worker crashed without an error message.';
          const location = event.filename ? ` Source: ${event.filename}${event.lineno ? `:${event.lineno}${event.colno ? `:${event.colno}` : ''}` : ''}.` : '';
          const at = this.lastProgress;
          const stage = at ? ` Last stage: ${at.phase}, ${at.completed}/${at.total}${at.item ? `, item ${at.item}` : ''}.` : ' No planning progress was received; the worker may have failed during startup.';
          const failure = new Error(`${message}${location}${stage}`);
          if (error?.stack) failure.stack = `${failure.name}: ${failure.message}\nWorker stack:\n${error.stack}`;
          // Settle first: a diagnostic observer must never strand the request.
          this.fail(failure);
        };
        worker.onmessageerror = () => {
          if (worker === this.worker) this.fail(new Error('Could not read the animation worker result.'));
        };
      }
      this.watchIdle();
      this.totalTimer = setTimeout(() => {
        if (this.active?.id === id) this.timeout('exceeded its processing limit');
      }, this.limits.totalMs);
      this.worker.postMessage({ ...this.active.job.request, id });
    } catch (error) {
      // Includes worker construction, CSP failures and structured-clone errors.
      // Do NOT silently move expensive planning onto the browser's main thread.
      this.fail(error);
    }
  }
}
