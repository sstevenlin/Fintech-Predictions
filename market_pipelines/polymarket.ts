import { ClobClient, Chain } from "@polymarket/clob-client";
import { Market } from "./types";

const CLOB_HOST = "https://clob.polymarket.com";

/** The SDK client — instantiated without credentials for read-only access. */
const clob = new ClobClient(CLOB_HOST, Chain.POLYGON);

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const WINDOW_SEC = 300; // 5 minutes

export function currentBtc5mSlug(nowSec = Math.floor(Date.now() / 1000)): string {
  const windowStart = Math.floor(nowSec / WINDOW_SEC) * WINDOW_SEC;
  return `btc-updown-5m-${windowStart}`;
}

interface GammaEvent {
  slug: string;
  markets: Array<{ conditionId: string }>;
}

/** Resolves the dynamic conditionId for the active 5-minute Polymarket BTC market */
export async function getBtc5mConditionId(nowSec?: number): Promise<string> {
  const slug = currentBtc5mSlug(nowSec);
  let res = await fetch(`${GAMMA_BASE}/events?slug=${slug}`);
  let events: GammaEvent[] = res.ok ? await res.json() : [];
  let event = events.find((e) => e.slug === slug);
  
  if (!event) { // Fallback to previous window
    const prevSlug = currentBtc5mSlug((nowSec ?? Math.floor(Date.now() / 1000)) - WINDOW_SEC);
    res = await fetch(`${GAMMA_BASE}/events?slug=${prevSlug}`);
    events = res.ok ? await res.json() : [];
    event = events.find((e) => e.slug === prevSlug);
  }

  if (!event || !event.markets[0]) throw new Error(`No active btc-updown-5m condition ID found for slug ${slug}`);
  return event.markets[0].conditionId;
}

export async function getPolymarketMarkets(conditionIds: string[]): Promise<Market[]> {
  const results: Market[] = [];

  for (const conditionId of conditionIds) {
    try {
      // Use the SDK to get the market info
      const market: any = await clob.getMarket(conditionId);

      // Token setup: tokens element 0 is usually YES, but we can fall back to explicit tokens array if needed
      let yesTokenId: string | null = null;
      if (market.tokens && market.tokens.length > 0) {
        // In Polymarket, YES token is typically explicitly noted or it's token[0] in most simple binary markets
        const token = market.tokens.find((t: any) => t.outcome === "Yes" || t.outcome === "YES") || market.tokens[0];
        yesTokenId = token.token_id;
      }

      // Use the SDK to get the live orderbook mid-price
      let probability: number | null = null;
      let bestBidRes: number | null = null;
      let bestAskRes: number | null = null;
      if (yesTokenId) {
        const book = await clob.getOrderBook(yesTokenId);
        const bestBid = book.bids && book.bids[0] ? parseFloat(book.bids[0].price) : null;
        const bestAsk = book.asks && book.asks[0] ? parseFloat(book.asks[0].price) : null;
        bestBidRes = bestBid;
        bestAskRes = bestAsk;
        if (bestBid !== null && bestAsk !== null) {
          probability = Math.round(((bestBid + bestAsk) / 2) * 10000) / 10000;
        } else {
          probability = bestBid ?? bestAsk;
        }
      }

      results.push({
        marketId: market.condition_id || conditionId,
        title: market.question || market.title || `Polymarket ${conditionId}`,
        probability,
        bestBid: bestBidRes,
        bestAsk: bestAskRes,
        expiration: market.end_date_iso || market.endDate || null,
      });
    } catch (err) {
      console.error(`Failed to fetch active Polymarket ${conditionId}:`, err);
    }
  }

  return results;
}
