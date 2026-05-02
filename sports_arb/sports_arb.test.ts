import { describe, it, expect } from '@jest/globals';
import { detectEvents } from './detector';
import { estimateFairValue } from './fair_value';
import { evaluate } from './router';
import { ExitManager, buildPosition } from './exit_manager';
import type { GameState } from './types';

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
    expect(result!.confidence).toBe('high');
  });

  it('flips delta when away team scores', () => {
    const next = { ...nflBase, awayScore: 21 };
    const [event] = detectEvents(nflBase, next);
    const result = estimateFairValue(event, 'KXNFL-KC', 52);
    expect(result).not.toBeNull();
    expect(result!.estimatedFairPrice).toBeLessThan(52);
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
    const fv = estimateFairValue(event, 'KXNFL-KC', 69)!; // within 5c of fair
    // Override estimatedFairPrice to be close
    fv.estimatedFairPrice = fv.currentKalshiPrice + 2;
    const signal = evaluate(fv);
    expect(signal.action).toBe('pass');
  });
});

describe('exit_manager', () => {
  it('signals exit when time has passed', () => {
    const mgr = new ExitManager();
    const pos = buildPosition('KXNFL-KC', 'yes', 5, 60, 80);
    // Force hardExitAt to be in the past
    (pos as any).hardExitAt = Date.now() - 1;
    mgr.add(pos);
    expect(mgr.check('KXNFL-KC', 62)).toBe('exit');
  });

  it('signals exit when price target is hit', () => {
    const mgr = new ExitManager();
    const pos = buildPosition('KXNFL-KC', 'yes', 5, 60, 75);
    mgr.add(pos);
    expect(mgr.check('KXNFL-KC', 76)).toBe('exit');
    expect(mgr.check('KXNFL-KC', 74)).toBe('hold');
  });
});
