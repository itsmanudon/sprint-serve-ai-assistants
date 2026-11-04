import { getDb } from '../../../db/database';
import type { Range } from './owner.periods';

/**
 * Read-only aggregates for the owner's assistant. Only totals and dish-level
 * counts leave this file: no customer names, phone numbers or order notes.
 * Revenue counts COMPLETED orders only; cancelled orders are reported apart.
 */

const round2 = (n: number) => Math.round((n ?? 0) * 100) / 100;

export interface SalesTotals {
  orders: number;
  revenue: number;
  netSales: number;
  gst: number;
  averageOrderValue: number;
  itemsSold: number;
  cancelledOrders: number;
  assistantOrders: number;
}

export function salesTotals(restaurantId: string, range: Range): SalesTotals {
  const d = getDb();
  const s = d
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(subtotal),0) AS net,
              COALESCE(SUM(tax),0) AS gst, COALESCE(SUM(source = 'assistant'),0) AS assistant
       FROM orders WHERE restaurant_id = ? AND status = 'COMPLETED' AND created_at >= ? AND created_at < ?`
    )
    .get(restaurantId, range.from, range.to) as Record<string, number>;
  const items = d
    .prepare(
      `SELECT COALESCE(SUM(oi.quantity),0) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.restaurant_id = ? AND o.status = 'COMPLETED' AND o.created_at >= ? AND o.created_at < ?`
    )
    .get(restaurantId, range.from, range.to) as { n: number };
  const cancelled = d
    .prepare(`SELECT COUNT(*) AS n FROM orders WHERE restaurant_id = ? AND status = 'CANCELLED' AND created_at >= ? AND created_at < ?`)
    .get(restaurantId, range.from, range.to) as { n: number };
  return {
    orders: s.orders,
    revenue: round2(s.revenue),
    netSales: round2(s.net),
    gst: round2(s.gst),
    averageOrderValue: s.orders ? round2(s.revenue / s.orders) : 0,
    itemsSold: items.n,
    cancelledOrders: cancelled.n,
    assistantOrders: s.assistant,
  };
}

export interface DishSales {
  dish: string;
  category: string;
  quantity: number;
  revenue: number;
  available: boolean;
}

/** Every dish on the menu with its sales in the range (zero when none). */
export function dishSales(restaurantId: string, range: Range): DishSales[] {
  const rows = getDb()
    .prepare(
      `SELECT m.name AS dish, c.name AS category, m.is_available AS available,
              COALESCE(SUM(CASE WHEN o.id IS NOT NULL THEN oi.quantity END),0) AS quantity,
              COALESCE(SUM(CASE WHEN o.id IS NOT NULL THEN oi.line_total END),0) AS revenue
       FROM menu_items m
       JOIN categories c ON c.id = m.category_id
       LEFT JOIN order_items oi ON oi.menu_item_id = m.id
       LEFT JOIN orders o ON o.id = oi.order_id AND o.status = 'COMPLETED' AND o.created_at >= ? AND o.created_at < ?
       WHERE m.restaurant_id = ?
       GROUP BY m.id`
    )
    .all(range.from, range.to, restaurantId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    dish: String(r.dish),
    category: String(r.category),
    quantity: Number(r.quantity),
    revenue: round2(Number(r.revenue)),
    available: Number(r.available) === 1,
  }));
}

export function hourlySales(restaurantId: string, range: Range, offsetMinutes = 330) {
  return (
    getDb()
      .prepare(
        `SELECT CAST(strftime('%H', created_at, ?) AS INTEGER) AS hour, COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue
         FROM orders WHERE restaurant_id = ? AND status = 'COMPLETED' AND created_at >= ? AND created_at < ?
         GROUP BY hour ORDER BY hour`
      )
      .all(`${offsetMinutes >= 0 ? '+' : ''}${offsetMinutes} minutes`, restaurantId, range.from, range.to) as Array<{
      hour: number;
      orders: number;
      revenue: number;
    }>
  ).map((h) => ({ ...h, revenue: round2(h.revenue) }));
}

export interface OpenOrder {
  number: number;
  status: 'NEW' | 'PREPARING' | 'READY';
  minutesSincePlaced: number;
  minutesInStatus: number;
  items: number;
}

export function openOrders(restaurantId: string, now = new Date()): OpenOrder[] {
  const rows = getDb()
    .prepare(
      `SELECT o.number, o.status, o.updated_at, o.created_at, COALESCE(SUM(oi.quantity),0) AS items
       FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.restaurant_id = ? AND o.status IN ('NEW','PREPARING','READY')
       GROUP BY o.id ORDER BY o.created_at`
    )
    .all(restaurantId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    number: Number(r.number),
    status: r.status as OpenOrder['status'],
    minutesSincePlaced: Math.max(0, Math.round((now.getTime() - Date.parse(String(r.created_at))) / 60_000)),
    minutesInStatus: Math.max(0, Math.round((now.getTime() - Date.parse(String(r.updated_at))) / 60_000)),
    items: Number(r.items),
  }));
}
