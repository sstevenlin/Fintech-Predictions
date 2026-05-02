import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface EdgeStats {
  sport: string;
  eventType: string;
  sampleSize: number;
  hitRate: number;        // % events where price moved in predicted direction by t60s
  avgDriftCents: number;  // avg |t60s - t0| in cents
  avgSimPnl: number;      // avg simulated_pnl_cents
  medianLatencyMs: number;
}

export async function computeEdgeStats(): Promise<EdgeStats[]> {
  const { data, error } = await supabase.rpc('compute_edge_stats');
  if (error) throw new Error(`compute_edge_stats RPC failed: ${error.message}`);
  return data ?? [];
}

export async function printEdgeReport(): Promise<void> {
  const { data: rows, error } = await supabase
    .from('edge_log')
    .select(`
      id,
      kalshi_price_at_t0,
      kalshi_price_at_t60s,
      estimated_fair_price,
      simulated_pnl_cents,
      events ( sport, event_type, detected_at )
    `)
    .not('kalshi_price_at_t60s', 'is', null)
    .order('id', { ascending: false })
    .limit(500);

  if (error) throw new Error(error.message);
  if (!rows?.length) {
    console.log('No completed edge_log rows yet.');
    return;
  }

  const byKey: Record<string, {
    total: number; hits: number; drifts: number[]; pnls: number[];
  }> = {};

  for (const row of rows) {
    const ev = (row as any).events;
    const key = `${ev.sport}:${ev.event_type}`;
    if (!byKey[key]) byKey[key] = { total: 0, hits: 0, drifts: [], pnls: [] };

    const t0 = row.kalshi_price_at_t0 as number;
    const t60 = row.kalshi_price_at_t60s as number;
    const fair = row.estimated_fair_price as number | null;
    const drift = t60 - t0;

    byKey[key].total++;
    if (fair != null && Math.sign(drift) === Math.sign(fair - t0)) byKey[key].hits++;
    byKey[key].drifts.push(Math.abs(drift));
    if (row.simulated_pnl_cents != null) byKey[key].pnls.push(Number(row.simulated_pnl_cents));
  }

  console.log('\n=== EDGE REPORT ===\n');
  for (const [key, s] of Object.entries(byKey)) {
    const hitRate = ((s.hits / s.total) * 100).toFixed(1);
    const avgDrift = (s.drifts.reduce((a, b) => a + b, 0) / s.drifts.length).toFixed(1);
    const avgPnl = s.pnls.length
      ? (s.pnls.reduce((a, b) => a + b, 0) / s.pnls.length).toFixed(1)
      : 'n/a';
    console.log(`${key.padEnd(28)} n=${s.total}  hitRate=${hitRate}%  avgDrift=${avgDrift}c  avgPnl=${avgPnl}c`);
  }
  console.log('');
}
