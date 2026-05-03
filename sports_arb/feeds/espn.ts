import type { Feed } from './base';
import { runPollLoop } from './base';
import type { GameState, Sport } from '../types';

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

const SPORT_PATHS: Record<string, string> = {
  NFL: 'football/nfl',
  NBA: 'basketball/nba',
  MLB: 'baseball/mlb',
};

export class EspnFeed implements Feed {
  readonly name = 'espn';
  private handle: { stop: () => void } | null = null;
  private lastFreshAt: Record<string, number> = {};

  async poll(): Promise<GameState[]> {
    const results: GameState[] = [];
    let anyOk = false;
    let firstErr: unknown = null;
    for (const [sport, path] of Object.entries(SPORT_PATHS)) {
      try {
        const res = await fetch(`${ESPN_BASE}/${path}/scoreboard`, {
          headers: { 'User-Agent': process.env.ESPN_USER_AGENT ?? 'fintech-predictions/0.1' },
        });
        if (!res.ok) { firstErr = firstErr ?? new Error(`${sport} HTTP ${res.status}`); continue; }
        anyOk = true;
        const data = await res.json();
        const states = parseScoreboard(data, sport as Sport);
        for (const state of states) {
          const ts = new Date(state.recordedAt).getTime();
          const prev = this.lastFreshAt[state.gameId] ?? 0;
          if (ts >= prev) {
            this.lastFreshAt[state.gameId] = ts;
            results.push(state);
          }
        }
      } catch (err) {
        firstErr = firstErr ?? err;
      }
    }
    // If every sport failed, propagate so the backoff loop notices.
    if (!anyOk && firstErr) throw firstErr;
    return results;
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

function parseScoreboard(data: any, sport: Sport): GameState[] {
  const events: any[] = data?.events ?? [];
  return events.flatMap((event: any): GameState[] => {
    try {
      const comp = event.competitions?.[0];
      if (!comp) return [];
      const status = comp.status?.type;
      if (status?.completed || !status?.inProgress) return [];

      const home = comp.competitors?.find((c: any) => c.homeAway === 'home');
      const away = comp.competitors?.find((c: any) => c.homeAway === 'away');
      if (!home || !away) return [];

      const state: GameState = {
        gameId: event.id,
        sport,
        homeTeam: home.team?.abbreviation ?? home.team?.displayName ?? 'HOME',
        awayTeam: away.team?.abbreviation ?? away.team?.displayName ?? 'AWAY',
        homeScore: parseInt(home.score ?? '0', 10),
        awayScore: parseInt(away.score ?? '0', 10),
        clock: comp.status?.displayClock ?? null,
        period: comp.status?.period ?? 0,
        recordedAt: new Date().toISOString(),
      };
      return [state];
    } catch {
      return [];
    }
  });
}
