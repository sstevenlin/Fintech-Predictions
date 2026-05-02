/**
 * Phase 0 observer.
 *
 * Runs the full detection pipeline with no capital: detects events, snapshots
 * Kalshi prices at T+0/15/30/60/120s, and writes everything to the DB.
 * No orders are placed. Run for 2-4 weeks to quantify the edge before Phase 1.
 *
 * Usage: npm run observe
 */
import 'dotenv/config';
import { EspnFeed } from '../sports_arb/feeds/espn';
import { NbaFeed } from '../sports_arb/feeds/nba';
import { detectEvents } from '../sports_arb/detector';
import { estimateFairValue } from '../sports_arb/fair_value';
import { logEvent, logEdgeSnapshot } from './logger';
import { getMarketPrice } from '../sports_arb/kalshi_client';
import { resolveKalshiTicker } from '../sports_arb/market_map';
import type { GameState } from '../sports_arb/types';

const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 500);
const SNAPSHOTS: Array<['t15s' | 't30s' | 't60s' | 't120s', number]> = [
  ['t15s',  15_000],
  ['t30s',  30_000],
  ['t60s',  60_000],
  ['t120s', 120_000],
];

async function main() {
  console.log('[observer] Phase 0 — observation mode, no capital');
  const prevStates = new Map<string, GameState>();
  const feeds = [new EspnFeed(), new NbaFeed()];

  async function onUpdate(states: GameState[]) {
    for (const next of states) {
      const prev = prevStates.get(next.gameId);
      prevStates.set(next.gameId, next);
      if (!prev) continue;

      const events = detectEvents(prev, next);
      for (const event of events) {
        const ticker = await resolveKalshiTicker(
          event.gameId,
          event.nextState.homeTeam,
          event.nextState.awayTeam,
          event.sport,
        );
        const price0 = ticker ? await getMarketPrice(ticker) : null;

        const eventId = await logEvent(event, ticker);
        if (!eventId) continue;

        console.log(`[observer] ${event.sport} ${event.eventType} | ${event.description}`);

        if (price0 != null) {
          const fairValue = estimateFairValue(event, ticker!, price0);
          await logEdgeSnapshot(eventId, 't0', price0, fairValue ?? undefined);
        }

        if (ticker) {
          for (const [label, delay] of SNAPSHOTS) {
            setTimeout(async () => {
              const price = await getMarketPrice(ticker);
              if (price != null) await logEdgeSnapshot(eventId, label, price);
            }, delay);
          }
        }
      }
    }
  }

  feeds.forEach(f => f.start(POLL_MS, onUpdate));

  process.on('SIGINT', () => {
    console.log('[observer] shutting down');
    feeds.forEach(f => f.stop());
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[observer] fatal:', err);
  process.exit(1);
});
