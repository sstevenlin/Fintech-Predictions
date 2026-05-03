export type Sport = 'NFL' | 'NBA' | 'MLB' | 'SOCCER' | 'TENNIS';

export type EventType =
  | 'SCORING_PLAY'
  | 'TURNOVER'
  | 'INJURY'
  | 'EJECTION'
  | 'PITCHING_CHANGE'
  | 'WEATHER_DELAY';

export interface GameState {
  gameId: string;
  sport: Sport;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  clock: string | null;
  period: number;
  possession?: string;
  // NFL
  down?: number;
  yardsToGo?: number;
  // MLB
  outs?: number;
  basesOccupied?: number; // bitmask: 0b001=1st, 0b010=2nd, 0b100=3rd
  recordedAt: string; // ISO-8601 from feed
}

export interface GameEvent {
  gameId: string;
  sport: Sport;
  eventType: EventType;
  description: string;
  prevState: GameState;
  nextState: GameState;
  detectedAt: number; // Date.now() ms
  source: string;
}

export interface FairValueResult {
  event: GameEvent;
  kalshiTicker: string;
  currentKalshiPrice: number;  // cents 0-100
  estimatedFairPrice: number;  // cents post-event
  deltaWinProb: number;        // signed, -1 to +1; positive = home team improves
  confidence: 'high' | 'medium' | 'low';
}

export interface TradeSignal {
  fairValue: FairValueResult;
  action: 'buy_yes' | 'buy_no' | 'pass';
  reason: string;
}

export interface KalshiQuote {
  yesBid: number | null;
  yesAsk: number | null;
  yesMid: number | null;
  last: number | null;
}

export interface OpenPosition {
  id: string;
  kalshiTicker: string;
  side: 'yes' | 'no';
  quantity: number;
  // Fill price actually paid (cross-the-spread): yes_ask for buy_yes, (100-yes_bid) for buy_no.
  // entryYesMid is preserved for the model's exit-target reference.
  entryFillPrice: number;
  entryYesMid: number;
  entryQuote: KalshiQuote;
  enteredAt: number;
  targetYesMid: number;   // exit triggers when yes-mid crosses this
  hardExitAt: number;     // epoch ms
}

export interface ClosedPosition {
  position: OpenPosition;
  exitedAt: number;
  exitFillPrice: number;       // realistic (cross-spread) sell price for the held side
  exitYesMid: number;
  exitQuote: KalshiQuote;
  pnlCents: number;            // (exitFill - entryFill) * qty for yes-side semantics
  reason: 'target' | 'timeout';
}
