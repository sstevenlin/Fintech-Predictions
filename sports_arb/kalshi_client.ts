import { createSign, constants } from 'crypto';
import { readFileSync } from 'fs';

const BASE = process.env.KALSHI_ENV === 'demo'
  ? 'https://demo-api.kalshi.co/trade-api/v2'
  : 'https://api.elections.kalshi.com/trade-api/v2';

// Kalshi switched the public response shape to dollar-denominated strings in late 2025.
// We keep both the new and legacy fields for forward/backward compatibility.
export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  status: string;
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
}

function dollarsToCents(s: string | undefined): number | null {
  if (s == null) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// Returns the YES mid-price in cents (0–100), or null on failure.
export async function getMarketPrice(ticker: string): Promise<number | null> {
  try {
    const res = await fetch(`${BASE}/markets/${encodeURIComponent(ticker)}`);
    if (!res.ok) return null;
    const { market: m } = await res.json() as { market: KalshiMarket };
    if (!m) return null;
    const bid = dollarsToCents(m.yes_bid_dollars) ?? m.yes_bid ?? null;
    const ask = dollarsToCents(m.yes_ask_dollars) ?? m.yes_ask ?? null;
    if (bid != null && ask != null) {
      return Math.round((bid + ask) / 2);
    }
    return dollarsToCents(m.last_price_dollars) ?? m.last_price ?? null;
  } catch {
    return null;
  }
}

// Lists open markets for a Kalshi series ticker (e.g., 'NBAWIN').
export async function listMarkets(seriesTicker: string): Promise<KalshiMarket[]> {
  const params = new URLSearchParams({
    series_ticker: seriesTicker,
    status: 'open',
    limit: '200',
  });
  try {
    const res = await fetch(`${BASE}/markets?${params}`);
    if (!res.ok) return [];
    const data = await res.json() as { markets: KalshiMarket[] };
    return data.markets ?? [];
  } catch {
    return [];
  }
}

function loadPrivateKey(): string {
  const secret = process.env.KALSHI_API_SECRET ?? '';
  if (secret.startsWith('/') || secret.startsWith('./')) {
    return readFileSync(secret, 'utf8');
  }
  return secret.replace(/\\n/g, '\n');
}

function buildAuthHeaders(method: string, path: string, body: string): Record<string, string> {
  const apiKey = process.env.KALSHI_API_KEY;
  if (!apiKey) throw new Error('KALSHI_API_KEY is required for order placement');
  const privateKey = loadPrivateKey();
  if (!privateKey) throw new Error('KALSHI_API_SECRET is required for order placement');

  const timestamp = Date.now().toString();
  const message = timestamp + method.toUpperCase() + path + body;

  const signer = createSign('SHA256');
  signer.update(message);
  const signature = signer.sign(
    { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
    'base64',
  );

  return {
    'KALSHI-ACCESS-KEY': apiKey,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'Content-Type': 'application/json',
  };
}

// Places a limit buy order. limitCents is the max price you'll pay for the given side.
// Returns the Kalshi order ID on success.
export async function placeOrder(
  ticker: string,
  side: 'yes' | 'no',
  count: number,
  limitCents: number,
): Promise<string> {
  // Kalshi always uses yes_price for limit orders (1–99 cents).
  const yes_price = side === 'yes' ? limitCents : 100 - limitCents;
  const path = new URL(`${BASE}/portfolio/orders`).pathname;
  const body = JSON.stringify({ ticker, action: 'buy', side, count, type: 'limit', yes_price });

  const headers = buildAuthHeaders('POST', path, body);
  const res = await fetch(`${BASE}/portfolio/orders`, { method: 'POST', headers, body });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kalshi order failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { order: { order_id: string } };
  return data.order.order_id;
}
