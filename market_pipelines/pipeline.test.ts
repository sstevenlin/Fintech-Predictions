import { describe, it, expect, jest } from '@jest/globals';
import { currentBtc5mSlug, getBtc5mConditionId, getPolymarketMarkets } from "./polymarket";
import { getKalshiMarkets, getActiveKalshiBtcTicker } from "./kalshi";

// Set a long timeout for tests that make live network calls
jest.setTimeout(20000);

describe("Polymarket Pipeline Utilities", () => {
  it("should generate a consistent deterministic 5-minute slug at period boundaries", () => {
    const exactlyOnBoundary = currentBtc5mSlug(300);
    expect(exactlyOnBoundary).toBe("btc-updown-5m-300");

    const insideBoundary = currentBtc5mSlug(599);
    expect(insideBoundary).toBe("btc-updown-5m-300");

    const exactlyNextBoundary = currentBtc5mSlug(600);
    expect(exactlyNextBoundary).toBe("btc-updown-5m-600");
  });
});

describe("Live Market Data Integrations", () => {
  it("should fetch actual probability and book data from Kalshi", async () => {
    // Note: Kalshi sometimes temporarily pauses this market, but assuming it's active
    const activeTicker = await getActiveKalshiBtcTicker();
    
    const markets = await getKalshiMarkets([activeTicker]);
    expect(markets).toBeDefined();
    expect(Array.isArray(markets)).toBe(true);
    
    // There should theoretically be at least one market if the series is active
    if (markets.length > 0) {
      const btcMarket = markets[0];
      expect(btcMarket.marketId).toBeDefined();
      expect(btcMarket.title).toBeDefined();
      
      // Both bids/asks and probability might be null on an illiquid day but the properties should exist natively
      expect(btcMarket).toHaveProperty("probability");
      expect(btcMarket).toHaveProperty("bestBid");
      expect(btcMarket).toHaveProperty("bestAsk");
      
      console.log(`Kalshi Best Bid: ${btcMarket.bestBid}, Best Ask: ${btcMarket.bestAsk}`);
    }
  });

  it("should fetch actual probability and book data from Polymarket", async () => {
    // Dynamically retrieve the current 5m rotational conditionID
    const conditionId = await getBtc5mConditionId();
    expect(conditionId).toBeDefined();
    expect(typeof conditionId).toBe("string");

    // Feed it to the pipeline to grab orderbook specifics natively
    const markets = await getPolymarketMarkets([conditionId]);
    expect(markets).toBeDefined();
    expect(Array.isArray(markets)).toBe(true);
    expect(markets.length).toBeGreaterThan(0);

    const pmMarket = markets[0];
    expect(pmMarket.marketId).toBe(conditionId);
    expect(pmMarket).toHaveProperty("probability");
    expect(pmMarket).toHaveProperty("bestBid");
    expect(pmMarket).toHaveProperty("bestAsk");
    
    console.log(`Polymarket Best Bid: ${pmMarket.bestBid}, Best Ask: ${pmMarket.bestAsk}`);
    
    // Ensure the data parsed flawlessly
    if (pmMarket.bestBid !== null) {
      expect(typeof pmMarket.bestBid).toBe("number");
      expect(isNaN(pmMarket.bestBid)).toBe(false);
    }
  });
});
