import type { Feed } from './base';
import { runPollLoop } from './base';
import type { GameState } from '../types';

// NFL Gamecenter — live game data, updates ~1-3s post-play
const NFL_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

export class NflFeed implements Feed {
  readonly name = 'nfl-official';
  private handle: { stop: () => void } | null = null;

  async poll(): Promise<GameState[]> {
    const res = await fetch(NFL_SCOREBOARD);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return parseNflScoreboard(data);
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
