import 'dotenv/config';
import { runSim } from './sim';
import type { GameState } from './types';
import { EspnFeed } from './feeds/espn';
import { NbaFeed } from './feeds/nba';
import { NflFeed } from './feeds/nfl';
import { MlbFeed } from './feeds/mlb';
import { detectEvents } from './detector';
import { estimateFairValue } from './fair_value';
import { evaluate, placeOrder } from './router';
import { ExitManager } from './exit_manager';
import { getMarketPrice } from './kalshi_client';
import { resolveKalshiTicker } from './market_map';

async function main() {
  const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';

  if (process.argv.includes('--sim')) {
    await runSim();
    return;
  }

  const pollMs = Number(process.env.POLL_INTERVAL_MS ?? 500);

  console.log(`[pipeline] starting | dryRun=${dryRun} pollMs=${pollMs}`);

  const prevStates = new Map<string, GameState>();
  const exitManager = new ExitManager();

  const feeds = [new EspnFeed(), new NbaFeed(), new NflFeed(), new MlbFeed()];

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
        if (!ticker) continue;

        const kalshiPrice = await getMarketPrice(ticker);
        if (kalshiPrice == null) continue;

        const fairValue = estimateFairValue(event, ticker, kalshiPrice);
        if (!fairValue) continue;

        const signal = evaluate(fairValue);
        console.log(`[pipeline] ${event.sport} ${event.eventType} → ${signal.action} | ${signal.reason}`);

        const pos = await placeOrder(signal, dryRun);
        if (pos) exitManager.add(pos);
      }

      // Check exits on open positions
      for (const pos of exitManager.all()) {
        const price = await getMarketPrice(pos.kalshiTicker);
        if (price == null) continue;
        if (exitManager.check(pos.kalshiTicker, price) === 'exit') {
          const closed = exitManager.remove(pos.kalshiTicker);
          if (closed) {
            const pnl = pos.side === 'yes'
              ? (price - pos.entryPrice) * pos.quantity
              : (pos.entryPrice - price) * pos.quantity;
            console.log(`[pipeline] EXIT ${pos.kalshiTicker} | pnl=${pnl > 0 ? '+' : ''}${pnl}c`);
          }
        }
      }
    }
  }

  for (const feed of feeds) {
    feed.start(pollMs, onUpdate);
  }

  process.on('SIGINT', () => {
    console.log('[pipeline] shutting down');
    feeds.forEach(f => f.stop());
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[pipeline] fatal:', err);
  process.exit(1);
});
