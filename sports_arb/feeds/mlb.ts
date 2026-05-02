import type { Feed } from './base';
import type { GameState } from '../types';

const MLB_SCOREBOARD = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&hydrate=linescore';

export class MlbFeed implements Feed {
  readonly name = 'mlb-official';
  private timer: ReturnType<typeof setInterval> | null = null;

  async poll(): Promise<GameState[]> {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch(`${MLB_SCOREBOARD}&date=${today}`);
      if (!res.ok) return [];
      const data = await res.json();
      return parseMlbSchedule(data);
    } catch (err) {
      console.error('[mlb] poll error:', err);
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

function parseMlbSchedule(data: any): GameState[] {
  const dates: any[] = data?.dates ?? [];
  return dates.flatMap((date: any) =>
    (date.games ?? []).flatMap((game: any): GameState[] => {
      if (game.status?.abstractGameState !== 'Live') return [];
      const ls = game.linescore;
      if (!ls) return [];

      // basesOccupied bitmask: bit0=1st, bit1=2nd, bit2=3rd
      const bases =
        (ls.offense?.first ? 0b001 : 0) |
        (ls.offense?.second ? 0b010 : 0) |
        (ls.offense?.third ? 0b100 : 0);

      return [{
        gameId: String(game.gamePk),
        sport: 'MLB',
        homeTeam: game.teams?.home?.team?.abbreviation ?? 'HOME',
        awayTeam: game.teams?.away?.team?.abbreviation ?? 'AWAY',
        homeScore: ls.teams?.home?.runs ?? 0,
        awayScore: ls.teams?.away?.runs ?? 0,
        clock: null,
        period: ls.currentInning ?? 0,
        outs: ls.outs ?? 0,
        basesOccupied: bases,
        recordedAt: new Date().toISOString(),
      }];
    })
  );
}
