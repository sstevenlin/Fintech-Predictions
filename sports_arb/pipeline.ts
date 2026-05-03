import 'dotenv/config';
import { runSim } from './sim';
import type { GameState, ClosedPosition, KalshiQuote } from './types';
import { EspnFeed } from './feeds/espn';
import { NbaFeed } from './feeds/nba';
import { NflFeed } from './feeds/nfl';
import { MlbFeed } from './feeds/mlb';
import { detectEvents } from './detector';
import { estimateFairValue } from './fair_value';
import { evaluate, placeOrder } from './router';
import { ExitManager, shouldExit, exitFillPrice, realizedPnlCents } from './exit_manager';
import { getMarketQuote } from './kalshi_client';
import { resolveKalshiTicker } from './market_map';
import { attachFileLogger } from './file_logger';
import {
  attachTradeJournal,
  recordEvent,
  recordSignal,
  recordSkip,
  recordOpen,
  recordExit,
  journalFile,
} from './trade_journal';

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
  attachTradeJournal('paper');

  console.log(`[pipeline] starting | dryRun=${dryRun} pollMs=${pollMs} journal=${journalFile()}`);

  const prevStates = new Map<string, GameState>();
  const exitManager = new ExitManager();
  const seenGames = new Set<string>();
  const closedPositions: ClosedPosition[] = [];

  const feeds = [new EspnFeed(), new NbaFeed(), new NflFeed(), new MlbFeed()];

  // Quote cache shared across the onUpdate cycle to dedupe fetches.
  async function fetchQuoteCached(ticker: string, cache: Map<string, KalshiQuote | null>) {
    if (cache.has(ticker)) return cache.get(ticker)!;
    const q = await getMarketQuote(ticker);
    cache.set(ticker, q);
    return q;
  }

  async function onUpdate(states: GameState[]) {
    const quoteCache = new Map<string, KalshiQuote | null>();

    for (const next of states) {
      const prev = prevStates.get(next.gameId);
      prevStates.set(next.gameId, next);

      if (!seenGames.has(next.gameId)) {
        seenGames.add(next.gameId);
        console.log(`[pipeline] tracking new game | ${summarize(next)}`);
      }

      if (!prev) continue;

      if (prev.homeScore !== next.homeScore || prev.awayScore !== next.awayScore) {
        console.log(
          `[pipeline] score change | ${summarize(next)} | was ${prev.awayScore}-${prev.homeScore}`,
        );
      }

      const events = detectEvents(prev, next);
      for (const event of events) {
        recordEvent(event);
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
          recordSkip('', 'no_market', { gameId: event.gameId });
          console.log(`[pipeline] skip | no kalshi market for ${event.gameId}`);
          continue;
        }

        const quote = await fetchQuoteCached(ticker, quoteCache);
        if (!quote || quote.yesMid == null) {
          recordSkip(ticker, 'no_quote');
          console.log(`[pipeline] skip | could not read quote for ${ticker}`);
          continue;
        }

        const fairValue = estimateFairValue(event, ticker, quote.yesMid);
        if (!fairValue) {
          recordSkip(ticker, 'no_fair_value', {
            sport: event.sport,
            eventType: event.eventType,
          });
          console.log(`[pipeline] skip | no fair-value entry for ${event.sport}/${event.eventType}`);
          continue;
        }

        console.log(
          `[pipeline] fair-value | ${ticker} bid=${quote.yesBid}c ask=${quote.yesAsk}c mid=${quote.yesMid}c ` +
          `fair=${fairValue.estimatedFairPrice}c Δ=${(fairValue.deltaWinProb * 100).toFixed(1)}pp ` +
          `confidence=${fairValue.confidence}`,
        );

        const signal = evaluate(fairValue);
        recordSignal(signal, fairValue);
        console.log(`[pipeline] signal | ${signal.action} | ${signal.reason}`);

        const pos = await placeOrder(signal, dryRun, quote);
        if (pos) {
          recordOpen(pos);
          console.log(
            `[pipeline] open position | ${pos.id} ${pos.kalshiTicker} ${pos.side} qty=${pos.quantity} ` +
            `fill=${pos.entryFillPrice}c targetMid=${pos.targetYesMid}c hardExitInMs=${pos.hardExitAt - Date.now()}`,
          );
          exitManager.add(pos);
        }
      }
    }

    // Check exits across every open position. Reuse the quote cache so we don't
    // re-fetch a ticker we just looked at for the entry path.
    for (const pos of exitManager.all()) {
      const quote = await fetchQuoteCached(pos.kalshiTicker, quoteCache);
      if (!quote || quote.yesMid == null) continue;

      const decision = shouldExit(pos, quote.yesMid);
      if (!decision.exit) continue;

      const exitFill = exitFillPrice(pos.side, quote);
      if (exitFill == null) continue;

      const pnl = realizedPnlCents(pos.side, pos.entryFillPrice, exitFill, pos.quantity);
      const closed: ClosedPosition = {
        position: pos,
        exitedAt: Date.now(),
        exitFillPrice: exitFill,
        exitYesMid: quote.yesMid,
        exitQuote: quote,
        pnlCents: pnl,
        reason: decision.reason,
      };
      exitManager.remove(pos.id);
      closedPositions.push(closed);
      recordExit(closed);

      console.log(
        `[pipeline] EXIT ${pos.id} ${pos.kalshiTicker} ${pos.side} ` +
        `entry=${pos.entryFillPrice}c exit=${exitFill}c qty=${pos.quantity} ` +
        `reason=${decision.reason} pnl=${pnl > 0 ? '+' : ''}${pnl}c`,
      );
    }
  }

  for (const feed of feeds) {
    feed.start(pollMs, onUpdate);
  }

  const heartbeat = setInterval(() => {
    const open = exitManager.all().length;
    const closed = closedPositions.length;
    const realized = closedPositions.reduce((s, c) => s + c.pnlCents, 0);
    console.log(
      `[pipeline] heartbeat | tracked=${seenGames.size} open=${open} closed=${closed} realized=${realized > 0 ? '+' : ''}${realized}c`,
    );
  }, 30_000);

  function shutdown() {
    console.log('[pipeline] shutting down');
    feeds.forEach(f => f.stop());
    clearInterval(heartbeat);
    const closed = closedPositions.length;
    const realized = closedPositions.reduce((s, c) => s + c.pnlCents, 0);
    const wins = closedPositions.filter(c => c.pnlCents > 0).length;
    const losses = closedPositions.filter(c => c.pnlCents < 0).length;
    console.log(
      `[pipeline] summary | closed=${closed} wins=${wins} losses=${losses} ` +
      `realized=${realized > 0 ? '+' : ''}${realized}c | open-at-shutdown=${exitManager.all().length}`,
    );
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[pipeline] fatal:', err);
  process.exit(1);
});
