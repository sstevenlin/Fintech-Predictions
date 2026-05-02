import { createClient } from '@supabase/supabase-js';
import type { GameEvent, FairValueResult } from '../sports_arb/types';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function logEvent(event: GameEvent, kalshiTicker: string | null): Promise<number | null> {
  const { data, error } = await supabase
    .from('events')
    .insert({
      market_id: kalshiTicker,
      game_id: event.gameId,
      sport: event.sport,
      event_type: event.eventType,
      description: event.description,
      source: event.source,
      detected_at: new Date(event.detectedAt).toISOString(),
      payload_json: { prev: event.prevState, next: event.nextState },
    })
    .select('id')
    .single();

  if (error) {
    console.error('[logger] failed to insert event:', error.message);
    return null;
  }
  return data.id;
}

export async function logEdgeSnapshot(
  eventId: number,
  t: 't0' | 't15s' | 't30s' | 't60s' | 't120s',
  price: number,
  fairValue?: FairValueResult,
): Promise<void> {
  const colMap: Record<string, string> = {
    t0:    'kalshi_price_at_t0',
    t15s:  'kalshi_price_at_t15s',
    t30s:  'kalshi_price_at_t30s',
    t60s:  'kalshi_price_at_t60s',
    t120s: 'kalshi_price_at_t120s',
  };

  // Upsert: create row on t0, update on subsequent readings
  if (t === 't0') {
    const { error } = await supabase.from('edge_log').insert({
      event_id: eventId,
      kalshi_price_at_t0: price,
      estimated_fair_price: fairValue?.estimatedFairPrice ?? null,
    });
    if (error) console.error('[logger] edge_log insert error:', error.message);
    return;
  }

  const col = colMap[t];
  const { data: rows } = await supabase
    .from('edge_log')
    .select('id, kalshi_price_at_t0')
    .eq('event_id', eventId)
    .limit(1);

  if (!rows?.length) return;

  const row = rows[0];
  const update: Record<string, unknown> = { [col]: price };

  // Compute simulated P&L once t60s is filled
  if (t === 't60s' && row.kalshi_price_at_t0 != null) {
    update['simulated_pnl_cents'] = (price - row.kalshi_price_at_t0) * 10; // 10 contracts
  }

  const { error } = await supabase
    .from('edge_log')
    .update(update)
    .eq('id', row.id);

  if (error) console.error(`[logger] edge_log update (${t}) error:`, error.message);
}
