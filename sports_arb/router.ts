import type { FairValueResult, TradeSignal, OpenPosition, KalshiQuote } from './types';
import { placeOrder as kalshiPlaceOrder } from './kalshi_client';
import { buildPosition } from './exit_manager';

const MIN_EDGE_CENTS = Number(process.env.MIN_EDGE_CENTS ?? 5);
const MAX_QUANTITY = Number(process.env.MAX_QUANTITY ?? 10);

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

// Compute the realistic entry fill price under cross-the-spread assumptions.
// buy_yes pays yes_ask. buy_no pays (100 - yes_bid) = "no_ask".
// Fall back to mid +/- a half-cent if the book is missing one side.
export function entryFillPrice(side: 'yes' | 'no', quote: KalshiQuote): number | null {
  if (side === 'yes') {
    if (quote.yesAsk != null) return quote.yesAsk;
    if (quote.yesMid != null) return Math.min(99, quote.yesMid + 1);
    return null;
  }
  // NO side
  if (quote.yesBid != null) return 100 - quote.yesBid;
  if (quote.yesMid != null) return Math.min(99, (100 - quote.yesMid) + 1);
  return null;
}

// Returns the opened position (even in dry-run) so the caller can track exits.
export async function placeOrder(
  signal: TradeSignal,
  dryRun: boolean,
  quote: KalshiQuote,
): Promise<OpenPosition | null> {
  if (signal.action === 'pass') return null;

  const { kalshiTicker, estimatedFairPrice, currentKalshiPrice } = signal.fairValue;
  const side = signal.action === 'buy_yes' ? 'yes' : 'no' as const;

  const fill = entryFillPrice(side, quote);
  if (fill == null) {
    console.log(`[router] no quote for ${kalshiTicker} — passing`);
    return null;
  }

  // Skip the trade entirely if cross-spread cost has already eaten the edge.
  const targetMid = estimatedFairPrice; // fair, in yes-mid terms
  const targetSideExitPrice = side === 'yes' ? targetMid : (100 - targetMid);
  const expectedEdgeCents = targetSideExitPrice - fill;
  if (expectedEdgeCents < MIN_EDGE_CENTS) {
    console.log(
      `[router] ${kalshiTicker} ${side} fill=${fill}c target=${targetSideExitPrice}c — edge after slippage ${expectedEdgeCents}c < ${MIN_EDGE_CENTS}c, passing`,
    );
    return null;
  }

  const limitCents = fill;
  const label = `[router] ${signal.action.toUpperCase()} ${MAX_QUANTITY}x ${kalshiTicker} fill=${fill}c target=${targetSideExitPrice}c (yesMid target=${targetMid}c) | ${signal.reason}`;

  const pos = buildPosition({
    kalshiTicker,
    side,
    quantity: MAX_QUANTITY,
    entryFillPrice: fill,
    entryYesMid: currentKalshiPrice,
    entryQuote: quote,
    targetYesMid: targetMid,
  });

  if (dryRun) {
    console.log(`DRY RUN — ${label}`);
    return pos;
  }

  const orderId = await kalshiPlaceOrder(kalshiTicker, side, MAX_QUANTITY, limitCents);
  console.log(`${label} → orderId=${orderId}`);
  return pos;
}

export { MAX_QUANTITY, MIN_EDGE_CENTS };
