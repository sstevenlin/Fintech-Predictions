import { listMarkets, KalshiMarket } from './kalshi_client';
import type { Sport, KalshiQuote } from './types';

// What flavor of contract are we trading?
//   per_game     — single-game moneyline. A scoring play moves the price by
//                  the full per-game win-probability delta.
//   series_winner — series-of-N winner contract. A scoring play in one game
//                  moves the price less than a per-game contract because
//                  later games are still pending.
export type ContractType = 'per_game' | 'series_winner';

interface SeriesConfig {
  series: string;
  type: ContractType;
}

const SERIES_BY_SPORT: Partial<Record<Sport, SeriesConfig[]>> = {
  NBA: [
    { series: 'KXNBAGAME',   type: 'per_game' },
    { series: 'KXNBASERIES', type: 'series_winner' },
  ],
  NFL: [
    { series: 'KXNFLGAME', type: 'per_game' },
  ],
  MLB: [
    { series: 'KXMLBGAME', type: 'per_game' },
  ],
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_SPREAD_CENTS = Number(process.env.MAX_SPREAD_CENTS ?? 10);

export interface ResolvedMarket {
  ticker: string;
  eventTicker: string;
  contractType: ContractType;
  side: 'home' | 'away';
  spreadCents: number;
  yesBid: number;
  yesAsk: number;
  yesMid: number;
}

interface SeriesCacheEntry {
  markets: Array<KalshiMarket & { __contractType: ContractType }>;
  fetchedAt: number;
}

const seriesCache = new Map<string, SeriesCacheEntry>();
const tickerByGame = new Map<string, ResolvedMarket>();

async function getMarketsForSport(sport: Sport): Promise<Array<KalshiMarket & { __contractType: ContractType }>> {
  const configs = SERIES_BY_SPORT[sport] ?? [];
  const all: Array<KalshiMarket & { __contractType: ContractType }> = [];
  for (const cfg of configs) {
    const cached = seriesCache.get(cfg.series);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      all.push(...cached.markets);
      continue;
    }
    const markets = await listMarkets(cfg.series);
    const tagged = markets.map(m => Object.assign(m, { __contractType: cfg.type }));
    seriesCache.set(cfg.series, { markets: tagged, fetchedAt: Date.now() });
    all.push(...tagged);
  }
  return all;
}

// Pulls the team-code segment out of the event ticker. Kalshi tickers look like:
//   KXNBASERIES-26PHIBOSR1            (year + team1 + team2 + roundN)
//   KXNBAGAME-26MAY04MINSAS           (date + team1 + team2)
// We strip the leading series prefix and trailing roundN/sideN suffixes, then
// look at the remaining "team payload" to confirm both team codes actually appear.
// Substring containment is fine because Kalshi tricodes are 3 letters and
// they're concatenated in 6-letter pairs — "BOS" inside "PHIBOS" is unambiguous.
function teamSegment(eventTicker: string): string {
  const t = eventTicker.toUpperCase();
  // Drop the series prefix (everything up to and including the first '-').
  const afterPrefix = t.includes('-') ? t.slice(t.indexOf('-') + 1) : t;
  // Drop a trailing R\d+ (round indicator on series tickers).
  return afterPrefix.replace(/R\d+$/, '');
}

function parseQuoteFromMarket(m: KalshiMarket): { yesBid: number | null; yesAsk: number | null } {
  const dollarsToCents = (s: string | undefined) => {
    if (s == null) return null;
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  };
  return {
    yesBid: dollarsToCents(m.yes_bid_dollars) ?? m.yes_bid ?? null,
    yesAsk: dollarsToCents(m.yes_ask_dollars) ?? m.yes_ask ?? null,
  };
}

// Matches one of the team codes on the side suffix of the ticker.
// `KXNBASERIES-26PHIBOSR1-PHI` ⇒ side suffix is `PHI`.
function sideSuffix(ticker: string): string | null {
  const parts = ticker.toUpperCase().split('-');
  if (parts.length < 2) return null;
  return parts[parts.length - 1];
}

// Maps a game to its Kalshi market. Returns the resolved market metadata
// including contract type and a snapshot quote so the caller doesn't have to
// re-fetch.
//
// Filtering rules:
//   - Both team tricodes must appear in the cleaned-up event-ticker team segment.
//   - The market must have both yes_bid and yes_ask present.
//   - Spread must be ≤ MAX_SPREAD_CENTS (env: MAX_SPREAD_CENTS, default 10).
//   - Prefer the home team's side (so home-perspective fair-value math applies).
//   - When both per_game and series_winner contracts match, take per_game.
export async function resolveKalshiTicker(
  gameId: string,
  homeTeam: string,
  awayTeam: string,
  sport: Sport,
): Promise<ResolvedMarket | null> {
  const cached = tickerByGame.get(gameId);
  if (cached) return cached;

  const markets = await getMarketsForSport(sport);
  const home = homeTeam.toUpperCase();
  const away = awayTeam.toUpperCase();

  const eventMatches = markets.filter(m => {
    const seg = teamSegment(m.event_ticker);
    return seg.includes(home) && seg.includes(away);
  });
  if (eventMatches.length === 0) return null;

  const candidates: ResolvedMarket[] = [];
  for (const m of eventMatches) {
    const { yesBid, yesAsk } = parseQuoteFromMarket(m);
    if (yesBid == null || yesAsk == null) continue;

    const spread = yesAsk - yesBid;
    if (spread < 0 || spread > MAX_SPREAD_CENTS) continue;

    const suf = sideSuffix(m.ticker);
    let side: 'home' | 'away' | null = null;
    if (suf === home) side = 'home';
    else if (suf === away) side = 'away';
    else continue;  // unrecognized side suffix — skip rather than guess

    candidates.push({
      ticker: m.ticker,
      eventTicker: m.event_ticker,
      contractType: m.__contractType,
      side,
      spreadCents: spread,
      yesBid,
      yesAsk,
      yesMid: Math.round((yesBid + yesAsk) / 2),
    });
  }

  if (candidates.length === 0) return null;

  // Priority: home side > away side; then per_game > series_winner.
  candidates.sort((a, b) => {
    if (a.side !== b.side) return a.side === 'home' ? -1 : 1;
    if (a.contractType !== b.contractType) {
      return a.contractType === 'per_game' ? -1 : 1;
    }
    return a.spreadCents - b.spreadCents;
  });

  const chosen = candidates[0];
  tickerByGame.set(gameId, chosen);
  console.log(
    `[market_map] ${gameId} (${away}@${home}) → ${chosen.ticker} ` +
    `[${chosen.contractType}, side=${chosen.side}, spread=${chosen.spreadCents}c, mid=${chosen.yesMid}c]`,
  );
  return chosen;
}

// Test/operational hook: clear caches.
export function _resetMarketMapCachesForTests(): void {
  seriesCache.clear();
  tickerByGame.clear();
}
