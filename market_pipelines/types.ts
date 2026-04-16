export interface Market {
  marketId: string;
  title: string;
  probability: number | null; // YES probability 0-1
  bestBid: number | null;     // Highest buy price
  bestAsk: number | null;     // Lowest sell price
  expiration: string | null;  // ISO-8601
}
