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

export interface OpenPosition {
  kalshiTicker: string;
  side: 'yes' | 'no';
  quantity: number;
  entryPrice: number;
  enteredAt: number;
  targetExitPrice: number;
  hardExitAt: number; // epoch ms
}
