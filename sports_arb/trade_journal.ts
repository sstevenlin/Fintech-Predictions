/**
 * Append-only JSON-lines journal of paper-trade activity.
 *
 * One file per pipeline run, written next to the human-readable log. Each line
 * is a self-contained record so the journal can be replayed offline to compute
 * P&L, hit rates, and slippage statistics without re-running the pipeline.
 *
 * Record kinds:
 *   - event: a detected GameEvent
 *   - signal: router decision (buy_yes / buy_no / pass)
 *   - open:   position entered (paper)
 *   - exit:   position closed (paper, with realized P&L)
 *   - skip:   trade considered but not taken (no quote, post-slippage edge gone, etc.)
 */
import { mkdirSync, createWriteStream, WriteStream } from 'fs';
import { dirname, join } from 'path';
import type { GameEvent, FairValueResult, TradeSignal, OpenPosition, ClosedPosition } from './types';

let stream: WriteStream | null = null;
let journalPath: string | null = null;

export function attachTradeJournal(label: string, dir = 'logs'): string {
  if (stream && journalPath) return journalPath;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${label}-${ts}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  stream = createWriteStream(file, { flags: 'a' });
  journalPath = file;
  return file;
}

function write(record: object): void {
  if (!stream) return;
  stream.write(JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
}

export function recordEvent(event: GameEvent): void {
  write({
    kind: 'event',
    sport: event.sport,
    gameId: event.gameId,
    eventType: event.eventType,
    description: event.description,
    detectedAt: event.detectedAt,
    source: event.source,
    homeScore: event.nextState.homeScore,
    awayScore: event.nextState.awayScore,
    period: event.nextState.period,
    clock: event.nextState.clock,
  });
}

export function recordSignal(signal: TradeSignal, fv: FairValueResult): void {
  write({
    kind: 'signal',
    action: signal.action,
    reason: signal.reason,
    ticker: fv.kalshiTicker,
    currentYesMid: fv.currentKalshiPrice,
    estimatedFair: fv.estimatedFairPrice,
    deltaWinProb: fv.deltaWinProb,
    confidence: fv.confidence,
  });
}

export function recordSkip(ticker: string, reason: string, extra: Record<string, unknown> = {}): void {
  write({ kind: 'skip', ticker, reason, ...extra });
}

export function recordOpen(pos: OpenPosition): void {
  write({
    kind: 'open',
    id: pos.id,
    ticker: pos.kalshiTicker,
    side: pos.side,
    quantity: pos.quantity,
    entryFillPrice: pos.entryFillPrice,
    entryYesMid: pos.entryYesMid,
    entryQuote: pos.entryQuote,
    targetYesMid: pos.targetYesMid,
    enteredAt: pos.enteredAt,
    hardExitAt: pos.hardExitAt,
  });
}

export function recordExit(closed: ClosedPosition): void {
  write({
    kind: 'exit',
    id: closed.position.id,
    ticker: closed.position.kalshiTicker,
    side: closed.position.side,
    reason: closed.reason,
    enteredAt: closed.position.enteredAt,
    exitedAt: closed.exitedAt,
    holdMs: closed.exitedAt - closed.position.enteredAt,
    entryFillPrice: closed.position.entryFillPrice,
    exitFillPrice: closed.exitFillPrice,
    entryYesMid: closed.position.entryYesMid,
    exitYesMid: closed.exitYesMid,
    exitQuote: closed.exitQuote,
    quantity: closed.position.quantity,
    pnlCents: closed.pnlCents,
  });
}

export function journalFile(): string | null {
  return journalPath;
}
