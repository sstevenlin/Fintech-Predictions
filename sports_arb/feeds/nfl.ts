import type { Feed } from './base';
import type { GameState } from '../types';

// NFL Gamecenter — live game data, updates ~1-3s post-play
const NFL_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

export class NflFeed implements Feed {
  readonly name = 'nfl-official';
  private timer: ReturnType<typeof setInterval> | null = null;

  async poll(): Promise<GameState[]> {
    try {
      const res = await fetch(NFL_SCOREBOARD);
      if (!res.ok) return [];
      const data = await res.json();
      return parseNflScoreboard(data);
    } catch (err) {
      console.error('[nfl] poll error:', err);
      return [];
    }
  }

  start(intervalMs: number, onUpdate: (states: GameState[]) => void): void {
    this.timer = setInterval(async () => {
      const states = await this.poll();
      if (states.length > 0) onUpdate(states);
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function parseNflScoreboard(data: any): GameState[] {
  const events: any[] = data?.events ?? [];
  return events.flatMap((event: any): GameState[] => {
    const comp = event.competitions?.[0];
    if (!comp?.status?.type?.inProgress) return [];

    const home = comp.competitors?.find((c: any) => c.homeAway === 'home');
    const away = comp.competitors?.find((c: any) => c.homeAway === 'away');
    if (!home || !away) return [];

    const situation = comp.situation;
    return [{
      gameId: event.id,
      sport: 'NFL',
      homeTeam: home.team?.abbreviation ?? 'HOME',
      awayTeam: away.team?.abbreviation ?? 'AWAY',
      homeScore: parseInt(home.score ?? '0', 10),
      awayScore: parseInt(away.score ?? '0', 10),
      clock: comp.status?.displayClock ?? null,
      period: comp.status?.period ?? 0,
      possession: situation?.possession,
      down: situation?.down,
      yardsToGo: situation?.distance,
      recordedAt: new Date().toISOString(),
    }];
  });
}
