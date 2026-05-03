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
import { attachFileLogger } from './file_logger';

function summarize(s: GameState): string {
  const score = `${s.awayTeam} ${s.awayScore} @ ${s.homeTeam} ${s.homeScore}`;
  const clock = s.clock ? `Q${s.period} ${s.clock}` : `P${s.period}`;
  return `${s.sport} ${s.gameId} | ${score} | ${clock}`;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';

  if (process.argv.includes('--sim')) {
    await runSim();
    return;
  }

  const pollMs = Number(process.env.POLL_INTERVAL_MS ?? 500);
  attachFileLogger('paper');

  console.log(`[pipeline] starting | dryRun=${dryRun} pollMs=${pollMs}`);

  const prevStates = new Map<string, GameState>();
  const exitManager = new ExitManager();
  const seenGames = new Set<string>();

  const feeds = [new EspnFeed(), new NbaFeed(), new NflFeed(), new MlbFeed()];

  async function onUpdate(states: GameState[]) {
    for (const next of states) {
      const prev = prevStates.get(next.gameId);
      prevStates.set(next.gameId, next);

      if (!seenGames.has(next.gameId)) {
        seenGames.add(next.gameId);
        console.log(`[pipeline] tracking new game | ${summarize(next)}`);
      }

      if (!prev) continue;

      // Heartbeat on every score change (broader than just events) so we can audit the feed.
      if (prev.homeScore !== next.homeScore || prev.awayScore !== next.awayScore) {
        console.log(
          `[pipeline] score change | ${summarize(next)} | was ${prev.awayScore}-${prev.homeScore}`,
        );
      }

      const events = detectEvents(prev, next);
      for (const event of events) {
        console.log(
          `[pipeline] event | ${event.sport} ${event.eventType} | ${event.description}`,
        );

        const ticker = await resolveKalshiTicker(
          event.gameId,
          event.nextState.homeTeam,
          event.nextState.awayTeam,
          event.sport,
        );
        if (!ticker) {
          console.log(`[pipeline] skip | no kalshi market for ${event.gameId}`);
          continue;
        }

        const kalshiPrice = await getMarketPrice(ticker);
        if (kalshiPrice == null) {
          console.log(`[pipeline] skip | could not read price for ${ticker}`);
          continue;
        }

        const fairValue = estimateFairValue(event, ticker, kalshiPrice);
        if (!fairValue) {
          console.log(`[pipeline] skip | no fair-value entry for ${event.sport}/${event.eventType}`);
          continue;
        }

        console.log(
          `[pipeline] fair-value | ${ticker} market=${kalshiPrice}c fair=${fairValue.estimatedFairPrice}c ` +
          `Δ=${(fairValue.deltaWinProb * 100).toFixed(1)}pp confidence=${fairValue.confidence}`,
        );

        const signal = evaluate(fairValue);
        console.log(`[pipeline] signal | ${signal.action} | ${signal.reason}`);

        const pos = await placeOrder(signal, dryRun);
        if (pos) {
          console.log(
            `[pipeline] open position | ${pos.kalshiTicker} ${pos.side} qty=${pos.quantity} ` +
            `entry=${pos.entryPrice}c target=${pos.targetExitPrice}c hardExitInMs=${pos.hardExitAt - Date.now()}`,
          );
          exitManager.add(pos);
        }
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

  // Heartbeat every 30s so the log shows liveness when no events are firing.
  const heartbeat = setInterval(() => {
    console.log(
      `[pipeline] heartbeat | tracked=${seenGames.size} open=${exitManager.all().length}`,
    );
  }, 30_000);

  process.on('SIGINT', () => {
    console.log('[pipeline] shutting down');
    feeds.forEach(f => f.stop());
    clearInterval(heartbeat);
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[pipeline] fatal:', err);
  process.exit(1);
});
