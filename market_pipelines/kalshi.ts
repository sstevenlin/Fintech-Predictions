import { Configuration, MarketApi } from "kalshi-typescript";
import { Market } from "./types";

const config = new Configuration({
  basePath: "https://api.elections.kalshi.com/trade-api/v2"
});
const marketApi = new MarketApi(config);

function midPrice(bid: number | null | undefined, ask: number | null | undefined): number | null {
  if (bid != null && ask != null) return Math.round(((bid + ask) / 2) * 10000) / 10000;
  return bid ?? ask ?? null;
}

export const KALSHI_BTC_15M_SERIES_TICKER = "KXBTC15M";

/** Resolves the highly volatile active ticker for the current BTC 15m window */
export async function getActiveKalshiBtcTicker(): Promise<string> {
  const res = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${KALSHI_BTC_15M_SERIES_TICKER}&status=open&limit=10`);
  if (!res.ok) throw new Error(`Kalshi API error: ${res.status}`);
  const { markets }: { markets: any[] } = await res.json();
  if (!markets || !markets.length) throw new Error("No open KXBTC15M markets found");
  markets.sort((a, b) => (a.expiration_time ?? "") < (b.expiration_time ?? "") ? -1 : 1);
  return markets[0].ticker;
}

/** Fetch current active markets from Kalshi using their tickers. */
export async function getKalshiMarkets(tickers: string[]): Promise<Market[]> {
  const results: Market[] = [];
  for (const ticker of tickers) {
    try {
      const res = await marketApi.getMarket(ticker);
      const market = (res.data as any).market || res.data;

      const probability = midPrice(market.yesBid || market.yes_bid, market.yesAsk || market.yes_ask)
        ?? (market.lastPrice || market.last_price || null);

      results.push({
        marketId: market.ticker,
        title: market.title || market.ticker,
        probability,
        bestBid: market.yesBid || market.yes_bid || null,
        bestAsk: market.yesAsk || market.yes_ask || null,
        expiration: market.expirationTime || market.closeTime || market.expiration_time || market.close_time || null,
      });
    } catch (err) {
      console.error(`Failed to fetch Kalshi market ${ticker}:`, err);
    }
  }
  return results;
}
