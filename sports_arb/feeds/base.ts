import type { GameState } from '../types';

export interface Feed {
  readonly name: string;
  poll(): Promise<GameState[]>;
  start(intervalMs: number, onUpdate: (states: GameState[]) => void): void;
  stop(): void;
}

// Runs poll() on a setTimeout chain. On consecutive failures, applies exponential
// backoff capped at 30s. The first error logs in full; subsequent identical errors
// are summarised every 10 failures so the log doesn't drown.
export function runPollLoop(opts: {
  name: string;
  intervalMs: number;
  pollFn: () => Promise<GameState[]>;
  onUpdate: (states: GameState[]) => void;
}): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;

  const tick = async () => {
    if (stopped) return;
    let ok = false;
    let states: GameState[] = [];
    try {
      states = await opts.pollFn();
      ok = true;
      if (consecutiveFailures > 0) {
        console.log(`[${opts.name}] recovered after ${consecutiveFailures} failures`);
        consecutiveFailures = 0;
      }
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures === 1 || consecutiveFailures % 10 === 0) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${opts.name}] poll error (${consecutiveFailures}x): ${msg}`);
      }
    }

    if (ok && states.length > 0) {
      try { opts.onUpdate(states); }
      catch (err) { console.error(`[${opts.name}] onUpdate threw:`, err); }
    }

    if (!stopped) {
      const delay = backoffDelay(consecutiveFailures, opts.intervalMs);
      timer = setTimeout(tick, delay);
    }
  };

  tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}

export function backoffDelay(failures: number, baseMs: number): number {
  if (failures === 0) return baseMs;
  const exp = Math.min(failures - 1, 6); // cap at 64x base
  return Math.min(30_000, baseMs * Math.pow(2, exp));
}
