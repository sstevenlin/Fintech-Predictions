import type { Feed } from './base';
import type { GameState } from '../types';

// NBA Stats API — typically 1-3s fresher than ESPN's CDN-cached response
const NBA_SCOREBOARD = 'https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json';

export class NbaFeed implements Feed {
  readonly name = 'nba-official';
  private timer: ReturnType<typeof setInterval> | null = null;

  async poll(): Promise<GameState[]> {
    try {
      const res = await fetch(NBA_SCOREBOARD);
      if (!res.ok) return [];
      const data = await res.json();
      return parseNbaScoreboard(data);
    } catch (err) {
      console.error('[nba] poll error:', err);
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

function parseNbaScoreboard(data: any): GameState[] {
  const games: any[] = data?.scoreboard?.games ?? [];
  return games.flatMap((game: any): GameState[] => {
    if (game.gameStatus !== 2) return []; // 2 = in progress
    return [{
      gameId: game.gameId,
      sport: 'NBA',
      homeTeam: game.homeTeam?.teamTricode ?? 'HOME',
      awayTeam: game.awayTeam?.teamTricode ?? 'AWAY',
      homeScore: game.homeTeam?.score ?? 0,
      awayScore: game.awayTeam?.score ?? 0,
      clock: game.gameClock ?? null,
      period: game.period ?? 0,
      recordedAt: new Date().toISOString(),
    }];
  });
}
