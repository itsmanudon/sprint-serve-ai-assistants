import { randomUUID } from 'node:crypto';
import { getDb, transaction } from '../../db/database';
import { getCurrentTenantId } from '../../config/tenant-context';
import { badRequest, httpError } from '../../utils/http-error';
import { quoteTakeawayOrder, type QuoteLineInput } from '../takeaway/takeaway.service';

/**
 * Demo checkout and kitchen states. Like Sprint Serve's takeaway checkout, it
 * prices the cart again, refuses a total that changed since the guest saw it,
 * and returns the same order for a retried request instead of creating two.
 */

export type OrderStatus = 'NEW' | 'PREPARING' | 'READY' | 'COMPLETED' | 'CANCELLED';
const NEXT: Record<OrderStatus, OrderStatus[]> = {
  NEW: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY'],
  READY: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export interface OrderView {
  id: string;
  number: number;
  name: string;
  status: OrderStatus;
  source: string;
  total: number;
  placedAt: string;
  lines: Array<{ menuItemId: string; name: string; variantName: string | null; quantity: number; lineTotal: number }>;
}

const tenant = () => {
  const id = getCurrentTenantId();
  if (!id) throw badRequest('Choose a restaurant first.');
  return id;
};

function view(orderId: string): OrderView {
  const d = getDb();
  const o = d.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown>;
  const lines = d
    .prepare('SELECT menu_item_id, name, variant_name, quantity, line_total FROM order_items WHERE order_id = ? ORDER BY id')
    .all(orderId) as Array<Record<string, unknown>>;
  return {
    id: String(o.id),
    number: Number(o.number),
    name: String(o.customer_name),
    status: o.status as OrderStatus,
    source: String(o.source),
    total: Number(o.total),
    placedAt: String(o.created_at),
    lines: lines.map((l) => ({
      menuItemId: String(l.menu_item_id),
      name: String(l.name),
      variantName: (l.variant_name as string | null) ?? null,
      quantity: Number(l.quantity),
      lineTotal: Number(l.line_total),
    })),
  };
}

export async function placeOrder(input: {
  name: string;
  items: QuoteLineInput[];
  quotedTotal: number;
  idempotencyKey: string;
  source?: string;
}): Promise<{ order: OrderView; created: boolean }> {
  const restaurantId = tenant();
  const existing = getDb()
    .prepare('SELECT id FROM orders WHERE restaurant_id = ? AND idempotency_key = ?')
    .get(restaurantId, input.idempotencyKey) as { id: string } | undefined;
  if (existing) return { order: view(existing.id), created: false };

  const quote = await quoteTakeawayOrder(input.items);
  if (Math.abs(quote.total - input.quotedTotal) > 0.005)
    throw Object.assign(httpError('The price changed. Please review your order.', 409, 'QUOTE_TOTAL_CHANGED'), {
      total: quote.total,
    });

  const id = randomUUID();
  const now = new Date().toISOString();
  transaction((d) => {
    const { n } = d
      .prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM orders WHERE restaurant_id = ?')
      .get(restaurantId) as { n: number };
    d.prepare(
      `INSERT INTO orders (id, restaurant_id, number, customer_name, status, source, subtotal, tax, total,
        idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, 'NEW', ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, restaurantId, n, input.name, input.source ?? 'assistant', quote.subtotal, quote.tax, quote.total, input.idempotencyKey, now, now);
    const ins = d.prepare(
      'INSERT INTO order_items (order_id, menu_item_id, name, variant_name, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const l of quote.lines) ins.run(id, l.menuItemId, l.name, l.variantName, l.quantity, l.unitPrice, l.lineTotal);
  });
  return { order: view(id), created: true };
}

/** Orders the kitchen still has to deal with, oldest first. */
export async function openOrders(): Promise<OrderView[]> {
  const rows = getDb()
    .prepare(
      `SELECT id FROM orders WHERE restaurant_id = ? AND status IN ('NEW','PREPARING','READY') ORDER BY created_at LIMIT 50`
    )
    .all(tenant()) as Array<{ id: string }>;
  return rows.map((r) => view(r.id));
}

export async function setStatus(orderId: string, next: OrderStatus): Promise<OrderView> {
  const restaurantId = tenant();
  const row = getDb()
    .prepare('SELECT status FROM orders WHERE id = ? AND restaurant_id = ?')
    .get(orderId, restaurantId) as { status: OrderStatus } | undefined;
  if (!row) throw httpError('Order not found.', 404);
  if (!NEXT[row.status].includes(next)) throw httpError(`An order that is ${row.status} cannot become ${next}.`, 409);
  const now = new Date().toISOString();
  // Conditional on the status we read, so two taps cannot both win.
  const changed = getDb()
    .prepare('UPDATE orders SET status = ?, updated_at = ?, completed_at = ? WHERE id = ? AND status = ?')
    .run(next, now, next === 'COMPLETED' ? now : null, orderId, row.status).changes;
  if (!changed) throw httpError('The order changed meanwhile; refresh.', 409);
  return view(orderId);
}
