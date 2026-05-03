import type { OpenPosition, ClosedPosition, KalshiQuote } from './types';

const HOLD_DURATION_MS = 60_000;

let positionSeq = 0;

export class ExitManager {
  // Keyed by position id, not ticker — the same market can hold multiple
  // overlapping positions when fast-firing events trigger back-to-back signals.
  private positions: Map<string, OpenPosition> = new Map();

  add(pos: OpenPosition): void {
    this.positions.set(pos.id, pos);
  }

  remove(id: string): OpenPosition | undefined {
    const pos = this.positions.get(id);
    this.positions.delete(id);
    return pos;
  }

  get(id: string): OpenPosition | undefined {
    return this.positions.get(id);
  }

  all(): OpenPosition[] {
    return [...this.positions.values()];
  }

  byTicker(ticker: string): OpenPosition[] {
    return this.all().filter(p => p.kalshiTicker === ticker);
  }
}

// Returns 'exit' (with reason) if the position should close given the latest yes-mid.
export function shouldExit(pos: OpenPosition, currentYesMid: number, now: number = Date.now()):
  { exit: false } | { exit: true; reason: 'target' | 'timeout' } {
  if (now >= pos.hardExitAt) return { exit: true, reason: 'timeout' };
  const hitTarget = pos.side === 'yes'
    ? currentYesMid >= pos.targetYesMid
    : currentYesMid <= pos.targetYesMid;
  if (hitTarget) return { exit: true, reason: 'target' };
  return { exit: false };
}

// Compute the realistic close price assuming we cross the spread to exit.
// YES position closes at yes_bid; NO position closes at (100 - yes_ask).
export function exitFillPrice(side: 'yes' | 'no', exitQuote: KalshiQuote): number | null {
  if (side === 'yes') {
    return exitQuote.yesBid ?? exitQuote.yesMid ?? null;
  }
  // NO side: the synthetic "no_ask" against which we'll compare entry no_ask.
  const ask = exitQuote.yesAsk ?? exitQuote.yesMid;
  return ask == null ? null : 100 - ask;
}

export function realizedPnlCents(
  side: 'yes' | 'no',
  entryFillPrice: number,
  exitFillPriceValue: number,
  quantity: number,
): number {
  // Both entryFillPrice and exitFillPriceValue are denominated in the side's own
  // synthetic "buy this for X cents" currency, so direction is identical for
  // both sides: we always profit when exit > entry.
  return Math.round((exitFillPriceValue - entryFillPrice) * quantity);
}

export function buildPosition(args: {
  kalshiTicker: string;
  side: 'yes' | 'no';
  quantity: number;
  entryFillPrice: number;
  entryYesMid: number;
  entryQuote: KalshiQuote;
  targetYesMid: number;
  holdMs?: number;
}): OpenPosition {
  const enteredAt = Date.now();
  const id = `${args.kalshiTicker}#${enteredAt}-${++positionSeq}`;
  return {
    id,
    kalshiTicker: args.kalshiTicker,
    side: args.side,
    quantity: args.quantity,
    entryFillPrice: args.entryFillPrice,
    entryYesMid: args.entryYesMid,
    entryQuote: args.entryQuote,
    enteredAt,
    targetYesMid: args.targetYesMid,
    hardExitAt: enteredAt + (args.holdMs ?? HOLD_DURATION_MS),
  };
}

export { HOLD_DURATION_MS };
