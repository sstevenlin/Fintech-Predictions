/**
 * Simulation mode — plays back scripted game-state transitions through the
 * real detectEvents → estimateFairValue → evaluate → placeOrder pipeline.
 * No real feeds, no Kalshi API calls. Always runs as a dry run.
 *
 * Usage: npm run sim
 */
import type { GameState, KalshiQuote, ClosedPosition } from './types';
import { detectEvents } from './detector';
import { estimateFairValue } from './fair_value';
import { evaluate, placeOrder } from './router';
import {
  ExitManager,
  shouldExit,
  exitFillPrice,
  realizedPnlCents,
} from './exit_manager';

interface Scenario {
  label: string;
  prev: GameState;
  next: GameState;
  // Simulated Kalshi quote at moment of event.
  entryQuote: KalshiQuote;
  // Quote a moment later, when the exit check fires.
  exitQuote: KalshiQuote;
}

const now = () => new Date().toISOString();

// Spread of 2c around mid is realistic for a busy Kalshi sports market.
function quoteAroundMid(mid: number, spread = 2): KalshiQuote {
  const half = Math.floor(spread / 2);
  return {
    yesBid: Math.max(1, mid - half),
    yesAsk: Math.min(99, mid + (spread - half)),
    yesMid: mid,
    last: mid,
  };
}

const SCENARIOS: Scenario[] = [
  {
    // NBA Q4 with > 5 min left — full +18pp delta. mid 49 → fair 67. Buy YES @ ask=50.
    // Exit when crowd repriced toward 64 (slight under-shoot).
    label: 'NBA — Q4 6:10  BOS 98 – 96 MIA  →  BOS scores',
    entryQuote: quoteAroundMid(49),
    exitQuote: quoteAroundMid(64),
    prev: { gameId: 'sim-nba-1', sport: 'NBA', homeTeam: 'BOS', awayTeam: 'MIA', homeScore: 98, awayScore: 96, clock: '6:10', period: 4, recordedAt: now() },
    next: { gameId: 'sim-nba-1', sport: 'NBA', homeTeam: 'BOS', awayTeam: 'MIA', homeScore: 100, awayScore: 96, clock: '5:48', period: 4, recordedAt: now() },
  },
  {
    // NFL Q4 close turnover. mid 50 → fair ≈ 38. Buy NO. Exit when mid drifts to 41.
    label: 'NFL — Q4 4:30  KC 21 – 21 BUF  →  KC turns it over',
    entryQuote: quoteAroundMid(50),
    exitQuote: quoteAroundMid(41),
    prev: { gameId: 'sim-nfl-1', sport: 'NFL', homeTeam: 'KC', awayTeam: 'BUF', homeScore: 21, awayScore: 21, clock: '4:30', period: 4, possession: 'KC', down: 3, yardsToGo: 8, recordedAt: now() },
    next: { gameId: 'sim-nfl-1', sport: 'NFL', homeTeam: 'KC', awayTeam: 'BUF', homeScore: 21, awayScore: 21, clock: '4:05', period: 4, possession: 'BUF', down: 1, yardsToGo: 10, recordedAt: now() },
  },
  {
    // MLB bottom-8 late_close. mid 50 → fair ≈ 72. Buy YES, mid moves to 65.
    label: 'MLB — bottom 8th  NYY 3 – 3 BOS  →  NYY scores',
    entryQuote: quoteAroundMid(50),
    exitQuote: quoteAroundMid(65),
    prev: { gameId: 'sim-mlb-1', sport: 'MLB', homeTeam: 'NYY', awayTeam: 'BOS', homeScore: 3, awayScore: 3, clock: null, period: 8, outs: 1, basesOccupied: 0b010, recordedAt: now() },
    next: { gameId: 'sim-mlb-1', sport: 'MLB', homeTeam: 'NYY', awayTeam: 'BOS', homeScore: 4, awayScore: 3, clock: null, period: 8, outs: 2, basesOccupied: 0, recordedAt: now() },
  },
];

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function divider() { console.log('─'.repeat(62)); }

export async function runSim(): Promise<void> {
  console.log('[sim] simulation mode — scripted scenarios, no live data\n');

  const exitManager = new ExitManager();
  const closed: ClosedPosition[] = [];

  for (let i = 0; i < SCENARIOS.length; i++) {
    const { label, prev, next, entryQuote, exitQuote } = SCENARIOS[i];
    divider();
    console.log(`[sim] ${i + 1}/${SCENARIOS.length}  ${label}`);
    divider();

    await sleep(300);

    const events = detectEvents(prev, next);
    if (events.length === 0) {
      console.log('[sim] no events detected\n');
      continue;
    }

    for (const event of events) {
      const ticker = `${event.sport}WIN-SIM-${event.nextState.homeTeam}-${event.nextState.awayTeam}`;
      const fairValue = estimateFairValue(event, ticker, entryQuote.yesMid!);
      if (!fairValue) {
        console.log(`[sim] no fair value for ${event.sport} ${event.eventType}\n`);
        continue;
      }

      const edge = fairValue.estimatedFairPrice - entryQuote.yesMid!;
      console.log(`[sim] detected  : ${event.eventType} — ${event.description}`);
      console.log(`[sim] market    : ${ticker} bid=${entryQuote.yesBid}c ask=${entryQuote.yesAsk}c mid=${entryQuote.yesMid}c`);
      console.log(`[sim] model     : fair=${fairValue.estimatedFairPrice}c  edge=${edge > 0 ? '+' : ''}${edge}c  Δwin=${fairValue.deltaWinProb > 0 ? '+' : ''}${(fairValue.deltaWinProb * 100).toFixed(1)}%  confidence=${fairValue.confidence}`);

      const signal = evaluate(fairValue);
      console.log(`[pipeline] ${event.sport} ${event.eventType} → ${signal.action} | ${signal.reason}`);

      const pos = await placeOrder(signal, true, entryQuote);
      if (!pos) { console.log(); continue; }

      exitManager.add(pos);
      console.log(`[sim] entered   : ${pos.side.toUpperCase()} ${pos.quantity}x  fill=${pos.entryFillPrice}c  target-mid=${pos.targetYesMid}c`);

      // Simulate the exit: in this scripted run we either hit the target or
      // bail at the exitQuote — whichever comes first conceptually.
      const decision = shouldExit(pos, exitQuote.yesMid!);
      if (!decision.exit) {
        // Force a timeout exit so the run reports something.
        (pos as any).hardExitAt = Date.now() - 1;
      }
      const reason = decision.exit ? decision.reason : 'timeout';
      const exitFill = exitFillPrice(pos.side, exitQuote);
      if (exitFill == null) { console.log(); continue; }

      const pnl = realizedPnlCents(pos.side, pos.entryFillPrice, exitFill, pos.quantity);
      const closedPos: ClosedPosition = {
        position: pos, exitedAt: Date.now(),
        exitFillPrice: exitFill, exitYesMid: exitQuote.yesMid!,
        exitQuote, pnlCents: pnl, reason,
      };
      closed.push(closedPos);
      exitManager.remove(pos.id);
      console.log(`[sim] exited    : ${reason}  fill=${exitFill}c  pnl=${pnl > 0 ? '+' : ''}${pnl}c`);
      console.log();
    }

    await sleep(200);
  }

  divider();
  const realized = closed.reduce((s, c) => s + c.pnlCents, 0);
  const wins = closed.filter(c => c.pnlCents > 0).length;
  const losses = closed.filter(c => c.pnlCents < 0).length;
  console.log(`[sim] summary  : closed=${closed.length} wins=${wins} losses=${losses} realized=${realized > 0 ? '+' : ''}${realized}c`);
  console.log('[sim] complete');
}
