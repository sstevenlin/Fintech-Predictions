import nfl from './lookup_tables/nfl.json';
import nba from './lookup_tables/nba.json';
import mlb from './lookup_tables/mlb.json';
import type { GameEvent, FairValueResult, Sport } from './types';

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

  // Flip delta sign when away team scored (all tables express delta for home team)
  const scoredHome = event.nextState.homeScore > event.prevState.homeScore;
  const signedDelta = scoredHome ? entry.delta : -entry.delta;

  const estimatedFairPrice = Math.min(99, Math.max(1,
    Math.round(currentKalshiPrice + signedDelta * 100)
  ));

  return {
    event,
    kalshiTicker,
    currentKalshiPrice,
    estimatedFairPrice,
    deltaWinProb: signedDelta,
    confidence: entry.confidence,
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
    if (late)          return 'SCORING_PLAY:late';
    return 'SCORING_PLAY';
  }

  return eventType;
}
