import { listMarkets, KalshiMarket } from './kalshi_client';
import type { Sport } from './types';

// Kalshi series tickers by sport, in priority order.
// Per-game moneylines take precedence; series-winner contracts are the live fallback for playoff games.
const SERIES_BY_SPORT: Partial<Record<Sport, string[]>> = {
  NBA: ['KXNBAGAME', 'KXNBASERIES'],
  NFL: ['KXNFLGAME'],
  MLB: ['KXMLBGAME'],
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

// Maps a game to its Kalshi market ticker. Prefers the home team's side of the
// market so the home-perspective fair-value delta applies without sign-flipping.
// Returns null if no active market is found.
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

  const eventMatches = markets.filter(m => {
    const t = m.event_ticker.toUpperCase();
    return t.includes(home) && t.includes(away);
  });
  if (eventMatches.length === 0) return null;

  const homeSide = eventMatches.find(m => m.ticker.toUpperCase().endsWith(`-${home}`));
  const chosen = homeSide ?? eventMatches[0];

  tickerByGame.set(gameId, chosen.ticker);
  console.log(`[market_map] ${gameId} (${away}@${home}) → ${chosen.ticker}`);
  return chosen.ticker;
}
