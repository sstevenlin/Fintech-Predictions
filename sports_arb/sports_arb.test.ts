import { describe, it, expect } from '@jest/globals';
import { detectEvents } from './detector';
import { estimateFairValue, pointsScale, clockDecay, parseClockSeconds } from './fair_value';
import { evaluate, entryFillPrice } from './router';
import {
  ExitManager,
  buildPosition,
  shouldExit,
  exitFillPrice,
  realizedPnlCents,
} from './exit_manager';
import type { GameState, KalshiQuote } from './types';

const nflBase: GameState = {
  gameId: 'game-1',
  sport: 'NFL',
  homeTeam: 'KC',
  awayTeam: 'BUF',
  homeScore: 14,
  awayScore: 14,
  clock: '2:00',
  period: 4,
  possession: 'KC',
  recordedAt: new Date().toISOString(),
};

const tightQuote: KalshiQuote = { yesBid: 49, yesAsk: 51, yesMid: 50, last: 50 };

describe('detector', () => {
  it('detects a scoring play when score changes', () => {
    const next = { ...nflBase, homeScore: 21 };
    const events = detectEvents(nflBase, next);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('SCORING_PLAY');
  });

  it('detects a turnover when possession flips without scoring', () => {
    const next = { ...nflBase, possession: 'BUF' };
    const events = detectEvents(nflBase, next);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('TURNOVER');
  });

  it('returns no events when nothing changed', () => {
    expect(detectEvents(nflBase, { ...nflBase })).toHaveLength(0);
  });
});

describe('fair_value', () => {
  it('returns a fair value estimate for a close NFL scoring play', () => {
    const next = { ...nflBase, homeScore: 21 };
    const [event] = detectEvents(nflBase, next);
    const result = estimateFairValue(event, 'KXNFL-KC', 52);
    expect(result).not.toBeNull();
    expect(result!.estimatedFairPrice).toBeGreaterThan(52);
  });

  it('flips delta when away team scores', () => {
    const next = { ...nflBase, awayScore: 21 };
    const [event] = detectEvents(nflBase, next);
    const result = estimateFairValue(event, 'KXNFL-KC', 52);
    expect(result).not.toBeNull();
    expect(result!.estimatedFairPrice).toBeLessThan(52);
  });

  it('flips delta again when YES contract pays on the away team', () => {
    const next = { ...nflBase, homeScore: 21 };
    const [event] = detectEvents(nflBase, next);
    const homeYes = estimateFairValue(event, 't', 52, 'per_game', true)!;
    const awayYes = estimateFairValue(event, 't', 52, 'per_game', false)!;
    expect(homeYes.deltaWinProb).toBeGreaterThan(0);
    expect(awayYes.deltaWinProb).toBeLessThan(0);
  });

  it('halves the delta on a series-winner contract', () => {
    const next = { ...nflBase, sport: 'NBA' as const, period: 4, clock: '6:00', homeScore: 100, awayScore: 96 };
    const prev = { ...next, homeScore: 98 };
    const [event] = detectEvents(prev, next);
    const perGame = estimateFairValue(event, 't', 50, 'per_game', true)!;
    const series  = estimateFairValue(event, 't', 50, 'series_winner', true)!;
    // Series should produce roughly half the move of per_game (with rounding tolerance).
    expect(Math.abs(series.deltaWinProb)).toBeLessThan(Math.abs(perGame.deltaWinProb));
    expect(Math.abs(series.deltaWinProb)).toBeCloseTo(perGame.deltaWinProb / 2, 1);
  });

  it('attenuates the delta in late-clock NBA garbage time', () => {
    const prev: GameState = { ...nflBase, sport: 'NBA', period: 4, clock: '0:08', homeScore: 100, awayScore: 80 };
    const next: GameState = { ...prev, awayScore: 82 };
    const [event] = detectEvents(prev, next);
    const result = estimateFairValue(event, 'KXNBA-X', 90);
    expect(result).not.toBeNull();
    // 8 seconds left should leave a tiny fair-value move, not a full +18pp.
    expect(Math.abs(result!.estimatedFairPrice - 90)).toBeLessThan(5);
  });

  it('scales delta down for free throws (1-point change)', () => {
    const prev: GameState = { ...nflBase, sport: 'NBA', period: 4, clock: '6:00', homeScore: 100, awayScore: 80 };
    const oneFt: GameState = { ...prev, homeScore: 101 };
    const twoPt: GameState = { ...prev, homeScore: 102 };
    const ftDelta = estimateFairValue(detectEvents(prev, oneFt)[0], 't', 50)!.deltaWinProb;
    const twoDelta = estimateFairValue(detectEvents(prev, twoPt)[0], 't', 50)!.deltaWinProb;
    expect(Math.abs(ftDelta)).toBeLessThan(Math.abs(twoDelta));
  });
});

describe('points and clock helpers', () => {
  it('points scale: 1pt < 2pt < 3pt', () => {
    const a: GameState = { ...nflBase, sport: 'NBA', homeScore: 100, awayScore: 95 };
    expect(pointsScale(a, { ...a, homeScore: 101 })).toBeLessThan(pointsScale(a, { ...a, homeScore: 102 }));
    expect(pointsScale(a, { ...a, homeScore: 102 })).toBeLessThan(pointsScale(a, { ...a, homeScore: 103 }));
  });

  it('parses both ESPN and NBA-official clocks', () => {
    expect(parseClockSeconds('9:32')).toBe(572);
    expect(parseClockSeconds('PT04M32.00S')).toBe(272);
    expect(parseClockSeconds('PT00M08.80S')).toBeCloseTo(8.8, 1);
    expect(parseClockSeconds(null)).toBeNull();
  });

  it('clock decay: full early in Q4, attenuated near zero', () => {
    const early: GameState = { ...nflBase, sport: 'NBA', period: 4, clock: '6:00' };
    const late:  GameState = { ...nflBase, sport: 'NBA', period: 4, clock: '0:08' };
    expect(clockDecay('NBA', early)).toBe(1);
    expect(clockDecay('NBA', late)).toBeLessThan(0.2);
  });
});

describe('router', () => {
  it('emits buy_yes when fair > market by enough', () => {
    const next = { ...nflBase, homeScore: 21 };
    const [event] = detectEvents(nflBase, next);
    const fv = estimateFairValue(event, 'KXNFL-KC', 40)!;
    const signal = evaluate(fv);
    expect(signal.action).toBe('buy_yes');
  });

  it('passes when edge is below threshold', () => {
    const next = { ...nflBase, homeScore: 21 };
    const [event] = detectEvents(nflBase, next);
    const fv = estimateFairValue(event, 'KXNFL-KC', 69)!;
    fv.estimatedFairPrice = fv.currentKalshiPrice + 2;
    const signal = evaluate(fv);
    expect(signal.action).toBe('pass');
  });

  it('entryFillPrice models cross-the-spread cost', () => {
    expect(entryFillPrice('yes', tightQuote)).toBe(51);  // pay the ask
    expect(entryFillPrice('no',  tightQuote)).toBe(51);  // pay 100 - yes_bid
  });
});

describe('exit_manager', () => {
  function mkPos(opts: Partial<Parameters<typeof buildPosition>[0]> = {}) {
    return buildPosition({
      kalshiTicker: 'KXNFL-KC',
      side: 'yes',
      quantity: 5,
      entryFillPrice: 51,
      entryYesMid: 50,
      entryQuote: tightQuote,
      targetYesMid: 70,
      ...opts,
    });
  }

  it('keeps multiple positions on the same ticker', () => {
    const mgr = new ExitManager();
    const a = mkPos();
    const b = mkPos();
    mgr.add(a); mgr.add(b);
    expect(mgr.all()).toHaveLength(2);
    expect(mgr.byTicker('KXNFL-KC')).toHaveLength(2);
    expect(a.id).not.toBe(b.id);
  });

  it('signals exit when time has passed', () => {
    const pos = mkPos();
    (pos as any).hardExitAt = Date.now() - 1;
    const dec = shouldExit(pos, 50);
    expect(dec.exit).toBe(true);
    if (dec.exit) expect(dec.reason).toBe('timeout');
  });

  it('signals exit when YES price target is hit', () => {
    const pos = mkPos({ targetYesMid: 75 });
    expect(shouldExit(pos, 76).exit).toBe(true);
    expect(shouldExit(pos, 74).exit).toBe(false);
  });

  it('exit fill prices model spread on the way out', () => {
    const exitQ: KalshiQuote = { yesBid: 70, yesAsk: 72, yesMid: 71, last: 71 };
    expect(exitFillPrice('yes', exitQ)).toBe(70);
    expect(exitFillPrice('no',  exitQ)).toBe(28); // 100 - yes_ask
  });

  it('realized pnl is symmetric in yes-side semantics', () => {
    expect(realizedPnlCents('yes', 51, 70, 5)).toBe((70 - 51) * 5);
    expect(realizedPnlCents('no',  51, 28, 5)).toBe((28 - 51) * 5);
  });
});
