/**
 * Simulation mode — plays back scripted game-state transitions through the
 * real detectEvents → estimateFairValue → evaluate → placeOrder pipeline.
 * No real feeds, no Kalshi API calls. Always runs as a dry run.
 *
 * Usage: npm run sim
 */
import type { GameState } from './types';
import { detectEvents } from './detector';
import { estimateFairValue } from './fair_value';
import { evaluate, placeOrder } from './router';
import { ExitManager } from './exit_manager';

interface Scenario {
  label: string;
  prev: GameState;
  next: GameState;
  // Simulated Kalshi YES mid-price in cents at moment of event.
  // Chosen so the model produces a clear, non-trivial edge.
  seedPrice: number;
}

const now = () => new Date().toISOString();

const SCENARIOS: Scenario[] = [
  {
    // NBA Q4 late: delta=+0.18 (high confidence) → fair = 49+18 = 67¢ → buy_yes, 18¢ edge
    label: 'NBA — Q4 2:10  BOS 98 – 96 MIA  →  BOS scores',
    seedPrice: 49,
    prev: { gameId: 'sim-nba-1', sport: 'NBA', homeTeam: 'BOS', awayTeam: 'MIA', homeScore: 98, awayScore: 96, clock: '2:10', period: 4, recordedAt: now() },
    next: { gameId: 'sim-nba-1', sport: 'NBA', homeTeam: 'BOS', awayTeam: 'MIA', homeScore: 100, awayScore: 96, clock: '1:48', period: 4, recordedAt: now() },
  },
  {
    // NFL Q4 close turnover: delta=-0.12 (medium confidence) → fair = 50-12 = 38¢ → buy_no, 12¢ edge
    label: 'NFL — Q4 4:30  KC 21 – 21 BUF  →  KC turns it over',
    seedPrice: 50,
    prev: { gameId: 'sim-nfl-1', sport: 'NFL', homeTeam: 'KC', awayTeam: 'BUF', homeScore: 21, awayScore: 21, clock: '4:30', period: 4, possession: 'KC', down: 3, yardsToGo: 8, recordedAt: now() },
    next: { gameId: 'sim-nfl-1', sport: 'NFL', homeTeam: 'KC', awayTeam: 'BUF', homeScore: 21, awayScore: 21, clock: '4:05', period: 4, possession: 'BUF', down: 1, yardsToGo: 10, recordedAt: now() },
  },
  {
    // MLB bottom-8 late_close: delta=+0.22 (high confidence) → fair = 50+22 = 72¢ → buy_yes, 22¢ edge
    label: 'MLB — bottom 8th  NYY 3 – 3 BOS  →  NYY scores',
    seedPrice: 50,
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

  for (let i = 0; i < SCENARIOS.length; i++) {
    const { label, prev, next, seedPrice } = SCENARIOS[i];
    divider();
    console.log(`[sim] ${i + 1}/${SCENARIOS.length}  ${label}`);
    divider();

    await sleep(600);

    const events = detectEvents(prev, next);
    if (events.length === 0) {
      console.log('[sim] no events detected\n');
      continue;
    }

    for (const event of events) {
      const ticker = `${event.sport}WIN-SIM-${event.nextState.homeTeam}-${event.nextState.awayTeam}`;
      const fairValue = estimateFairValue(event, ticker, seedPrice);
      if (!fairValue) {
        console.log(`[sim] no fair value for ${event.sport} ${event.eventType}\n`);
        continue;
      }

      const edge = fairValue.estimatedFairPrice - seedPrice;
      console.log(`[sim] detected  : ${event.eventType} — ${event.description}`);
      console.log(`[sim] market    : ${ticker} @ ${seedPrice}¢`);
      console.log(`[sim] model     : fair=${fairValue.estimatedFairPrice}¢  edge=${edge > 0 ? '+' : ''}${edge}¢  Δwin=${fairValue.deltaWinProb > 0 ? '+' : ''}${(fairValue.deltaWinProb * 100).toFixed(0)}%  confidence=${fairValue.confidence}`);

      const signal = evaluate(fairValue);
      console.log(`[pipeline] ${event.sport} ${event.eventType} → ${signal.action} | ${signal.reason}`);

      const pos = await placeOrder(signal, true /* always dry-run in sim */);
      if (pos) {
        exitManager.add(pos);
        const estPnl = pos.side === 'yes'
          ? (pos.targetExitPrice - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - pos.targetExitPrice) * pos.quantity;
        console.log(`[sim] position  : ${pos.side.toUpperCase()} ${pos.quantity}x @ entry=${pos.entryPrice}¢  target=${pos.targetExitPrice}¢  est.pnl=${estPnl > 0 ? '+' : ''}${estPnl}¢`);
      }
      console.log();
    }

    await sleep(400);
  }

  const positions = exitManager.all();
  if (positions.length > 0) {
    divider();
    console.log('[sim] open positions (real pipeline holds ≤60s then exits at target or timeout)');
    let totalEst = 0;
    for (const pos of positions) {
      const estPnl = pos.side === 'yes'
        ? (pos.targetExitPrice - pos.entryPrice) * pos.quantity
        : (pos.entryPrice - pos.targetExitPrice) * pos.quantity;
      totalEst += estPnl;
      console.log(`  ${pos.side.toUpperCase().padEnd(3)} ${pos.quantity}x ${pos.kalshiTicker.padEnd(28)} entry=${pos.entryPrice}¢  target=${pos.targetExitPrice}¢  est=${estPnl > 0 ? '+' : ''}${estPnl}¢`);
    }
    console.log(`  ${''.padEnd(55)} total: ${totalEst > 0 ? '+' : ''}${totalEst}¢`);
  }

  console.log('\n[sim] complete');
}
