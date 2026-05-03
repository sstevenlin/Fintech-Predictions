import type { Feed } from './base';
import { runPollLoop } from './base';
import type { GameState } from '../types';

const MLB_SCOREBOARD = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&hydrate=linescore';

export class MlbFeed implements Feed {
  readonly name = 'mlb-official';
  private handle: { stop: () => void } | null = null;

  async poll(): Promise<GameState[]> {
    const today = new Date().toISOString().slice(0, 10);
    const res = await fetch(`${MLB_SCOREBOARD}&date=${today}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return parseMlbSchedule(data);
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
