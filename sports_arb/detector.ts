import type { GameState, GameEvent, EventType } from './types';

export function detectEvents(prev: GameState, next: GameState): GameEvent[] {
  if (prev.gameId !== next.gameId || prev.sport !== next.sport) return [];
  const events: GameEvent[] = [];
  const now = Date.now();

  const base: Omit<GameEvent, 'eventType' | 'description'> = {
    gameId: next.gameId,
    sport: next.sport,
    prevState: prev,
    nextState: next,
    detectedAt: now,
    source: 'espn',
  };

  const prevTotal = prev.homeScore + prev.awayScore;
  const nextTotal = next.homeScore + next.awayScore;
  if (nextTotal !== prevTotal) {
    events.push({
      ...base,
      eventType: 'SCORING_PLAY',
      description: buildScoreDesc(prev, next),
    });
  }

  // NFL: possession flip without scoring = likely turnover
  if (next.sport === 'NFL' && prev.possession && next.possession &&
      prev.possession !== next.possession && nextTotal === prevTotal) {
    events.push({
      ...base,
      eventType: 'TURNOVER',
      description: `Possession changed ${prev.possession} → ${next.possession}`,
    });
  }

  return events;
}

function buildScoreDesc(prev: GameState, next: GameState): string {
  const scorer =
    next.homeScore > prev.homeScore ? next.homeTeam :
    next.awayScore > prev.awayScore ? next.awayTeam :
    'unknown';
  return `${scorer} scored: ${prev.homeScore}-${prev.awayScore} → ${next.homeScore}-${next.awayScore}`;
}
