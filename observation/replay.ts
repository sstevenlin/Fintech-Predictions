/**
 * Offline analyzer for paper-trade JSONL journals.
 *
 *   npm run replay                    # all logs/paper-*.jsonl
 *   npm run replay -- logs/foo.jsonl  # one specific file
 *
 * Reports realized P&L, hit rate, hold time, slippage, and breakdown by sport
 * and event type. Reads the durable Phase 1 record only — no DB required.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, basename } from 'path';

interface Record {
  ts: string;
  kind: 'event' | 'signal' | 'open' | 'exit' | 'skip';
  [k: string]: unknown;
}

interface ExitRecord extends Record {
  kind: 'exit';
  id: string;
  ticker: string;
  side: 'yes' | 'no';
  reason: 'target' | 'timeout';
  enteredAt: number;
  exitedAt: number;
  holdMs: number;
  entryFillPrice: number;
  exitFillPrice: number;
  entryYesMid: number;
  exitYesMid: number;
  quantity: number;
  pnlCents: number;
}

interface OpenRecord extends Record {
  kind: 'open';
  id: string;
  ticker: string;
  side: 'yes' | 'no';
  entryFillPrice: number;
  entryYesMid: number;
  targetYesMid: number;
}

interface SignalRecord extends Record {
  kind: 'signal';
  action: 'buy_yes' | 'buy_no' | 'pass';
  ticker: string;
  currentYesMid: number;
  estimatedFair: number;
  confidence: 'high' | 'medium' | 'low';
}

interface EventRecord extends Record {
  kind: 'event';
  sport: string;
  eventType: string;
  gameId: string;
}

function loadJournals(args: string[]): { files: string[]; records: Record[] } {
  const files: string[] = [];
  if (args.length > 0) {
    files.push(...args);
  } else {
    const dir = 'logs';
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.jsonl') && f.startsWith('paper-')) files.push(join(dir, f));
      }
    } catch { /* no logs dir yet */ }
  }
  files.sort();

  const records: Record[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { records.push(JSON.parse(trimmed)); }
      catch { /* skip malformed lines */ }
    }
  }
  return { files, records };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function summarize(records: Record[]): void {
  const events  = records.filter(r => r.kind === 'event')  as unknown as EventRecord[];
  const signals = records.filter(r => r.kind === 'signal') as unknown as SignalRecord[];
  const opens   = records.filter(r => r.kind === 'open')   as unknown as OpenRecord[];
  const exits   = records.filter(r => r.kind === 'exit')   as unknown as ExitRecord[];

  console.log(`\n── PAPER-TRADE JOURNAL ──`);
  console.log(`records: ${records.length}  events: ${events.length}  signals: ${signals.length}  ` +
    `opens: ${opens.length}  exits: ${exits.length}`);

  // Signal breakdown
  const byAction = new Map<string, number>();
  for (const s of signals) byAction.set(s.action, (byAction.get(s.action) ?? 0) + 1);
  console.log(`signals: ${[...byAction].map(([a, n]) => `${a}=${n}`).join('  ')}`);

  // Position health: are we still leaving positions hanging?
  const stranded = opens.length - exits.length;
  console.log(`positions opened but not exited (stranded): ${stranded}`);

  if (exits.length === 0) {
    console.log('\nno closed positions to score yet');
    return;
  }

  // Realized P&L
  const realized = exits.reduce((s, e) => s + e.pnlCents, 0);
  const wins = exits.filter(e => e.pnlCents > 0).length;
  const losses = exits.filter(e => e.pnlCents < 0).length;
  const targetHits  = exits.filter(e => e.reason === 'target').length;
  const timeouts    = exits.filter(e => e.reason === 'timeout').length;
  const holdSecs    = exits.map(e => e.holdMs / 1000);
  const slippages   = exits.map(e => Math.abs(e.entryFillPrice - e.entryYesMid));

  console.log(`\noverall: realized=${realized > 0 ? '+' : ''}${realized}c  ` +
    `closed=${exits.length}  wins=${wins}  losses=${losses}  hit-rate=${fmt(100 * wins / exits.length)}%`);
  console.log(`exits:   target=${targetHits}  timeout=${timeouts}  ` +
    `median-hold=${fmt(median(holdSecs))}s  avg-entry-slippage=${fmt(avg(slippages))}c`);

  // By sport / event type — pull from corresponding signal records via ticker prefix.
  // We can also derive a sport by the sport prefix in the matching event by gameId+ticker — too
  // fragile to be worth it. Bucket by ticker series prefix instead.
  const byBucket = new Map<string, ExitRecord[]>();
  for (const e of exits) {
    const series = e.ticker.split('-')[0];  // e.g. KXNBASERIES
    const key = series;
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key)!.push(e);
  }

  console.log(`\nby series:`);
  console.log(`  ${pad('series', 24)} ${pad('n', 4)} ${pad('wins', 5)} ${pad('losses', 7)} ${pad('realized', 10)} ${pad('hit-rate', 9)} ${pad('median-hold', 12)}`);
  for (const [series, rows] of byBucket) {
    const w = rows.filter(r => r.pnlCents > 0).length;
    const l = rows.filter(r => r.pnlCents < 0).length;
    const tot = rows.reduce((s, r) => s + r.pnlCents, 0);
    const hr = (100 * w / rows.length);
    const mh = median(rows.map(r => r.holdMs / 1000));
    console.log(
      `  ${pad(series, 24)} ${pad(String(rows.length), 4)} ${pad(String(w), 5)} ` +
      `${pad(String(l), 7)} ${pad((tot > 0 ? '+' : '') + tot + 'c', 10)} ${pad(fmt(hr) + '%', 9)} ` +
      `${pad(fmt(mh) + 's', 12)}`,
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  const { files, records } = loadJournals(args);
  if (files.length === 0) {
    console.error('no journal files found in logs/. pass a path explicitly to override.');
    process.exit(1);
  }
  console.log(`scanning ${files.length} file(s):`);
  for (const f of files) {
    const sz = statSync(f).size;
    console.log(`  ${f} (${sz} bytes)`);
  }
  summarize(records);
}

main();
