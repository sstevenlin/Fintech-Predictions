import { listMarkets, KalshiMarket } from './kalshi_client';
import type { Sport } from './types';

// Kalshi series tickers by sport. Extend as Kalshi adds new series.
const SERIES_BY_SPORT: Partial<Record<Sport, string[]>> = {
  NBA: ['NBAWIN'],
  NFL: ['NFLWIN'],
  MLB: ['MLBWIN'],
};

const CACHE_TTL_MS = 5 * 60 * 1000;

interface SeriesCache {
  markets: KalshiMarket[];
  fetchedAt: number;
}

const seriesCache = new Map<string, SeriesCache>();
const tickerByGame = new Map<string, string>(); // gameId → Kalshi ticker

async function getMarketsForSport(sport: Sport): Promise<KalshiMarket[]> {
  const series = SERIES_BY_SPORT[sport] ?? [];
  const all: KalshiMarket[] = [];

  for (const s of series) {
    const cached = seriesCache.get(s);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      all.push(...cached.markets);
      continue;
    }
    const markets = await listMarkets(s);
    seriesCache.set(s, { markets, fetchedAt: Date.now() });
    all.push(...markets);
  }

  return all;
}

// Maps a game to its Kalshi market ticker by matching both team abbreviations
// against the event_ticker string. Returns null if no active market is found.
export async function resolveKalshiTicker(
  gameId: string,
  homeTeam: string,
  awayTeam: string,
  sport: Sport,
): Promise<string | null> {
  if (tickerByGame.has(gameId)) return tickerByGame.get(gameId)!;

  const markets = await getMarketsForSport(sport);
  const home = homeTeam.toUpperCase();
  const away = awayTeam.toUpperCase();

  const match = markets.find(m => {
    const t = m.event_ticker.toUpperCase();
    return t.includes(home) && t.includes(away);
  });

  if (match) {
    tickerByGame.set(gameId, match.ticker);
    console.log(`[market_map] ${gameId} → ${match.ticker}`);
    return match.ticker;
  }

  return null;
}
