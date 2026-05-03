import nfl from './lookup_tables/nfl.json';
import nba from './lookup_tables/nba.json';
import mlb from './lookup_tables/mlb.json';
import type { GameEvent, FairValueResult, Sport, GameState } from './types';

interface LookupEntry {
  delta: number;
  confidence: 'high' | 'medium' | 'low';
}
type LookupTable = Record<string, LookupEntry>;

const TABLES: Partial<Record<Sport, LookupTable>> = {
  NFL: nfl as unknown as LookupTable,
  NBA: nba as unknown as LookupTable,
  MLB: mlb as unknown as LookupTable,
};

export function estimateFairValue(
  event: GameEvent,
  kalshiTicker: string,
  currentKalshiPrice: number,
): FairValueResult | null {
  const table = TABLES[event.sport];
  if (!table) return null;

  const key = buildLookupKey(event);
  const entry = table[key] ?? table[event.eventType];
  if (!entry) return null;

  // Sign convention: lookup deltas are home-team perspective.
  const scoredHome = event.nextState.homeScore > event.prevState.homeScore;
  let signedDelta = scoredHome ? entry.delta : -entry.delta;

  // Scale by Δscore: 1-pt FT shouldn't move WP like a 3-pointer. Multi-point bundles
  // also scale up (the feed sometimes batches a make + and-one into one update).
  const scoreScale = pointsScale(event.prevState, event.nextState);
  signedDelta *= scoreScale;

  // Decay near the end of the game: a bucket with 8 seconds left has near-zero impact.
  const clockScale = clockDecay(event.sport, event.nextState);
  signedDelta *= clockScale;

  // Confidence drops when the model is heavily attenuated.
  let confidence = entry.confidence;
  const totalScale = scoreScale * clockScale;
  if (totalScale < 0.4 && confidence === 'high') confidence = 'medium';
  if (totalScale < 0.15) confidence = 'low';

  const estimatedFairPrice = Math.min(99, Math.max(1,
    Math.round(currentKalshiPrice + signedDelta * 100)
  ));

  return {
    event,
    kalshiTicker,
    currentKalshiPrice,
    estimatedFairPrice,
    deltaWinProb: signedDelta,
    confidence,
  };
}

function buildLookupKey(event: GameEvent): string {
  const { sport, eventType, prevState } = event;
  const margin = Math.abs(prevState.homeScore - prevState.awayScore);

  if (sport === 'NFL' && eventType === 'SCORING_PLAY') {
    if (margin <= 7)  return 'SCORING_PLAY:close';
    if (margin <= 14) return 'SCORING_PLAY:medium';
    return 'SCORING_PLAY:blowout';
  }

  if (sport === 'NBA' && eventType === 'SCORING_PLAY') {
    return prevState.period >= 4 ? 'SCORING_PLAY:late' : 'SCORING_PLAY';
  }

  if (sport === 'MLB' && eventType === 'SCORING_PLAY') {
    const late = (prevState.period ?? 0) >= 7;
    const close = margin <= 2;
    if (late && close) return 'SCORING_PLAY:late_close';
    if (late)          return 'SCORING_PLAY';  // fall through if no :late entry
    return 'SCORING_PLAY';
  }

  return eventType;
}

// Returns a scaling factor (0–1+) for the size of the score change.
// Two-point baseline = 1.0. Free throws (1pt) at 0.4 (low information).
// Threes at 1.4. 4+ point bundles scale linearly with Δscore/2.
export function pointsScale(prev: GameState, next: GameState): number {
  const dPoints = (next.homeScore + next.awayScore) - (prev.homeScore + prev.awayScore);
  if (dPoints <= 0) return 1;
  if (dPoints === 1) return 0.4;
  if (dPoints === 2) return 1.0;
  if (dPoints === 3) return 1.4;
  return Math.min(2.0, dPoints / 2);
}

// Returns a 0..1 scale for how much late-game-ness applies.
// NBA: full strength when > 5 minutes left in Q4, decays to 0.05 at the buzzer.
// NFL: same shape, scaled to 15-min quarters.
// MLB: pass through (lookup tables already encode innings; clock not relevant).
// Returns 1 when we cannot parse the clock.
export function clockDecay(sport: Sport, state: GameState): number {
  if (sport === 'MLB') return 1;
  if (state.period < 4) return 1;  // before Q4: lookup already differentiates

  const seconds = parseClockSeconds(state.clock);
  if (seconds == null) return 1;   // unknown clock — don't penalize

  // 5+ minutes remaining → full delta. 0 → 0.05. Linear in between.
  if (seconds >= 300) return 1;
  if (seconds <= 0)   return 0.05;
  return 0.05 + (seconds / 300) * 0.95;
}

// Parses ESPN ("9:32") and NBA-official ISO 8601 ("PT04M32.00S") clocks to seconds.
export function parseClockSeconds(clock: string | null): number | null {
  if (!clock) return null;
  const iso = clock.match(/^PT(?:(\d+)M)?(?:([\d.]+)S)?$/);
  if (iso) {
    const m = Number(iso[1] ?? 0);
    const s = Number(iso[2] ?? 0);
    return m * 60 + s;
  }
  const mmss = clock.match(/^(\d+):(\d{1,2})(?:\.\d+)?$/);
  if (mmss) {
    return Number(mmss[1]) * 60 + Number(mmss[2]);
  }
  return null;
}
