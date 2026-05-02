import type { FairValueResult, TradeSignal, OpenPosition } from './types';
import { placeOrder as kalshiPlaceOrder } from './kalshi_client';
import { buildPosition } from './exit_manager';

const MIN_EDGE_CENTS = Number(process.env.MIN_EDGE_CENTS ?? 5);
const MAX_QUANTITY = 10;

export function evaluate(result: FairValueResult): TradeSignal {
  const gap = result.estimatedFairPrice - result.currentKalshiPrice;

  if (result.confidence === 'low') {
    return { fairValue: result, action: 'pass', reason: 'low-confidence model entry' };
  }
  if (Math.abs(gap) < MIN_EDGE_CENTS) {
    return { fairValue: result, action: 'pass', reason: `edge ${Math.abs(gap)}c < threshold ${MIN_EDGE_CENTS}c` };
  }

  return {
    fairValue: result,
    action: gap > 0 ? 'buy_yes' : 'buy_no',
    reason: `${Math.abs(gap)}c gap | fair=${result.estimatedFairPrice}c market=${result.currentKalshiPrice}c`,
  };
}

// Returns the opened position (even in dry-run) so the caller can track exits.
export async function placeOrder(signal: TradeSignal, dryRun: boolean): Promise<OpenPosition | null> {
  if (signal.action === 'pass') return null;

  const { kalshiTicker, estimatedFairPrice, currentKalshiPrice } = signal.fairValue;
  const side = signal.action === 'buy_yes' ? 'yes' : 'no' as const;
  // limitCents is the max price we'll pay for the given side.
  const limitCents = side === 'yes' ? estimatedFairPrice : 100 - estimatedFairPrice;
  const label = `[router] ${signal.action.toUpperCase()} ${MAX_QUANTITY}x ${kalshiTicker} @~${limitCents}c | ${signal.reason}`;

  const pos = buildPosition(kalshiTicker, side, MAX_QUANTITY, currentKalshiPrice, estimatedFairPrice);

  if (dryRun) {
    console.log(`DRY RUN — ${label}`);
    return pos;
  }

  const orderId = await kalshiPlaceOrder(kalshiTicker, side, MAX_QUANTITY, limitCents);
  console.log(`${label} → orderId=${orderId}`);
  return pos;
}

export { MAX_QUANTITY };
