import type { Feed } from './base';
import { runPollLoop } from './base';
import type { GameState } from '../types';

// NBA Stats API — typically 1-3s fresher than ESPN's CDN-cached response
const NBA_SCOREBOARD = 'https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json';

export class NbaFeed implements Feed {
  readonly name = 'nba-official';
  private handle: { stop: () => void } | null = null;

  async poll(): Promise<GameState[]> {
    const res = await fetch(NBA_SCOREBOARD);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return parseNbaScoreboard(data);
  }

  start(intervalMs: number, onUpdate: (states: GameState[]) => void): void {
    this.handle = runPollLoop({
      name: this.name,
      intervalMs,
      pollFn: () => this.poll(),
      onUpdate,
    });
  }

  stop(): void {
    this.handle?.stop();
    this.handle = null;
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
