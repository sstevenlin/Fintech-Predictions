import type { OpenPosition } from './types';

const HOLD_DURATION_MS = 60_000;

export class ExitManager {
  private positions: Map<string, OpenPosition> = new Map();

  add(pos: OpenPosition): void {
    this.positions.set(pos.kalshiTicker, pos);
  }

  check(ticker: string, currentPrice: number): 'exit' | 'hold' {
    const pos = this.positions.get(ticker);
    if (!pos) return 'hold';

    const timedOut = Date.now() >= pos.hardExitAt;
    const hitTarget = pos.side === 'yes'
      ? currentPrice >= pos.targetExitPrice
      : currentPrice <= pos.targetExitPrice;

    return timedOut || hitTarget ? 'exit' : 'hold';
  }

  remove(ticker: string): OpenPosition | undefined {
    const pos = this.positions.get(ticker);
    this.positions.delete(ticker);
    return pos;
  }

  all(): OpenPosition[] {
    return [...this.positions.values()];
  }
}

export function buildPosition(
  ticker: string,
  side: 'yes' | 'no',
  quantity: number,
  entryPrice: number,
  targetExitPrice: number,
): OpenPosition {
  return {
    kalshiTicker: ticker,
    side,
    quantity,
    entryPrice,
    enteredAt: Date.now(),
    targetExitPrice,
    hardExitAt: Date.now() + HOLD_DURATION_MS,
  };
}
