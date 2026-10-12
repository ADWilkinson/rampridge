/** React Query keys for the sell flow. Invalidate `sellQueryKeys.all` to refresh everything. */
export const sellQueryKeys = {
  all: ["peer", "sell"] as const,
  orders: (owner: string) => ["peer", "sell", "orders", owner.toLowerCase()] as const,
  order: (depositId: string) => ["peer", "sell", "order", depositId] as const,
  buyer: (address: string) => ["peer", "sell", "buyer", address.toLowerCase()] as const,
  usdcBalance: (owner: string) => ["peer", "sell", "usdcBalance", owner.toLowerCase()] as const,
  gasBalance: (owner: string) => ["peer", "sell", "gasBalance", owner.toLowerCase()] as const,
  rate: (currency: string, platform: string | null) =>
    ["peer", "sell", "rate", currency, platform ?? ""] as const,
  fillStats: () => ["peer", "sell", "fillStats"] as const,
};
