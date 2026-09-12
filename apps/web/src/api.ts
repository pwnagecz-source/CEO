/**
 * Klient API.
 *
 * Všechny cesty jsou RELATIVNÍ (`/api/…`) — prohlížeč mluví jen s Vite dev
 * serverem, který je proxyuje na Fastify. Volat z browseru localhost:8080 by
 * nefungovalo ani v sandboxu (reverse proxy), ani v produkci (jiná doména).
 */

export type Item = {
  id: string
  code: string
  name: string
  category: string
  tier: number
  base_price: number
  retail_base: number | null
  tick_size: number
  min_lot: number
  is_retail_product: boolean
  best_bid: number | null
  best_ask: number | null
  last_price: number | null
}

export type BookLevel = { price: number; qty: number; orders: number; total: number }

export type Book = {
  item: {
    code: string; name: string; tier: number; category: string
    basePrice: number; retailBase: number | null; tickSize: number; minLot: number
  }
  qualityTier: number
  bids: BookLevel[]
  asks: BookLevel[]
  bestBid: number | null
  bestAsk: number | null
  spread: number | null
  mid: number | null
  lastPrice: number | null
  lastAt: string | null
  twap30d: number | null
  volume30d: number
  trades30d: number
}

export type Fill = {
  tradeId: number; price: number; qty: number; gross: number
  feeBuyer: number; feeSeller: number; counterparty: string; executedAt: string
}

export type PlaceOrderResult = {
  orderId: number
  status: string
  qty: number
  qtyFilled: number
  remaining: number
  priceLimit: number | null
  fills: Fill[]
  avgPrice: number | null
  totalGross: number
  totalFees: number
  escrowed: number
  releasedEscrow: number
  stillLocked: number
  reserved: number
  idempotencyKey: string | null
  cached?: boolean
}

export type CompanySummary = { id: string; name: string; industry: string; status: string }

export type Building = {
  id: string; name: string; code: string; level: number; status: string
  plot: string; x: number; y: number; upkeep: number; throughput: number
  output_item: string | null; storage: number
}

export type InvRow = {
  item: string; name: string; tier: number; quality_tier: number
  quantity: number; reserved: number; available: number
  mid_price: number | null; value: number
}

export type Company = {
  id: string; name: string; industry: string; status: string; founded_at: string
  cash: number; escrow: number; ledgerCash: number
  buildings: Building[]; inventory: InvRow[]
  plots: { id: string; x: number; y: number; plot_type: string }[]
  inventoryValue: number
}

export type Macro = {
  m2: number; faucetTotal: number; sinkTotal: number
  moneyCreated: number; moneyDestroyed: number; deltaM: number
  faucets: Record<string, number>; sinks: Record<string, number>
  counts: {
    companies: string; buildings: string; plots_owned: string
    open_orders: string; trades: string; volume: number
  }
}

export type Audit = {
  ok: boolean; verdict: 'PASS' | 'FAIL'
  unbalanced: unknown[]; drift: unknown[]; oversold: unknown[]
  moneyIdentity: unknown[]; escrowMismatch: unknown[]
}

export type Trade = {
  id: string; item: string; quality_tier: number; price: number; qty: number
  gross: number; buyer: string; seller: string; executed_at: string
}

export type MapPlot = {
  id: string; x: number; y: number; type: string; status: string
  owner_id: string | null; owner_name: string | null
  b_id: string | null; b_code: string | null; b_name: string | null
  b_level: number | null; b_status: string | null; b_retail: boolean | null
  b_output: string | null; b_industry: string | null; b_tier: number | null
  richness: number
}

export type MapData = {
  grid: { w: number; h: number }
  plots: MapPlot[]
}

export type OpenOrder = {
  id: string; item: string; side: 'buy' | 'sell'; price_limit: number | null
  qty: number; qty_filled: number; status: string; created_at: string
}

class ApiError extends Error {
  constructor(readonly status: number, readonly body: unknown, message: string) {
    super(message)
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const text = await r.text()
  const body = text ? JSON.parse(text) : null
  if (!r.ok) {
    const msg = (body as { error?: string })?.error ?? `${r.status} ${r.statusText}`
    throw new ApiError(r.status, body, msg)
  }
  return body as T
}

export const api = {
  health: () => req<{ ok: boolean; worldId: number; engine: string; version?: string }>('/health'),
  macro: () => req<Macro>('/macro'),
  audit: () => req<Audit>('/audit'),
  items: () => req<{ items: Item[]; fees: { maker: number; taker: number } }>('/items'),
  companies: () => req<{ companies: CompanySummary[] }>('/companies'),
  map: () => req<MapData>('/map'),
  company: (id: string | number) => req<Company>(`/companies/${id}`),
  book: (code: string, tier = 1) =>
    req<Book>(`/market/${encodeURIComponent(code)}?tier=${tier}`),
  trades: () => req<{ trades: Trade[] }>('/trades'),
  orders: (companyId: string | number) =>
    req<{ orders: OpenOrder[] }>(`/orders?companyId=${companyId}`),
  placeOrder: (body: {
    companyId: number; itemCode: string; side: 'buy' | 'sell'; qty: number
    priceLimit?: number | null; orderType?: 'limit' | 'market'; qualityTier?: number
    idempotencyKey?: string
  }) => req<PlaceOrderResult>('/orders', { method: 'POST', body: JSON.stringify(body) }),
  cancelOrder: (orderId: number, companyId: number) =>
    req<{ orderId: number; cancelled: boolean; releasedQty: number; releasedCash: number }>(
      `/orders/${orderId}?companyId=${companyId}`, { method: 'DELETE' }),
  reset: () => req<{ ok: boolean; worldId: number; audit: string }>('/demo/reset', {
    method: 'POST', body: '{}',
  }),
}

export { ApiError }
